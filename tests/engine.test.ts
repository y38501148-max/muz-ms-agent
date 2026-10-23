import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { z } from 'zod'
import { questions } from '../content/questions'
import { InterviewService, followupLimits, validateEvaluationEvidence } from '../server/lib/engine'
import { JsonStore } from '../server/lib/store'
import { evidenceExcerpts } from '../server/lib/evidence'
import { AppError } from '../server/lib/errors'
import type { InterviewSession, Question, SessionConfig, ProviderSettings, Turn } from '../shared/types'
import { requestJson, type ProviderFetch } from '../server/lib/provider'
import localMiddleware from '../server/middleware/local'

// Only used with mocked HTTP responses; never a live credential.
const mockApiKey = 'test-key'

const config: SessionConfig = {
  roleId: 'backend', companyId: 'general', difficulty: 'easy', mode: 'simulation', engine: 'local',
  durationMinutes: 15, maxQuestions: 2, topics: [], candidateContext: '', customCompanyName: '', customJobDescription: '',
}

async function setup(fetcher?: ProviderFetch) {
  const directory = await mkdtemp(join(tmpdir(), 'muz-ms-agent-test-'))
  const service = new InterviewService(new JsonStore(directory), fetcher)
  return { service, directory, clean: () => rm(directory, { recursive: true, force: true }) }
}

function status(code: number) {
  return (error: unknown) => error instanceof AppError && error.statusCode === code
}

async function act(service: InterviewService, session: InterviewSession, action: string, extra = {}) {
  return service.turn(session.id, { action, version: session.version, ...extra })
}

function authoredQuestions(input: { knowledgeCards: (Omit<Question, 'sources'> & { sources: { id: string }[] })[] }) {
  return { questions: input.knowledgeCards.map((card) => ({
    knowledgeCardId: card.id, title: `${card.title}：本场原创练习`,
    stem: `一个新上线的任务处理应用在灰度期间遇到与 ${card.title} 相关的问题。请根据可收集的证据说明你的判断和处理步骤。`,
    expectedPointIds: card.points.slice(0, 2).map((point) => point.id),
    rubric: card.points.slice(0, 2).map((point) => ({ pointId: point.id, criterion: `针对本题情境：${point.text}` })),
    referenceAnswer: '先明确当前约束和待验证的假设，再给出与知识点相符的处理方案，并用具体观测验证。',
    hints: ['先明确任务的边界和可观测证据。'], pitfalls: ['不能仅根据现象直接宣称根因。'], sourceIds: card.sources.map((source) => source.id),
  })) }
}

