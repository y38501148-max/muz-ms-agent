import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AnswerJudgment, InterviewSession, ProviderSettings, Question, SessionConfig, Turn } from '../../shared/types'
import { AppError } from './errors'
import { requestJson, type ProviderFetch } from './provider'
import { authoringPrompt, dynamicInterviewerPrompt } from './prompts'
import { experiencePatterns } from '../../content/interview-patterns'
import { evidenceExcerpts } from './evidence'

const rubricSchema = z.object({ pointId: z.string(), criterion: z.string().min(4).max(1500) }).strict()
const authoredQuestionSchema = z.object({
  knowledgeCardId: z.string(), title: z.string().min(2).max(150), stem: z.string().min(10).max(3000),
  expectedPointIds: z.array(z.string()).min(1).max(8), rubric: z.array(rubricSchema).min(1).max(8),
  referenceAnswer: z.string().min(10).max(7000), hints: z.array(z.string().min(2).max(1000)).min(1).max(2),
  pitfalls: z.array(z.string().max(1000)).max(5), sourceIds: z.array(z.string()).max(12),
}).strict()
const generationSchema = z.object({ questions: z.array(authoredQuestionSchema).min(1).max(12) }).strict()
const followupSchema = z.object({
  prompt: z.string().min(8).max(2000), targetPointIds: z.array(z.string()).min(1).max(8),
  rubric: z.array(rubricSchema).min(1).max(8), referenceAnswer: z.string().min(8).max(5000), sourceIds: z.array(z.string()).max(12),
}).strict()
const judgmentEvidenceSchema = z.object({ quoteId: z.string(), pointId: z.string(), observation: z.string().min(2).max(1500) }).strict()
const judgmentSchema = z.object({
  verdict: z.enum(['correct', 'partial', 'incorrect', 'insufficient']), explanation: z.string().min(5).max(3000),
  evidence: z.array(judgmentEvidenceSchema).min(1).max(8),
}).strict()
const dynamicDecisionSchema = z.object({
  judgment: judgmentSchema, action: z.enum(['followup', 'advance']), followup: followupSchema.nullable(),
}).strict()

const normalized = (value: string) => value.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
const unique = (values: string[]) => new Set(values).size === values.length
const sameIds = (a: string[], b: string[]) => unique(a) && unique(b) && a.length === b.length && a.every((id) => b.includes(id))

// A model may express several criteria for one anchor. Keep every criterion while
// giving the rest of the engine one rubric entry per knowledge point.
function mergeRubric(rubric: z.infer<typeof rubricSchema>[]) {
  const merged = new Map<string, string[]>()
  for (const { pointId, criterion } of rubric) {
    const criteria = merged.get(pointId) || []
    if (!criteria.includes(criterion)) criteria.push(criterion)
    merged.set(pointId, criteria)
  }
  return [...merged].map(([pointId, criteria]) => ({ pointId, criterion: criteria.join('；') }))
}

export function selectExperienceGuidance(config: SessionConfig, cards: Question[]) {
  const topics = new Set(cards.map((card) => card.topic))
  return experiencePatterns.filter((pattern) => pattern.roles.includes(config.roleId) && pattern.topics.some((topic) => topics.has(topic))).slice(0, 3)
}

export function knowledgeSources(card: Question) {
  return card.sources.map((source, index) => ({ id: `${card.id}:source:${index + 1}`, ...source }))
}

export async function generateQuestions(settings: ProviderSettings, config: SessionConfig, knowledgeCards: Question[], company: unknown, fetcher?: ProviderFetch): Promise<Question[]> {
  const experienceGuidance = selectExperienceGuidance(config, knowledgeCards)
  const output = await requestJson(settings, 'interview_generation', generationSchema, authoringPrompt,
    { config, company, experienceGuidance, knowledgeCards: knowledgeCards.map((card) => ({ ...card, sources: knowledgeSources(card) })), questionCount: knowledgeCards.length }, fetcher)
  if (output.questions.length !== knowledgeCards.length || !sameIds(output.questions.map((item) => item.knowledgeCardId), knowledgeCards.map((item) => item.id))) throw new AppError(502, '原创题目的知识卡范围不符，未创建会话，请重试。')
  return output.questions.map((authored) => {
    authored.rubric = mergeRubric(authored.rubric)
    const knowledge = knowledgeCards.find((card) => card.id === authored.knowledgeCardId)!
    const pointIds = knowledge.points.map((point) => point.id)
    const sourceMap = knowledgeSources(knowledge)
    if (!unique(authored.expectedPointIds) || authored.expectedPointIds.some((id) => !pointIds.includes(id)) || !sameIds(authored.rubric.map((point) => point.pointId), authored.expectedPointIds)) throw new AppError(502, '原创题目的评分要点未通过知识锚点校验，未创建会话。')
    if (!unique(authored.sourceIds) || authored.sourceIds.some((id) => !sourceMap.some((source) => source.id === id)) || (sourceMap.length && !authored.sourceIds.length)) throw new AppError(502, '原创题目的资料引用未通过校验，未创建会话。')
    if (Object.values(knowledge.variants).some((variant) => normalized(variant.stem) === normalized(authored.stem))) throw new AppError(502, '模型重复了固定题干，未生成新的本场问题，请重试。')
    const card = structuredClone(knowledge)
    card.title = authored.title
    card.variants[config.difficulty] = { stem: authored.stem, expectedPointIds: authored.expectedPointIds }
    card.points = authored.rubric.map((point) => ({ id: point.pointId, text: point.criterion }))
    card.followups = []
    card.hints = authored.hints
    card.pitfalls = authored.pitfalls
    card.referenceAnswer = authored.referenceAnswer
    card.sources = sourceMap.filter((source) => authored.sourceIds.includes(source.id)).map(({ id: _id, ...source }) => source)
    card.origin = 'generated'
    card.review = 'draft'
    card.generation = {
      kind: 'ai-authored', knowledgeCardId: knowledge.id, knowledgeCardVersion: knowledge.version,
      knowledgePoints: structuredClone(knowledge.points), sourceIds: authored.sourceIds, experiencePatternIds: experienceGuidance.map((pattern) => pattern.id), generatedAt: new Date().toISOString(),
    }
    return card
  })
}

