import { randomInt, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { questions } from '../../content/questions'
import { companyProfiles, difficultyLabels, modeLabels, roleProfiles, topicLabels } from '../../content/profiles'
import type { Dimension, InterviewReport, InterviewSession, Question, SessionConfig, SessionSummary, Topic, Turn } from '../../shared/types'
import { AppError, requireValue } from './errors'
import { JsonStore, type Database } from './store'
import { createSessionSchema, settingsSchema, turnSchema, type TurnInput } from './validation'
import { publicSettings, requestJson, resolveSettings, testProvider, type ProviderFetch } from './provider'
import { evaluatorPrompt, interviewerPrompt } from './prompts'
import { appendDynamicFollowup, assessAnswer, generateQuestions } from './ai-interview'

export const followupLimits = { easy: 1, medium: 2, hard: 4 } as const
const dimensionSchema = z.object({
  correctness: z.number().int().min(0).max(4).nullable(),
  reasoning: z.number().int().min(0).max(4).nullable(),
  application: z.number().int().min(0).max(4).nullable(),
  validation: z.number().int().min(0).max(4).nullable(),
  communication: z.number().int().min(0).max(4).nullable(),
}).strict()
const evaluationSchema = z.object({
  questionId: z.string(),
  independent: dimensionSchema,
  assisted: dimensionSchema.nullable(),
  evidence: z.array(z.object({ turnId: z.string(), quote: z.string(), pointId: z.string(), observation: z.string() }).strict()),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
}).strict()
const reportSchema = z.object({
  summary: z.string(),
  evaluations: z.array(evaluationSchema).length(1),
  improvements: z.array(z.object({ title: z.string(), exercise: z.string(), acceptance: z.string() }).strict()).max(3),
}).strict()
const decisionSchema = z.object({ action: z.enum(['followup', 'advance']), followupId: z.string().nullable() }).strict()
const closingText = '本场练习已结束。现在可以生成复盘，查看覆盖范围、作答记录和后续练习。'

export function publicQuestion(question: Question) {
  return {
    id: question.id, familyId: question.familyId, version: question.version, title: question.title, topic: question.topic,
    tags: question.tags, roles: question.roles, origin: question.origin, review: question.review,
    variants: {
      easy: { stem: question.variants.easy.stem }, medium: { stem: question.variants.medium.stem }, hard: { stem: question.variants.hard.stem },
    },
  }
}

function addTurn(session: InterviewSession, role: Turn['role'], kind: Turn['kind'], text: string, questionId: string | null = null, assisted = false) {
  const turn: Turn = { id: randomUUID(), role, kind, text, questionId, assisted, timestamp: new Date().toISOString() }
  session.turns.push(turn)
  return turn
}

function sessionCards(db: Database, sessionId: string): Question[] {
  const cards = db.questionSnapshots?.[sessionId]
  if (!cards) throw new AppError(409, '本场旧记录缺少题目快照，请创建一场新练习。')
  return cards
}

function currentCard(session: InterviewSession, cards: Question[]) {
  return requireValue(cards.find((question) => question.id === session.questionIds[session.currentQuestionIndex]), '当前题目不存在。')
}

function finish(session: InterviewSession, reason?: string) {
  session.status = 'completed'
  addTurn(session, 'interviewer', 'closing', reason ? `${reason}\n${closingText}` : closingText)
}

function advance(session: InterviewSession, cards: Question[]) {
  if (session.currentQuestionIndex + 1 >= session.questionIds.length) return finish(session)
  session.currentQuestionIndex += 1
  session.followupsUsed = 0
  session.hintsUsed = 0
  session.assistanceStarted = false
  const card = currentCard(session, cards)
  addTurn(session, 'interviewer', 'question', card.variants[session.config.difficulty].stem, card.id)
}

function activeMilliseconds(session: InterviewSession) {
  let pausedAt: number | null = null
  let pausedTotal = 0
  for (const turn of session.turns) {
    if (turn.kind !== 'control') continue
    if (turn.text === '练习已暂停。' && pausedAt === null) pausedAt = Date.parse(turn.timestamp)
    if (turn.text === '练习已恢复。' && pausedAt !== null) {
      pausedTotal += Date.parse(turn.timestamp) - pausedAt
      pausedAt = null
    }
  }
  if (pausedAt !== null) pausedTotal += Date.now() - pausedAt
  return Date.now() - Date.parse(session.createdAt) - pausedTotal
}

function selectQuestions(config: SessionConfig, explicitIds?: string[]) {
  const role = requireValue(roleProfiles.find((entry) => entry.id === config.roleId), '岗位配置不存在。')
  const company = requireValue(companyProfiles.find((entry) => entry.id === config.companyId), '公司场景不存在。')
  const topics = config.topics.length ? config.topics : role.topics
  const eligible = questions.filter((card) => card.review === 'assistant_checked' && card.roles.includes(role.id) && topics.includes(card.topic))
  if (explicitIds) {
    const selected = explicitIds.map((id) => requireValue(eligible.find((card) => card.id === id), '复测题目不属于当前岗位或主题范围。'))
    if (new Set(selected.map((card) => card.familyId)).size !== selected.length) throw new AppError(400, '同一场练习不能重复选择同一家族的题目。')
    return { selected: selected.slice(0, config.maxQuestions), topics, eligible }
  }
  // Topic round robin makes short sessions cover several families; company emphasis affects order.
  const buckets = topics.map((topic) => ({ topic, cards: eligible.filter((card) => card.topic === topic) }))
    .filter((bucket) => bucket.cards.length)
    .sort((a, b) => Number(company.emphasis.includes(b.topic)) - Number(company.emphasis.includes(a.topic)))
  for (const bucket of buckets) {
    for (let i = bucket.cards.length - 1; i > 0; i -= 1) {
      const index = randomInt(i + 1)
      ;[bucket.cards[i], bucket.cards[index]] = [bucket.cards[index]!, bucket.cards[i]!]
    }
  }
  const selected: Question[] = []
  const families = new Set<string>()
  for (let pass = 0; selected.length < config.maxQuestions; pass += 1) {
    let added = false
    for (const bucket of buckets) {
      const card = bucket.cards[pass]
      if (card && !families.has(card.familyId) && selected.length < config.maxQuestions) {
        selected.push(card)
        families.add(card.familyId)
        added = true
      }
    }
    if (!added && buckets.every((bucket) => pass >= bucket.cards.length - 1)) break
  }
  return { selected, topics, eligible }
}

function coverageNotice(config: SessionConfig, selected: Question[], topics: Topic[]) {
  const covered = new Set(selected.map((question) => question.topic))
  const missing = topics.filter((topic) => !covered.has(topic))
  const notices: string[] = []
  if (selected.length < config.maxQuestions) notices.push(`当前范围只有 ${selected.length} 道可用题，本场已相应缩短。`)
  if (missing.length) notices.push(`本场未覆盖：${missing.map((topic) => topicLabels[topic]).join('、')}。`)
  if (config.companyId === 'custom') notices.push('自定义公司与 JD 仅作为用户提供的背景，未核实为真实招聘信息；本场使用通用题库。')
  return notices.join(' ') || null
}

function reportLimitation(session: InterviewSession) {
  const notes = [session.config.engine === 'local'
    ? '本地模式按题卡进行脚本练习，不做语义理解或能力评分；提示和追问不表示回答正确或错误。'
    : 'AI 评分基于本次文字回答与题卡，可能有误；代码未经执行、项目经历未经外部核实，不代表实际录取结果。']
  if (session.questionStrategy === 'knowledge-generated') notes.push('本场问题、追问及参考标准由 AI 基于知识卡创作，来源锚点可核对，生成内容未经人工逐题审核。')
  if (session.turns.some((turn) => turn.kind === 'control' && turn.text.startsWith('模式已切换'))) notes.push('本场中途切换过模式；请结合逐轮辅助标记阅读，结果不可与纯模拟直接比较。')
  if (session.coverageNotice) notes.push(session.coverageNotice)
  return notes.join(' ')
}

function retestIds(session: InterviewSession, cards: Question[], priorityTopics?: Topic[]) {
  const answeredIds = [...new Set(session.turns.filter((turn) => turn.kind === 'answer' && turn.questionId).map((turn) => turn.questionId!))]
  const targetTopics = priorityTopics?.length ? priorityTopics : [...new Set(answeredIds.map((id) => cards.find((card) => card.id === id)!.topic))]
  const alternatives = questions.filter((card) => card.review === 'assistant_checked' && card.roles.includes(session.config.roleId) && targetTopics.includes(card.topic) && !session.questionIds.includes(card.id))
  // An AI retest creates fresh questions from the same knowledge anchors.
  if (session.questionStrategy === 'knowledge-generated') return answeredIds.slice(0, 5)
  return (alternatives.length ? alternatives.map((card) => card.id) : answeredIds).slice(0, 5)
}

function hasScores(scores: Record<Dimension, number | null> | null) {
  return scores !== null && Object.values(scores).some((score) => score !== null)
}

export function validateEvaluationEvidence(session: InterviewSession, evaluations: InterviewReport['evaluations'], cards: Question[] = questions) {
  const answeredIds = new Set(session.turns.filter((turn) => turn.kind === 'answer').map((turn) => turn.questionId))
  if (new Set(evaluations.map((entry) => entry.questionId)).size !== evaluations.length || evaluations.length !== answeredIds.size) throw new AppError(502, '评分题目范围校验失败，请重新生成报告。')
  for (const evaluation of evaluations) {
    const card = cards.find((entry) => entry.id === evaluation.questionId)
    if (!card || !answeredIds.has(card.id)) throw new AppError(502, '评分题目引用无效，请重新生成报告。')
    for (const evidence of evaluation.evidence) {
      const turn = session.turns.find((entry) => entry.id === evidence.turnId)
      if (!turn || turn.kind !== 'answer' || turn.role !== 'candidate' || turn.questionId !== card.id || !evidence.quote.trim() || !turn.text.includes(evidence.quote) || !card.points.some((point) => point.id === evidence.pointId)) {
        throw new AppError(502, '评分引用未通过原话与要点校验，请重新生成报告。')
      }
    }
    const answers = session.turns.filter((turn) => turn.kind === 'answer' && turn.questionId === card.id)
    if (!answers.some((turn) => turn.assisted) && evaluation.assisted !== null) throw new AppError(502, '辅助评分与作答记录不符，请重新生成报告。')
    for (const assisted of [false, true]) {
      const scores = assisted ? evaluation.assisted : evaluation.independent
      if (hasScores(scores) && !evaluation.evidence.some((entry) => session.turns.find((turn) => turn.id === entry.turnId)?.assisted === assisted)) throw new AppError(502, '评分缺少对应的独立或辅助作答证据，请重新生成报告。')
    }
  }
}

export class InterviewService {
  constructor(readonly storage: JsonStore, private fetcher?: ProviderFetch) {}

  async catalog() {
    return this.storage.read((db) => ({ questions: questions.map(publicQuestion), roleProfiles, companyProfiles, topicLabels, difficultyLabels, modeLabels, provider: publicSettings(resolveSettings(db)) }))
  }

  question(id: string) { return requireValue(questions.find((card) => card.id === id), '题目不存在。') }

  async sessions(): Promise<SessionSummary[]> {
    return this.storage.read((db) => Object.values(db.sessions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((session) => ({
      id: session.id, createdAt: session.createdAt, updatedAt: session.updatedAt, status: session.status, config: session.config,
      answeredCount: new Set(session.turns.filter((turn) => turn.kind === 'answer').map((turn) => turn.questionId)).size,
      questionCount: session.questionIds.length, hasReport: Boolean(db.reports[session.id]),
    })))
  }

  async getSession(id: string): Promise<InterviewSession> {
    return this.storage.read((db) => {
      const { answerJudgments: _hidden, ...session } = requireValue(db.sessions[id])
      if (session.status === 'completed' && db.answerJudgments?.[id]) return { ...session, answerJudgments: db.answerJudgments[id] }
      return session
    })
  }

  async create(input: unknown) {
    const { questionIds, ...config } = createSessionSchema.parse(input)
    return this.storage.transaction(async (db) => {
      let { selected, topics } = selectQuestions(config, questionIds)
      if (!selected.length) throw new AppError(400, '当前岗位与主题范围没有可用题，请调整主题后重试。')
      if (config.engine === 'ai') selected = await generateQuestions(resolveSettings(db), config, selected, companyProfiles.find((entry) => entry.id === config.companyId), this.fetcher)
      const timestamp = new Date().toISOString()
      const session: InterviewSession = {
        id: randomUUID(), version: 1, createdAt: timestamp, updatedAt: timestamp, status: 'active', config,
        questionIds: selected.map((card) => card.id), currentQuestionIndex: 0, followupsUsed: 0, hintsUsed: 0, assistanceStarted: false,
        turns: [], coverageNotice: coverageNotice(config, selected, topics),
        questionStrategy: config.engine === 'ai' ? 'knowledge-generated' : 'fixed-cards',
      }
      const company = companyProfiles.find((entry) => entry.id === config.companyId)!
      const role = roleProfiles.find((entry) => entry.id === config.roleId)!
      const background = company.kind === 'fictional' ? `${company.name}为虚构业务场景。` : config.companyId === 'custom' ? '目标公司与 JD 为用户提供的背景，使用通用题库。' : '本场为通用岗位面试。'
      const resumeNotice = config.resumeText.trim() ? `已载入简历${config.resumeFileName ? `「${config.resumeFileName}」` : '文字'}。${config.engine === 'ai' ? '将根据你明确自述的经历与职责进行追问。' : '本地脚本练习不按简历进行语义个性化。'}` : ''
      addTurn(session, 'interviewer', 'opening', `${background} 本次练习${role.title}，${difficultyLabels[config.difficulty]}难度，${modeLabels[config.mode]}，约 ${config.durationMinutes} 分钟、${selected.length} 道题。${config.engine === 'local' ? '当前为本地脚本练习，不进行语义评分。' : 'AI 已根据知识点创作本场问题，并将根据实际回答动态追问和判断；辅导模式即时反馈，正式模拟结束后统一复盘。'}${resumeNotice}${session.coverageNotice ? `\n${session.coverageNotice}` : ''}`)
      addTurn(session, 'interviewer', 'question', selected[0]!.variants[config.difficulty].stem, selected[0]!.id)
      db.sessions[session.id] = session
      db.questionSnapshots ||= {}
      db.questionSnapshots[session.id] = structuredClone(selected)
      return session
    })
  }

  async turn(id: string, input: unknown) {
    const request = turnSchema.parse(input)
    return this.storage.transaction(async (db) => {
      const session = requireValue(db.sessions[id])
      if (request.version !== session.version) throw new AppError(409, '会话已更新，请刷新后继续；本次内容未重复提交。')
      if (session.status === 'completed') throw new AppError(409, '本场练习已结束。')
      if (session.status === 'paused' && !['resume', 'end'].includes(request.action)) throw new AppError(409, '请先恢复练习。')
      await this.applyTurn(db, session, request)
      session.version += 1
      session.updatedAt = new Date().toISOString()
      return session
    })
  }

  private async applyTurn(db: Database, session: InterviewSession, request: TurnInput) {
    const cards = sessionCards(db, session.id)
    const card = currentCard(session, cards)
    if (request.action === 'pause') {
      session.status = 'paused'
      addTurn(session, 'interviewer', 'control', '练习已暂停。')
      return
    }
    if (request.action === 'resume') {
      if (session.status !== 'paused') throw new AppError(409, '当前练习没有暂停。')
      session.status = 'active'
      addTurn(session, 'interviewer', 'control', '练习已恢复。')
      return
    }
    if (request.action === 'end') return finish(session)
    if (request.action === 'switch-mode') {
      if (!request.mode) throw new AppError(400, '请选择目标模式。')
      if (request.mode === session.config.mode) throw new AppError(400, '已经处于该模式。')
      session.config.mode = request.mode
      addTurn(session, 'interviewer', 'control', `模式已切换为${modeLabels[request.mode]}。本题追问与提示次数保留；已使用的辅助标记继续生效。`)
      return
    }
    if ((request.action === 'hint' || request.action === 'skip') && activeMilliseconds(session) >= session.config.durationMinutes * 60000) return finish(session, '已达到设置时长。')
    if (request.action === 'hint') {
      if (session.config.mode === 'simulation') throw new AppError(400, '正式模拟不提供内容提示；可切换辅导模式或跳过本题。')
      if (session.hintsUsed >= Math.min(card.hints.length, 2)) throw new AppError(400, '本题提示已用完，可以继续作答或跳过。')
      const hint = card.hints[session.hintsUsed]!
      session.hintsUsed += 1
      session.assistanceStarted = true
      addTurn(session, 'interviewer', 'hint', hint, card.id, true)
      return
    }
    if (request.action === 'skip') {
      addTurn(session, 'interviewer', 'control', '本题已跳过；没有作答的部分不进行能力评分。', card.id)
      return advance(session, cards)
    }
    const answer = request.text?.trim()
    if (!answer) throw new AppError(400, '请先输入回答。')
    const answerTurn = addTurn(session, 'candidate', 'answer', answer, card.id, session.assistanceStarted)
    const timeExpired = activeMilliseconds(session) >= session.config.durationMinutes * 60000
    const noAnswer = /^(?:我(?:确实|真的|暂时|现在)?(?:不太会|不会|不知道)|不会|不知道|跳过|换[一一道个]?题|skip\b|i don['’]?t know\b)/i.test(answer)
    if (session.config.engine === 'ai' && session.questionStrategy === 'knowledge-generated') {
      const remaining = timeExpired || noAnswer ? 0 : Math.max(0, followupLimits[session.config.difficulty] - session.followupsUsed)
      const decision = await assessAnswer(resolveSettings(db), session, card, answerTurn, remaining, this.fetcher)
      if (decision.followup) appendDynamicFollowup(card, decision.followup, session.config.difficulty)
      db.answerJudgments ||= {}
      db.answerJudgments[session.id] ||= []
      db.answerJudgments[session.id]!.push(decision.judgment)
      if (session.config.mode === 'coaching') {
        const labels = { correct: '回答正确', partial: '部分正确', incorrect: '回答有误', insufficient: '信息不足' }
        const feedback = addTurn(session, 'interviewer', 'feedback', `${labels[decision.judgment.verdict]}：${decision.judgment.explanation}`, card.id, true)
        feedback.feedback = decision.judgment
        session.assistanceStarted = true
      }
      if (timeExpired) return finish(session, '已达到设置时长，已保留你的最后一次回答及判断。')
      if (!decision.followup) return advance(session, cards)
      session.followupsUsed += 1
      addTurn(session, 'interviewer', 'followup', decision.followup.prompt, card.id, session.assistanceStarted)
      return
    }
    if (timeExpired) return finish(session, '已达到设置时长，已保留你的最后一次回答。')
    const maxFollowups = Math.min(followupLimits[session.config.difficulty], card.followups.length)
    if (noAnswer || session.followupsUsed >= maxFollowups) return advance(session, cards)
    let followup = card.followups[session.followupsUsed]
    if (session.config.engine === 'ai') {
      const asked = session.turns.filter((turn) => turn.kind === 'followup' && turn.questionId === card.id).map((turn) => turn.text)
      const availableFollowups = card.followups.filter((entry) => !asked.includes(entry.prompt))
      const decision = await requestJson(resolveSettings(db), 'interview_decision', decisionSchema, interviewerPrompt,
        { config: session.config, card, transcript: session.turns, availableFollowups, remainingFollowups: maxFollowups - session.followupsUsed }, this.fetcher)
      if (decision.action === 'advance') {
        if (decision.followupId !== null) throw new AppError(502, 'AI 返回的换题指令未通过校验，请重试。')
        return advance(session, cards)
      }
      followup = availableFollowups.find((entry) => entry.id === decision.followupId)
      if (!followup) throw new AppError(502, 'AI 追问引用未通过题库校验，请重试。')
    }
    if (!followup) return advance(session, cards)
    session.followupsUsed += 1
    addTurn(session, 'interviewer', 'followup', followup.prompt, card.id, session.assistanceStarted)
  }

  async deleteSession(id: string) {
    return this.storage.transaction((db) => {
      requireValue(db.sessions[id])
      delete db.sessions[id]
      delete db.reports[id]
      if (db.questionSnapshots) delete db.questionSnapshots[id]
      if (db.answerJudgments) delete db.answerJudgments[id]
      return { deleted: true }
    })
  }

  async getReport(id: string) { return this.storage.read((db) => requireValue(db.reports[id], '尚未生成复盘报告。')) }

  async completedQuestions(id: string): Promise<Question[]> {
    return this.storage.read((db) => {
      const session = requireValue(db.sessions[id])
      if (session.status !== 'completed') throw new AppError(409, '面试进行中无法查看完整题卡。')
      return sessionCards(db, id)
    })
  }

  async generateReport(id: string): Promise<InterviewReport> {
    return this.storage.transaction(async (db) => {
      const session = requireValue(db.sessions[id])
      if (session.status !== 'completed') throw new AppError(409, '请先结束练习，再生成复盘。')
      if (db.reports[id]) return db.reports[id]
      const answeredIds = [...new Set(session.turns.filter((turn) => turn.kind === 'answer').map((turn) => turn.questionId!))]
      const cards = sessionCards(db, id)
      const answeredCards = answeredIds.map((questionId) => requireValue(cards.find((card) => card.id === questionId), '本场题目快照缺失。'))
      let report: InterviewReport
      if (session.config.engine === 'local' || !answeredIds.length) {
        const hints = session.turns.filter((turn) => turn.kind === 'hint' || turn.kind === 'teaching').length
        const answeredTopics = [...new Set(answeredCards.map((card) => topicLabels[card.topic]))]
        report = {
          sessionId: id, createdAt: new Date().toISOString(), engine: session.config.engine,
          summary: `本场安排 ${session.questionIds.length} 道题，实际作答 ${answeredIds.length} 道，使用 ${hints} 次提示。${answeredTopics.length ? `已作答主题：${answeredTopics.join('、')}。` : '尚无可评价的作答记录。'}${session.config.engine === 'local' ? '本地模式不生成能力分数，请结合原始回答和题卡参考自行复盘。' : ''}`,
          evaluations: [],
          improvements: answeredCards.slice(0, 3).map((card) => ({
            title: `${card.title} · 对照复盘`,
            exercise: '对照本题原始回答，补充遗漏的条件、决策依据与验证方法，再用自己的话重答一次。此项为统一练习建议，并非已判定的薄弱点。',
            acceptance: `参考检查点：${card.points.map((point) => point.text).join('；')}。参考资料：${card.sources.map((source) => `${source.title} ${source.url}`).join('；')}`,
          })),
          retestQuestionIds: retestIds(session, cards), limitation: reportLimitation(session),
        }
      } else {
        const transcript = session.turns.filter((turn) => ['question', 'followup', 'answer', 'hint', 'teaching', 'clarification'].includes(turn.kind))
        const evaluationCards = answeredCards.map((card) => ({
          id: card.id, title: card.title, topic: card.topic,
          variants: { [session.config.difficulty]: card.variants[session.config.difficulty] },
          points: card.points,
          followups: card.followups.filter((followup) => transcript.some((turn) => turn.questionId === card.id && turn.kind === 'followup' && turn.text === followup.prompt)),
          referenceAnswer: card.referenceAnswer,
        }))
        const parts = []
        for (const card of evaluationCards) {
          const turns = transcript.filter((turn) => turn.questionId === card.id)
          const turnIds = new Map(turns.map((turn, index) => [`t${index + 1}`, turn.id]))
          const compactTranscript = turns.map((turn, index) => ({ id: `t${index + 1}`, role: turn.role, kind: turn.kind, text: turn.text, questionId: turn.questionId, assisted: turn.assisted }))
          const part = await requestJson(resolveSettings(db), 'interview_evaluation', reportSchema, evaluatorPrompt,
            { config: { roleId: session.config.roleId, difficulty: session.config.difficulty, mode: session.config.mode }, cards: [card], transcript: compactTranscript }, this.fetcher)
          for (const evaluation of part.evaluations) {
            for (const evidence of evaluation.evidence) evidence.turnId = turnIds.get(evidence.turnId) || ''
          }
          validateEvaluationEvidence({ ...session, turns: session.turns.filter((turn) => turn.questionId === card.id) }, part.evaluations, [answeredCards.find((entry) => entry.id === card.id)!])
          parts.push(part)
        }
        const result = {
          summary: parts.map((part, index) => `${answeredCards[index]!.title}：${part.summary}`).join('\n'),
          evaluations: parts.flatMap((part) => part.evaluations),
          improvements: parts.flatMap((part) => part.improvements).slice(0, 3),
        }
        validateEvaluationEvidence(session, result.evaluations, cards)
        if (result.improvements.length > 3) throw new AppError(502, '改进建议数量校验失败，请重新生成报告。')
        const priorityTopics = result.evaluations.filter((entry) => entry.gaps.length).map((entry) => requireValue(cards.find((card) => card.id === entry.questionId)).topic)
        report = { ...result, sessionId: id, createdAt: new Date().toISOString(), engine: 'ai', retestQuestionIds: retestIds(session, cards, priorityTopics), limitation: reportLimitation(session) }
      }
      if (session.questionStrategy === 'knowledge-generated') report.answerJudgments = db.answerJudgments?.[id] || []
      const retests = report.retestQuestionIds
      if (session.questionStrategy !== 'knowledge-generated' && retests.length && retests.every((questionId) => session.questionIds.includes(questionId))) report.limitation += ' 当前范围暂无额外变式，复测沿用原题，应注意记忆答案的影响。'
      db.reports[id] = report
      return report
    })
  }

  async settings() { return this.storage.read((db) => publicSettings(resolveSettings(db))) }

  async saveSettings(input: unknown) {
    const value = settingsSchema.parse(input)
    return this.storage.transaction((db) => {
      const previous = resolveSettings(db)
      db.settings = { protocol: value.protocol, baseUrl: value.baseUrl.replace(/\/+$/, ''), model: value.model, apiKey: value.clearApiKey ? '' : value.apiKey?.trim() || previous.apiKey }
      return publicSettings(db.settings)
    })
  }

  async testSettings() {
    const settings = await this.storage.read(resolveSettings)
    return testProvider(settings, this.fetcher)
  }
}