function jsonProviderResponse(protocol: ProviderSettings['protocol'], output: unknown) {
  const text = JSON.stringify(output)
  return new Response(JSON.stringify(protocol === 'anthropic'
    ? { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }] }
    : protocol === 'responses'
      ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : { choices: [{ finish_reason: 'stop', message: { content: text } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

test('local session lifecycle persists visible turns and yields an honest report without scores', async () => {
  const { service, directory, clean } = await setup()
  try {
    let session = await service.create(config)
    const catalog = await service.catalog()
    assert.ok(catalog.questions.length > 10)
    assert.equal('points' in catalog.questions[0]!, false)
    assert.equal('expectedPointIds' in catalog.questions[0]!.variants.easy, false)
    assert.equal('referenceAnswer' in session, false)
    assert.match(session.turns[0]!.text, /本地脚本练习/)
    session = await act(service, session, 'answer', { text: '我会先明确条件，再用可观测数据验证假设。' })
    session = await act(service, session, 'pause')
    assert.equal(session.status, 'paused')
    await assert.rejects(act(service, session, 'answer', { text: '暂停时不能作答' }), status(409))
    session = await act(service, session, 'resume')
    session = await act(service, session, 'end')
    const report = await service.generateReport(session.id)
    assert.deepEqual(report.evaluations, [])
    assert.equal('score' in report, false)
    assert.match(report.limitation, /不做语义理解或能力评分/)
    assert.ok(report.improvements[0]!.acceptance.includes('参考检查点'))
    assert.ok(report.retestQuestionIds.every((id) => questions.some((question) => question.id === id)))
    const reloaded = new InterviewService(new JsonStore(directory))
    assert.deepEqual(await reloaded.getSession(session.id), session)
    assert.deepEqual(await reloaded.getReport(session.id), report)
    assert.equal((await reloaded.sessions())[0]!.answeredCount, 1)
    assert.equal((await reloaded.sessions())[0]!.hasReport, true)
    const disk = JSON.parse(await readFile(join(directory, 'store.json'), 'utf8'))
    assert.equal(disk.sessions[session.id].status, 'completed')
    await service.deleteSession(session.id)
    await assert.rejects(service.getSession(session.id), status(404))
    await assert.rejects(service.getReport(session.id), status(404))
  } finally { await clean() }
})

test('mode changes preserve hint assistance, followup quota and distinguish unanswered skips', async () => {
  const { service, clean } = await setup()
  try {
    const card = questions.find((question) => question.roles.includes('backend') && question.hints.length >= 1 && question.followups.length >= 1)!
    let session = await service.create({ ...config, maxQuestions: 1, questionIds: [card.id] })
    await assert.rejects(act(service, session, 'hint'), status(400))
    assert.equal((await service.getSession(session.id)).version, session.version)
    session = await act(service, session, 'answer', { text: '请根据具体条件判断，并解释依据。' })
    assert.equal(session.followupsUsed, 1)
    session = await act(service, session, 'switch-mode', { mode: 'coaching' })
    assert.equal(session.followupsUsed, 1)
    session = await act(service, session, 'hint')
    assert.equal(session.assistanceStarted, true)
    session = await act(service, session, 'switch-mode', { mode: 'simulation' })
    session = await act(service, session, 'answer', { text: '我结合提示重新组织了回答。' })
    assert.equal(session.status, 'completed')
    const answers = session.turns.filter((turn) => turn.kind === 'answer')
    assert.deepEqual(answers.map((turn) => turn.assisted), [false, true])
    assert.equal(session.turns.filter((turn) => turn.kind === 'followup').length, 1)
    assert.match((await service.generateReport(session.id)).limitation, /切换过模式/)
    let skipped = await service.create({ ...config, maxQuestions: 1 })
    skipped = await act(service, skipped, 'skip')
    const report = await service.generateReport(skipped.id)
    assert.deepEqual(report.evaluations, [])
    assert.deepEqual(report.retestQuestionIds, [])
    assert.match(report.summary, /实际作答 0 道/)
  } finally { await clean() }
})

test('each difficulty enforces its followup limit and never repeats a family', async () => {
  const { service, clean } = await setup()
  try {
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      let session = await service.create({ ...config, difficulty, maxQuestions: 1 })
      const card = questions.find((question) => question.id === session.questionIds[0])!
      for (let i = 0; session.status === 'active' && i < 6; i += 1) session = await act(service, session, 'answer', { text: '这里需要结合条件与证据做进一步分析。' })
      assert.equal(session.status, 'completed')
      assert.equal(session.turns.filter((turn) => turn.kind === 'followup').length, Math.min(followupLimits[difficulty], card.followups.length))
    }
    const diverse = await service.create({ ...config, maxQuestions: 8 })
    assert.equal(new Set(diverse.questionIds.map((id) => questions.find((card) => card.id === id)!.familyId)).size, diverse.questionIds.length)
    assert.ok(new Set(diverse.questionIds.map((id) => questions.find((card) => card.id === id)!.topic)).size >= 3)
  } finally { await clean() }
})

test('optimistic versions serialize duplicate turns; a stale request cannot append twice', async () => {
  const { service, clean } = await setup()
  try {
    const session = await service.create(config)
    const results = await Promise.allSettled([
      act(service, session, 'answer', { text: '第一个请求' }),
      act(service, session, 'answer', { text: '重复点击' }),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    assert.ok(status(409)(rejected.reason))
    assert.equal((await service.getSession(session.id)).turns.filter((turn) => turn.kind === 'answer').length, 1)
  } finally { await clean() }
})

test('provider failure never commits candidate turn or silently substitutes local behavior', async () => {
  const fetcher: ProviderFetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (body.text?.format?.name === 'interview_generation') return jsonProviderResponse('responses', authoredQuestions(JSON.parse(body.input[0].content).taskInput))
    throw new Error('upstream secret: should-not-leak')
  }
  const { service, clean } = await setup(fetcher)
  try {
    await service.saveSettings({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'test-model', apiKey: mockApiKey })
    const card = questions.find((question) => question.roles.includes('backend') && question.followups.length)!
    const session = await service.create({ ...config, engine: 'ai', maxQuestions: 1, questionIds: [card.id] })
    await assert.rejects(act(service, session, 'answer', { text: '这次真实模型调用失败，应保留我的原会话。' }), (error: unknown) => status(502)(error) && !(error as Error).message.includes('should-not-leak'))
    assert.deepEqual(await service.getSession(session.id), session)
    await assert.rejects(service.testSettings(), status(502))
    assert.equal(JSON.stringify(await service.settings()).includes('should-not-leak'), false)
    const preserved = await service.saveSettings({ protocol: 'chat-completions', baseUrl: 'https://models.invalid/v1', model: 'other', apiKey: '' })
    assert.equal(preserved.hasApiKey, true)
    const cleared = await service.saveSettings({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'other', clearApiKey: true })
    assert.equal(cleared.hasApiKey, false)
  } finally { await clean() }
})

test('fabricated quotes or scores without matching independent evidence are rejected', async () => {
  const { service, clean } = await setup()
  try {
    let session = await service.create({ ...config, maxQuestions: 1 })
    session = await act(service, session, 'answer', { text: '我会根据输入边界设计测试。' })
    const answer = session.turns.find((turn) => turn.kind === 'answer')!
    const card = questions.find((question) => question.id === answer.questionId)!
    const evaluation = {
      questionId: card.id,
      independent: { correctness: 3, reasoning: null, application: null, validation: null, communication: null },
      assisted: null, evidence: [{ turnId: answer.id, quote: '我完成了所有性能测试', pointId: card.points[0]!.id, observation: '不应捏造' }],
      strengths: [], gaps: [], confidence: 'low' as const,
    }
    assert.throws(() => validateEvaluationEvidence(session, [evaluation]), status(502))
    evaluation.evidence[0]!.quote = answer.text
    assert.doesNotThrow(() => validateEvaluationEvidence(session, [evaluation]))
    evaluation.evidence = []
    assert.throws(() => validateEvaluationEvidence(session, [evaluation]), status(502))
  } finally { await clean() }
})

test('all provider protocols support checked branch selection and independent report evidence', async () => {
  for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) {
    let requestCount = 0
    const fetcher: ProviderFetch = async (url, init) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body))
      assert.equal(body.stream, true)
      const properties = body.output_config?.format?.schema?.properties
      const formatName = body.text?.format?.name || body.response_format?.json_schema?.name || (properties?.ok ? 'connection_test' : properties?.questions ? 'interview_generation' : properties?.judgment ? 'interview_answer' : properties?.action ? 'interview_decision' : properties?.evaluations ? 'interview_evaluation' : undefined)
      const messages = body.input || body.messages
      const system = body.instructions || body.system || messages.find((message: { role: string }) => message.role === 'system')?.content
      assert.match(system, /原始 JSON Schema/)
      assert.match(system, /"properties"/)
      if (formatName === 'interview_decision') assert.match(system, /"required":\["action","followupId"\]/)
      if (formatName === 'interview_evaluation') {
        assert.match(system, /"confidence"/)
        assert.match(system, /"maximum":4/)
      }
      const envelope = JSON.parse(messages[protocol === 'chat-completions' ? 1 : 0].content)
      assert.equal(envelope.task, formatName)
      assert.ok(envelope.outputContract.schema.properties)
      const input = envelope.taskInput
      if (protocol === 'responses') {
        assert.equal(typeof body.instructions, 'string')
        assert.match(body.instructions, /不要使用 Markdown/)
        assert.deepEqual(messages.map((message: { role: string }) => message.role), ['user'])
      }
      if (protocol === 'anthropic') {
        assert.equal(String(url), 'https://models.invalid/v1/messages')
        assert.equal(body.output_config.format.type, 'json_schema')
        assert.equal(typeof body.system, 'string')
        assert.equal(body.max_tokens, 8192)
        assert.equal(messages.length, 1)
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('x-api-key'), mockApiKey)
        assert.equal(headers.get('anthropic-version'), '2023-06-01')
        assert.equal(headers.has('authorization'), false)
        if (formatName === 'interview_evaluation') {
          const numericSchema = properties.evaluations.items.properties.independent.properties.reasoning.anyOf[0]
          assert.equal(numericSchema.minimum, undefined)
          assert.equal(numericSchema.maximum, undefined)
          assert.match(numericSchema.description, /maximum/)
        }
      }
      let output: unknown
      if (formatName === 'connection_test') output = { ok: true }
      else if (formatName === 'interview_generation') output = authoredQuestions(input)
      else if (formatName === 'interview_answer') {
        const answer = input.transcript.find((turn: { id: string }) => turn.id === input.currentAnswerTurnId)
        output = { judgment: { verdict: 'partial', explanation: '说明了方向，但验证条件仍需补充。', evidence: [{ quoteId: input.currentAnswer.excerpts[0].id, pointId: input.card.points[0].id, observation: '引用当前回答说明判断。' }] }, action: 'advance', followup: null }
      }
      else if (formatName === 'interview_evaluation') {
        const answer = input.transcript.find((turn: { kind: string }) => turn.kind === 'answer')
        output = {
          summary: '有一次可核对的作答。',
          evaluations: [{
            questionId: input.cards[0].id,
            independent: { correctness: null, reasoning: 2, application: null, validation: null, communication: null },
            assisted: null,
            evidence: [{ quoteId: answer.excerpts[0].id, pointId: input.cards[0].points[0].id, observation: '依据此原话给出判断。' }],
            strengths: ['说明了一个判断方向'], gaps: [], confidence: 'low',
          }],
          improvements: [],
        }
      } else throw new Error('Unexpected model request')
      return new Response(JSON.stringify(protocol === 'anthropic'
        ? { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }] }
        : protocol === 'responses'
        ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }
        : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const { service, clean } = await setup(fetcher)
    try {
      await service.saveSettings({ protocol, baseUrl: 'https://models.invalid/v1', model: 'test-model', apiKey: mockApiKey })
      assert.equal((await service.testSettings()).verified, true)
      const card = questions.find((question) => question.roles.includes('backend') && question.followups.length)!
      let session = await service.create({ ...config, engine: 'ai', maxQuestions: 1, questionIds: [card.id] })
      session = await act(service, session, 'answer', { text: '我会根据题目条件明确假设，再选择可验证的方法。' })
      assert.equal(session.status, 'completed')
      const report = await service.generateReport(session.id)
      assert.equal(report.engine, 'ai')
      assert.equal(report.evaluations[0]!.independent.reasoning, 2)
      assert.equal(report.evaluations[0]!.evidence[0]!.quote, session.turns.find((turn) => turn.kind === 'answer')!.text)
      assert.equal(report.answerJudgments?.[0]?.verdict, 'partial')
      assert.equal(requestCount, 4)
      await service.generateReport(session.id)
      assert.equal(requestCount, 4, 'saved report should not trigger another paid evaluation')
    } finally { await clean() }
  }
})