export async function assessAnswer(settings: ProviderSettings, session: InterviewSession, card: Question, answer: Turn, remainingFollowups: number, fetcher?: ProviderFetch) {
  const excerpts = evidenceExcerpts(answer.text)
  const schema = dynamicDecisionSchema.extend({ judgment: judgmentSchema.extend({ evidence: z.array(judgmentEvidenceSchema.extend({
    quoteId: z.enum(excerpts.map((excerpt) => excerpt.id)), pointId: z.enum(card.points.map((point) => point.id)),
  })).min(1).max(8) }) })
  const decision = await requestJson(settings, 'interview_answer', schema, dynamicInterviewerPrompt,
    {
      config: session.config,
      card: {
        id: card.id, title: card.title, points: card.points,
        variants: { [session.config.difficulty]: card.variants[session.config.difficulty] },
        followups: card.followups, referenceAnswer: card.referenceAnswer,
        generation: card.generation && { knowledgePoints: card.generation.knowledgePoints, sourceIds: card.generation.sourceIds },
      },
      experienceGuidance: selectExperienceGuidance(session.config, [card]),
      transcript: session.turns.filter((turn) => turn.questionId === card.id && ['question', 'followup', 'answer', 'hint', 'teaching', 'clarification'].includes(turn.kind)),
      currentAnswerTurnId: answer.id, currentAnswer: { text: answer.text, assisted: answer.assisted, excerpts }, remainingFollowups,
    }, fetcher)
  if (decision.action === 'advance' && decision.followup !== null) throw new AppError(502, 'AI 换题指令与追问内容不一致，本次回答未保存。')
  if (decision.action === 'followup' && !decision.followup) throw new AppError(502, 'AI 未提供动态追问，本次回答未保存。')
  const judgment: AnswerJudgment = {
    answerTurnId: answer.id, questionId: card.id, verdict: decision.judgment.verdict,
    explanation: decision.judgment.explanation,
    evidence: decision.judgment.evidence.map(({ quoteId, ...evidence }) => ({ ...evidence, quote: excerpts.find((excerpt) => excerpt.id === quoteId)!.text, turnId: answer.id })),
    assisted: answer.assisted, createdAt: new Date().toISOString(),
  }
  return { judgment, followup: decision.action === 'followup' && remainingFollowups > 0 ? decision.followup : null }
}

export function appendDynamicFollowup(card: Question, followup: z.infer<typeof followupSchema>, difficulty: SessionConfig['difficulty']) {
  followup.rubric = mergeRubric(followup.rubric)
  const knowledgeIds = card.generation!.knowledgePoints.map((point) => point.id)
  if (!unique(followup.targetPointIds) || followup.targetPointIds.some((id) => !knowledgeIds.includes(id)) || !sameIds(followup.rubric.map((point) => point.pointId), followup.targetPointIds)) throw new AppError(502, '动态追问评分范围未通过知识锚点校验，本次回答未保存。')
  if (!unique(followup.sourceIds) || followup.sourceIds.some((id) => !card.generation!.sourceIds.includes(id)) || (card.generation!.sourceIds.length && !followup.sourceIds.length)) throw new AppError(502, '动态追问的来源引用无效，本次回答未保存。')
  if ([card.variants[difficulty].stem, ...card.followups.map((item) => item.prompt)].some((text) => normalized(text) === normalized(followup.prompt))) throw new AppError(502, 'AI 重复了已提过的问题，本次回答未保存，请重试。')
  for (const point of followup.rubric) {
    const existing = card.points.find((item) => item.id === point.pointId)
    if (existing) existing.text += `；实际追问要求：${point.criterion}`
    else card.points.push({ id: point.pointId, text: point.criterion })
  }
  card.followups.push({ id: randomUUID(), prompt: followup.prompt, targetPointIds: followup.targetPointIds })
  card.referenceAnswer += `\n\n追问：${followup.prompt}\n参考：${followup.referenceAnswer}`
}