test('Anthropic refusal and token truncation fail instead of validating a partial response', async () => {
  for (const stopReason of ['refusal', 'max_tokens']) {
    const fetcher: ProviderFetch = async () => new Response(JSON.stringify({ type: 'message', stop_reason: stopReason, content: [{ type: 'text', text: '{"ok":true}' }] }), { status: 200 })
    const { service, clean } = await setup(fetcher)
    try {
      await service.saveSettings({ protocol: 'anthropic', baseUrl: 'https://models.invalid/v1', model: 'user-model', apiKey: mockApiKey })
      await assert.rejects(service.testSettings(), status(502))
      assert.equal(JSON.stringify(await service.settings()).includes('test-placeholder'), false)
    } finally { await clean() }
  }
})

test('connection checks send meaningful user content accepted by punctuation-filtering gateways', async () => {
  for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) {
    let rejected = 0
    let accepted = 0
    const fetcher: ProviderFetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const user = (body.input || body.messages).find((message: { role: string }) => message.role === 'user')
      const input = JSON.parse(user.content).taskInput
      if (typeof input.message !== 'string' || !/[\p{L}\p{N}]/u.test(input.message)) {
        rejected += 1
        return new Response(JSON.stringify({ error: { message: '消息内容为空或只有空白/标点' } }), { status: 400 })
      }
      accepted += 1
      const text = JSON.stringify({ ok: true })
      const response = protocol === 'anthropic'
        ? { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }] }
        : protocol === 'responses'
          ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
          : { choices: [{ finish_reason: 'stop', message: { content: text } }] }
      return new Response(JSON.stringify(response), { status: 200 })
    }
    const { service, clean } = await setup(fetcher)
    const settings = { protocol, baseUrl: 'https://models.invalid/v1', model: 'test-model', apiKey: mockApiKey }
    try {
      await assert.rejects(requestJson(settings, 'connection_test', z.object({ ok: z.literal(true) }).strict(), 'Return JSON {"ok":true}.', {}, fetcher), status(502))
      await service.saveSettings(settings)
      assert.equal((await service.testSettings()).verified, true)
      assert.equal(rejected, 1)
      assert.equal(accepted, 1)
    } finally { await clean() }
  }
})

test('format normalization accepts one complete JSON fence and rejects prose or truncated wrappers', async () => {
  const settings = { protocol: 'responses' as const, baseUrl: 'https://models.invalid/v1', model: 'test-model', apiKey: mockApiKey }
  for (const [raw, accepted] of [
    ['```json\n{"ok":true}\n```', true],
    ['说明文字\n```json\n{"ok":true}\n```', false],
    ['```json\n{"ok":true}\n', false],
    ['{"ok":true}\n连接正常', false],
  ] as const) {
    const fetcher: ProviderFetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.match(body.instructions, /只返回符合指定 JSON Schema/)
      assert.deepEqual(body.input.map((message: { role: string }) => message.role), ['user'])
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: raw }] }] }), { status: 200 })
    }
    const request = requestJson(settings, 'format_test', z.object({ ok: z.literal(true) }).strict(), 'Return a connection confirmation.', { message: '测试请求' }, fetcher)
    if (accepted) assert.deepEqual(await request, { ok: true })
    else await assert.rejects(request, status(502))
  }
})

test('one same-model repair can correct JSON syntax or missing required fields across protocols', async () => {
  const schema = z.object({ action: z.literal('advance'), followupId: z.string().nullable() }).strict()
  for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) {
    for (const badOutput of ['这题已经回答，可以下一题。', '{"action":"advance"}']) {
      let calls = 0
      const input = { candidateMessage: '我的原始回答必须保留。' }
      const fetcher: ProviderFetch = async (_url, init) => {
        calls += 1
        const body = JSON.parse(String(init?.body))
        assert.equal(body.model, 'same-test-model')
        assert.equal(body.stream, true)
        const user = (body.input || body.messages).find((message: { role: string }) => message.role === 'user')
        if (calls === 2) {
          const repair = JSON.parse(user.content)
          assert.deepEqual(repair.taskInput, input)
          assert.equal(repair.formatRepair.previousVisibleOutput, badOutput)
          assert.equal(repair.formatRepair.validationIssues[0].path, badOutput.startsWith('{') ? 'followupId' : '$')
          assert.ok(body.text?.format || body.response_format || body.output_config?.format)
        }
        const text = calls === 1 ? badOutput : '{"action":"advance","followupId":null}'
        return new Response(JSON.stringify(protocol === 'anthropic'
          ? { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }] }
          : protocol === 'responses'
            ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
            : { choices: [{ finish_reason: 'stop', message: { content: text } }] }), { status: 200 })
      }
      const result = await requestJson({ protocol, baseUrl: 'https://models.invalid/v1', model: 'same-test-model', apiKey: mockApiKey }, 'interview_decision', schema, 'Select the next action.', input, fetcher)
      assert.deepEqual(result, { action: 'advance', followupId: null })
      assert.equal(calls, 2)
    }
  }
})

test('a repeated format failure stops at two calls without relaxing the schema', async () => {
  for (const text of ['说明：{"ok":true}', '{}']) {
    let calls = 0
    const fetcher: ProviderFetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }), { status: 200 })
    }
    await assert.rejects(requestJson({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'same-test-model', apiKey: mockApiKey }, 'connection_test', z.object({ ok: z.literal(true) }).strict(), 'Test connection.', { message: '测试' }, fetcher), status(502))
    assert.equal(calls, 2)
  }
})

test('HTTP, network, refusal, truncation and timeout failures are not retried', async () => {
  for (const failure of ['http', 'network', 'refusal', 'truncation', 'timeout'] as const) {
    let calls = 0
    const fetcher: ProviderFetch = async () => {
      calls += 1
      if (failure === 'network') throw new Error('private upstream details')
      if (failure === 'timeout') throw new DOMException('private timeout details', 'TimeoutError')
      if (failure === 'http') return new Response('{}', { status: 503 })
      return new Response(JSON.stringify(failure === 'truncation'
        ? { status: 'incomplete', output: [] }
        : { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }), { status: 200 })
    }
    const request = requestJson({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'same-test-model', apiKey: mockApiKey }, 'interview_evaluation', z.object({ ok: z.literal(true) }).strict(), 'Test response.', { message: '测试' }, fetcher)
    await assert.rejects(request, (error: unknown) => {
      assert.ok(status(failure === 'timeout' ? 504 : 502)(error))
      assert.equal((error as Error).message.includes('private'), false)
      if (failure === 'timeout') assert.match((error as Error).message, /超时（180 秒）/)
      return true
    })
    assert.equal(calls, 1)
  }
})

function sseFrame(type: string, payload: unknown) {
  const data = JSON.stringify(payload, null, 2).split('\n').map((line) => `data: ${line}`).join('\r\n')
  return `${type ? `event: ${type}\r\n` : ''}${data}\r\n\r\n`
}

function fragmentedSse(source: string) {
  const bytes = new TextEncoder().encode(source)
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      // Single-byte chunks deliberately split Chinese and emoji UTF-8 sequences and CRLF delimiters.
      for (let index = 0; index < bytes.length; index += 1) controller.enqueue(bytes.slice(index, index + 1))
      controller.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

function providerStream(protocol: 'responses' | 'chat-completions' | 'anthropic', text: string, ending: 'complete' | 'missing' | 'truncated' | 'error' = 'complete') {
  const parts = [text.slice(0, 6), text.slice(6)]
  let stream = ': keep-alive\r\n\r\n'
  if (protocol === 'anthropic') {
    stream += sseFrame('message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], stop_reason: null } })
    stream += sseFrame('ping', { type: 'ping' })
    stream += sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    stream += sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_REASONING_MUST_NOT_APPEAR' } })
    stream += sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 })
    stream += sseFrame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
    for (const part of parts) stream += sseFrame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: part } })
    stream += sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 })
    if (ending === 'error') return stream + sseFrame('error', { type: 'error', error: { type: 'api_error', message: 'PRIVATE_UPSTREAM_DETAILS' } })
    stream += sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: ending === 'truncated' ? 'max_tokens' : 'end_turn' } })
    if (ending !== 'missing') stream += sseFrame('message_stop', { type: 'message_stop' })
  } else if (protocol === 'chat-completions') {
    stream += sseFrame('', { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: 'PRIVATE_REASONING_MUST_NOT_APPEAR' }, finish_reason: null }] })
    for (const part of parts) stream += sseFrame('', { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })
    if (ending === 'error') return stream + sseFrame('', { error: { message: 'PRIVATE_UPSTREAM_DETAILS' } })
    stream += sseFrame('', { object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: ending === 'truncated' ? 'length' : 'stop' }] })
    if (ending !== 'missing') stream += 'data: [DONE]\r\n\r\n'
  } else {
    stream += sseFrame('response.created', { type: 'response.created', response: { status: 'in_progress', output: [] } })
    stream += sseFrame('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', delta: 'PRIVATE_REASONING_MUST_NOT_APPEAR' })
    for (const part of parts) stream += sseFrame('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: part })
    if (ending === 'error') return stream + sseFrame('response.failed', { type: 'response.failed', response: { status: 'failed', error: { message: 'PRIVATE_UPSTREAM_DETAILS' } } })
    if (ending === 'truncated') return stream + sseFrame('response.incomplete', { type: 'response.incomplete', response: { status: 'incomplete' } })
    if (ending !== 'missing') stream += sseFrame('response.completed', { type: 'response.completed', response: { status: 'completed', output: [] } })
  }
  return stream
}

test('all streaming formats aggregate visible UTF-8 text across chunk boundaries and multiline SSE frames', async () => {
  for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) {
    let calls = 0
    const fetcher: ProviderFetch = async (_url, init) => {
      calls += 1
      assert.equal(JSON.parse(String(init?.body)).stream, true)
      return fragmentedSse(providerStream(protocol, JSON.stringify({ message: '收到连接测试🙂' })))
    }
    const result = await requestJson({ protocol, baseUrl: 'https://models.invalid/v1', model: 'stream-test-model', apiKey: mockApiKey }, 'stream_test', z.object({ message: z.literal('收到连接测试🙂') }).strict(), 'Return a confirmation.', { message: '连接测试' }, fetcher)
    assert.deepEqual(result, { message: '收到连接测试🙂' })
    assert.equal(calls, 1)
  }
})

test('stream errors, token truncation and missing terminal events reject valid-looking JSON without retry', async () => {
  for (const protocol of ['responses', 'chat-completions', 'anthropic'] as const) {
    for (const ending of ['missing', 'truncated', 'error'] as const) {
      let calls = 0
      const fetcher: ProviderFetch = async () => {
        calls += 1
        return fragmentedSse(providerStream(protocol, '{"ok":true}', ending))
      }
      await assert.rejects(requestJson({ protocol, baseUrl: 'https://models.invalid/v1', model: 'stream-test-model', apiKey: mockApiKey }, 'stream_test', z.object({ ok: z.literal(true) }).strict(), 'Return JSON.', { message: '连接测试' }, fetcher), (error: unknown) => status(502)(error) && !(error as Error).message.includes('PRIVATE_'))
      assert.equal(calls, 1)
    }
  }
})

test('sessions pin full question versions and reveal snapshots only after completion', async () => {
  const { service, directory, clean } = await setup()
  const live = questions.find((question) => question.roles.includes('backend'))!
  const original = structuredClone(live)
  try {
    let session = await service.create({ ...config, maxQuestions: 1, questionIds: [live.id] })
    await assert.rejects(service.completedQuestions(session.id), status(409))
    const stored = JSON.parse(await readFile(join(directory, 'store.json'), 'utf8'))
    assert.deepEqual(stored.questionSnapshots[session.id], [original])
    assert.equal('questionSnapshots' in session, false)
    live.variants.easy.stem = '后来修改的新题干，不属于既有会话'
    live.points[0]!.text = '后来修改的新评分要点'
    live.followups[0]!.prompt = '后来修改的新追问'
    const recovered = new InterviewService(new JsonStore(directory))
    session = await act(recovered, session, 'answer', { text: '这里是基于原题作出的回答。' })
    assert.equal(session.turns.at(-1)!.text, original.followups[0]!.prompt)
    session = await act(recovered, session, 'end')
    assert.deepEqual(await recovered.completedQuestions(session.id), [original])
    const report = await recovered.generateReport(session.id)
    assert.ok(report.improvements[0]!.acceptance.includes(original.points[0]!.text))
    assert.equal(report.improvements[0]!.acceptance.includes(live.points[0]!.text), false)
    await recovered.deleteSession(session.id)
    const deleted = JSON.parse(await readFile(join(directory, 'store.json'), 'utf8'))
    assert.equal(deleted.questionSnapshots[session.id], undefined)
  } finally {
    Object.assign(live, original)
    await clean()
  }
})

test('AI writes original questions and answer-specific followups with coaching feedback and assisted scoring', async () => {
  let generations = 0
  const followupPrompt = '你刚才说地址空间完全一样：当其中一个工作任务崩溃时，另一个任务会怎样受到影响？请解释你的依据。'
  const fetcher: ProviderFetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const input = JSON.parse(body.input[0].content).taskInput
    if (body.text.format.name === 'interview_generation') {
      generations += 1
      assert.ok(input.experienceGuidance.some((pattern: { id: string }) => pattern.id === 'cpp-mechanism-to-execution'))
      assert.equal(input.experienceGuidance.some((pattern: { id: string }) => pattern.id === 'frontend-observable-interaction'), false)
      const output = authoredQuestions(input)
      output.questions[0]!.stem += ` 本次独立练习编号 ${generations}。`
      return jsonProviderResponse('responses', output)
    }
    if (body.text.format.name === 'interview_answer') {
      assert.ok(input.experienceGuidance.some((pattern: { id: string }) => pattern.id === 'cpp-mechanism-to-execution'))
      const answer = input.transcript.find((turn: { id: string }) => turn.id === input.currentAnswerTurnId)
      const first = input.remainingFollowups > 0
      return jsonProviderResponse('responses', {
        judgment: { verdict: first ? 'incorrect' : 'correct', explanation: first ? '进程通常有隔离的地址空间，而同一进程的线程共享资源；原回答把二者混为一谈。' : '修正后说明了隔离、共享与故障范围，符合追问要求。', evidence: [{ quoteId: input.currentAnswer.excerpts[0].id, pointId: first ? input.card.points[0].id : input.card.points.at(-1).id, observation: '依据当前原话与实际问题给出判断。' }] },
        action: first ? 'followup' : 'advance',
        followup: first ? { prompt: followupPrompt, targetPointIds: ['p3'], rubric: [{ pointId: 'p3', criterion: '根据进程与线程的隔离边界解释故障传播。' }, { pointId: 'p3', criterion: '说明验证故障范围的方法。' }], referenceAnswer: '独立进程的故障通常局限于该进程；线程所在线程组的进程故障可能影响共享进程内的其他任务。需结合运行时和具体故障验证。', sourceIds: input.card.generation.sourceIds } : null,
      })
    }
    if (body.text.format.name === 'interview_evaluation') {
      assert.equal(input.transcript.some((turn: { kind: string }) => ['feedback', 'opening', 'control', 'closing'].includes(turn.kind)), false)
      assert.equal(JSON.stringify(input).includes('进程通常有隔离的地址空间，而同一进程的线程共享资源；原回答把二者混为一谈。'), false)
      assert.equal(input.config.candidateContext, undefined)
      assert.equal(input.config.customJobDescription, undefined)
      assert.deepEqual(Object.keys(input.cards[0].variants), ['easy'])
      assert.equal(input.cards[0].generation, undefined)
      assert.equal(input.cards[0].sources, undefined)
      const answers = input.transcript.filter((turn: { kind: string }) => turn.kind === 'answer')
      const scores = (correctness: number) => ({ correctness, reasoning: null, application: null, validation: null, communication: null })
      return jsonProviderResponse('responses', { summary: '首答有误，辅导后能够修正。', evaluations: [{ questionId: input.cards[0].id, independent: scores(0), assisted: scores(3), evidence: answers.map((answer: { id: string; text: string; excerpts: { id: string }[] }, index: number) => ({ quoteId: answer.excerpts[0]!.id, pointId: index === 0 ? 'p1' : 'p3', observation: '分别记录独立首答和反馈后的作答。' })), strengths: ['反馈后能修正解释'], gaps: ['独立首答混淆隔离边界'], confidence: 'medium' }], improvements: [] })
    }
    throw new Error('Unexpected request')
  }
  const { service, clean } = await setup(fetcher)
  try {
    const base = questions.find((card) => card.id === 'os-process-thread')!
    const baseCopy = structuredClone(base)
    await service.saveSettings({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'dynamic-test-model', apiKey: mockApiKey })
    let session = await service.create({ ...config, engine: 'ai', mode: 'coaching', maxQuestions: 1, questionIds: [base.id] })
    assert.equal(session.questionStrategy, 'knowledge-generated')
    const originalStem = session.turns.find((turn) => turn.kind === 'question')!.text
    assert.ok(!Object.values(base.variants).some((variant) => variant.stem === originalStem))
    assert.equal(JSON.stringify(session).includes('referenceAnswer'), false)
    await assert.rejects(service.completedQuestions(session.id), status(409))
    session = await act(service, session, 'answer', { text: '进程和线程的地址空间完全一样，崩溃互不影响。' })
    assert.equal(session.turns.find((turn) => turn.kind === 'feedback')!.feedback!.verdict, 'incorrect')
    assert.equal(session.turns.at(-1)!.text, followupPrompt)
    assert.equal(session.assistanceStarted, true)
    assert.ok(!base.followups.some((followup) => followup.prompt === followupPrompt))
    session = await act(service, session, 'answer', { text: '我修正为：独立进程有隔离边界，同一进程内线程共享资源，故障影响需要结合运行时验证。' })
    assert.equal(session.status, 'completed')
    assert.deepEqual(session.turns.filter((turn) => turn.kind === 'answer').map((turn) => turn.assisted), [false, true])
    const snapshots = await service.completedQuestions(session.id)
    assert.equal(snapshots[0]!.review, 'draft')
    assert.equal(snapshots[0]!.generation!.knowledgeCardId, base.id)
    assert.equal(snapshots[0]!.followups[0]!.prompt, followupPrompt)
    assert.ok(snapshots[0]!.points.some((point) => point.id === 'p3'))
    assert.equal(snapshots[0]!.points.filter((point) => point.id === 'p3').length, 1)
    assert.match(snapshots[0]!.points.find((point) => point.id === 'p3')!.text, /解释故障传播。；说明验证故障范围/)
    const report = await service.generateReport(session.id)
    assert.deepEqual(report.answerJudgments!.map((judgment) => judgment.verdict), ['incorrect', 'correct'])
    assert.equal(report.evaluations[0]!.independent.correctness, 0)
    assert.equal(report.evaluations[0]!.assisted!.correctness, 3)
    assert.deepEqual(report.retestQuestionIds, [base.id])
    const retest = await service.create({ ...config, engine: 'ai', maxQuestions: 1, questionIds: report.retestQuestionIds })
    assert.notEqual(retest.turns.find((turn) => turn.kind === 'question')!.text, originalStem)
    assert.equal((await service.completedQuestions(session.id))[0]!.variants.easy.stem, originalStem)
    assert.deepEqual(base, baseCopy, 'session authoring must never mutate the shared knowledge bank')
  } finally { await clean() }
})

test('simulation hides judgments while active or paused and exposes recorded judgments once completed', async () => {
  const marker = 'HIDDEN_CORRECTNESS_EXPLANATION'
  const fetcher: ProviderFetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const input = JSON.parse(body.input[0].content).taskInput
    if (body.text.format.name === 'interview_generation') return jsonProviderResponse('responses', authoredQuestions(input))
    if (body.text.format.name === 'interview_answer') {
      const answer = input.transcript.find((turn: { id: string }) => turn.id === input.currentAnswerTurnId)
      return jsonProviderResponse('responses', { judgment: { verdict: 'insufficient', explanation: marker, evidence: [{ quoteId: input.currentAnswer.excerpts[0].id, pointId: input.card.points[0].id, observation: '候选人明确表示不会。' }] }, action: 'advance', followup: null })
    }
    const answer = input.transcript.find((turn: { kind: string }) => turn.kind === 'answer')
    return jsonProviderResponse('responses', { summary: '实际回答明确不会。', evaluations: [{ questionId: input.cards[0].id, independent: { correctness: 0, reasoning: null, application: null, validation: null, communication: null }, assisted: null, evidence: [{ quoteId: answer.excerpts[0].id, pointId: input.cards[0].points[0].id, observation: '根据明确不会的原话记录。' }], strengths: [], gaps: ['需要补充此知识点'], confidence: 'low' }], improvements: [] })
  }
  const { service, clean } = await setup(fetcher)
  try {
    await service.saveSettings({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'dynamic-test-model', apiKey: mockApiKey })
    let session = await service.create({ ...config, engine: 'ai', maxQuestions: 2 })
    session = await act(service, session, 'answer', { text: '不会' })
    assert.equal(session.status, 'active')
    assert.equal(session.turns.some((turn) => turn.kind === 'feedback'), false)
    assert.equal(JSON.stringify(await service.getSession(session.id)).includes(marker), false)
    session = await act(service, session, 'pause')
    assert.equal('answerJudgments' in await service.getSession(session.id), false)
    session = await act(service, session, 'end')
    const completed = await service.getSession(session.id)
    assert.equal(completed.status, 'completed')
    assert.equal(completed.answerJudgments![0]!.explanation, marker)
    assert.equal((await service.generateReport(session.id)).answerJudgments![0]!.explanation, marker)
  } finally { await clean() }
})

test('invalid generated knowledge points, sources or reused fixed stems never create a session', async () => {
  for (const failure of ['point', 'source', 'copied-stem'] as const) {
    const fetcher: ProviderFetch = async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[0].content).taskInput
      const output = authoredQuestions(input)
      if (failure === 'point') {
        output.questions[0]!.expectedPointIds = ['unknown-point']
        output.questions[0]!.rubric = [{ pointId: 'unknown-point', criterion: '不存在的知识点不应进入题目。' }]
      } else if (failure === 'source') output.questions[0]!.sourceIds = ['fabricated-source']
      else output.questions[0]!.stem = input.knowledgeCards[0].variants.easy.stem
      return jsonProviderResponse('responses', output)
    }
    const { service, clean } = await setup(fetcher)
    try {
      await service.saveSettings({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'dynamic-test-model', apiKey: mockApiKey })
      await assert.rejects(service.create({ ...config, engine: 'ai', maxQuestions: 1 }), status(502))
      assert.deepEqual(await service.sessions(), [])
    } finally { await clean() }
  }
})

test('fabricated judgment quotes or unanchored followup scopes do not commit answers or judgments', async () => {
  for (const failure of ['quote', 'followup-scope'] as const) {
    let answerCalls = 0
    const fetcher: ProviderFetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const input = JSON.parse(body.input[0].content).taskInput
      if (body.text.format.name === 'interview_generation') return jsonProviderResponse('responses', authoredQuestions(input))
      answerCalls += 1
      const answer = input.transcript.find((turn: { id: string }) => turn.id === input.currentAnswerTurnId)
      return jsonProviderResponse('responses', { judgment: { verdict: 'partial', explanation: '需要通过实际证据继续判断。', evidence: [{ quoteId: failure === 'quote' ? 'invented-excerpt' : input.currentAnswer.excerpts[0].id, pointId: input.card.points[0].id, observation: '当前原话的判断依据。' }] }, action: failure === 'quote' ? 'advance' : 'followup', followup: failure === 'quote' ? null : { prompt: '请再说明一个与当前知识卡完全无关的结论。', targetPointIds: ['invented-point'], rubric: [{ pointId: 'invented-point', criterion: '不能使用不存在的知识点。' }], referenceAnswer: '这是不应被应用的无依据参考答案。', sourceIds: input.card.generation.sourceIds } })
    }
    const { service, clean } = await setup(fetcher)
    try {
      await service.saveSettings({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'dynamic-test-model', apiKey: mockApiKey })
      const session = await service.create({ ...config, engine: 'ai', maxQuestions: 1 })
      await assert.rejects(act(service, session, 'answer', { text: '这里是实际回答，不允许系统另造原话。' }), status(502))
      assert.deepEqual(await service.getSession(session.id), session)
      assert.deepEqual(await service.storage.read((db) => db.answerJudgments?.[session.id] || []), [])
      assert.equal(answerCalls, failure === 'quote' ? 2 : 1, 'unknown excerpt IDs get one bounded format repair; unanchored followups are rejected immediately')
    } finally { await clean() }
  }
})

test('preexisting fixed AI sessions retain their original decision flow', async () => {
  let calls = 0
  const fetcher: ProviderFetch = async (_url, init) => {
    calls += 1
    assert.equal(JSON.parse(String(init?.body)).text.format.name, 'interview_decision')
    return jsonProviderResponse('responses', { action: 'advance', followupId: null })
  }
  const { service, clean } = await setup(fetcher)
  try {
    await service.saveSettings({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'legacy-test-model', apiKey: mockApiKey })
    const session = await service.create({ ...config, maxQuestions: 1 })
    await service.storage.transaction((db) => {
      db.sessions[session.id]!.config.engine = 'ai'
      delete db.sessions[session.id]!.questionStrategy
    })
    const updated = await act(service, session, 'answer', { text: '这是一场升级之前的固定题卡会话。' })
    assert.equal(updated.status, 'completed')
    assert.equal(calls, 1)
  } finally { await clean() }
})

test('desktop API token is required when configured and ordinary local development remains accessible', async () => {
  const originalToken = process.env.MUZ_DESKTOP_TOKEN
  const app = createApp().use(localMiddleware).use(defineEventHandler(() => ({ ok: true })))
  const server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/api/test`
  try {
    process.env.MUZ_DESKTOP_TOKEN = 'desktop-test-placeholder'
    assert.equal((await fetch(url)).status, 403)
    assert.equal((await fetch(url, { headers: { 'x-muz-desktop-token': 'incorrect' } })).status, 403)
    assert.equal((await fetch(url, { headers: { 'x-muz-desktop-token': 'desktop-test-placeholder' } })).status, 200)
    delete process.env.MUZ_DESKTOP_TOKEN
    assert.equal((await fetch(url)).status, 200)
  } finally {
    if (originalToken === undefined) delete process.env.MUZ_DESKTOP_TOKEN
    else process.env.MUZ_DESKTOP_TOKEN = originalToken
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('reports grade one question per request, restore short turn IDs and never mix evidence between questions', async () => {
  const graded: string[] = []
  const fetcher: ProviderFetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const input = JSON.parse(body.input[0].content).taskInput
    if (body.text.format.name === 'interview_generation') return jsonProviderResponse('responses', authoredQuestions(input))
    if (body.text.format.name === 'interview_answer') {
      const answer = input.transcript.find((turn: Turn) => turn.id === input.currentAnswerTurnId)
      return jsonProviderResponse('responses', { judgment: { verdict: 'partial', explanation: '回答提出一个思路，仍需验证。', evidence: [{ quoteId: input.currentAnswer.excerpts[0].id, pointId: input.card.points[0].id, observation: '按原话判断。' }] }, action: 'advance', followup: null })
    }
    assert.equal(input.cards.length, 1)
    const card = input.cards[0]
    graded.push(card.id)
    assert.ok(input.transcript.every((turn: Turn) => turn.questionId === card.id && /^t\d+$/.test(turn.id)))
    const answer = input.transcript.find((turn: Turn) => turn.kind === 'answer')
    return jsonProviderResponse('responses', { summary: `${card.id} 已复核。`, evaluations: [{ questionId: card.id, independent: { correctness: 2, reasoning: null, application: null, validation: null, communication: null }, assisted: null, evidence: [{ quoteId: answer.excerpts[0].id, pointId: card.points[0].id, observation: '仅依据本题回答。' }], strengths: [], gaps: ['补充验证'], confidence: 'medium' }], improvements: [] })
  }
  const { service, clean } = await setup(fetcher)
  try {
    await service.saveSettings({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'test-model', apiKey: mockApiKey })
    let session = await service.create({ ...config, engine: 'ai', questionIds: ['os-process-thread', 'database-index'] })
    session = await act(service, session, 'answer', { text: '线程共享同一进程内存，我先核对隔离需求。' })
    session = await act(service, session, 'answer', { text: '索引需要结合过滤条件和查询计划检查。' })
    const report = await service.generateReport(session.id)
    assert.deepEqual(graded, session.questionIds)
    assert.equal(report.evaluations.length, 2)
    for (const evaluation of report.evaluations) {
      const answer = session.turns.find((turn) => turn.id === evaluation.evidence[0]!.turnId)!
      assert.equal(answer.questionId, evaluation.questionId)
      assert.equal(answer.text, evaluation.evidence[0]!.quote)
    }
    await service.generateReport(session.id)
    assert.equal(graded.length, 2)
  } finally { await clean() }
})

test('evidence excerpts keep source text intact across Chinese punctuation, code and Unicode', () => {
  const text = `线程共享地址空间。Correction: "stack" is private.\n原始代码：if (x) { y++; } 🙂\n${'无标点长句🙂'.repeat(90)}`
  const excerpts = evidenceExcerpts(text)
  assert.ok(excerpts.length > 3)
  assert.equal(new Set(excerpts.map((excerpt) => excerpt.id)).size, excerpts.length)
  for (const excerpt of excerpts) {
    assert.ok(text.includes(excerpt.text))
    assert.ok(Array.from(excerpt.text).length <= 240)
    assert.equal(excerpt.text.includes('\uFFFD'), false)
  }
  assert.equal(excerpts.map((excerpt) => excerpt.text).join('').replace(/\s/g, ''), text.replace(/\s/g, ''))
})
