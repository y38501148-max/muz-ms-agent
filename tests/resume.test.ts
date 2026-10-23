import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, toNodeListener } from 'h3'
import apiHandler from '../server/api/[...path]'
import localMiddleware from '../server/middleware/local'
import { parseResumeFile, MAX_RESUME_BYTES } from '../server/lib/resume'
import { InterviewService } from '../server/lib/engine'
import { JsonStore } from '../server/lib/store'
import { AppError } from '../server/lib/errors'
import type { ProviderFetch } from '../server/lib/provider'
import type { SessionConfig } from '../shared/types'

// Only used with mocked HTTP responses; never a live credential.
const mockApiKey = 'test-key'

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url))
const rejected = (statusCode: number, message?: RegExp) => (error: unknown) => error instanceof AppError && error.statusCode === statusCode && (!message || message.test(error.message))
const config: SessionConfig = { roleId: 'backend', companyId: 'general', difficulty: 'easy', mode: 'simulation', engine: 'ai', durationMinutes: 15, maxQuestions: 1, topics: ['os'], candidateContext: '', customCompanyName: '', customJobDescription: '' }

test('real synthetic PDF, DOCX, TXT and Markdown files extract plain text locally', async () => {
  for (const extension of ['pdf', 'docx', 'txt', 'md']) {
    const fileName = `resume-synthetic.${extension}`
    const parsed = await parseResumeFile(fileName, 'application/octet-stream', await fixture(fileName))
    assert.equal(parsed.fileName, fileName)
    assert.match(parsed.text, extension === 'pdf' ? /Responsibility: API validation/ : /职责：API 输入校验/)
    assert.equal(parsed.text.includes('<w:'), false)
  }
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('合成简历：职责为 API 校验。', 'utf16le')])
  assert.match((await parseResumeFile('utf16.txt', 'text/plain', utf16)).text, /职责为 API 校验/)
})

test('resume parsing rejects unsupported types, signatures, excess bytes/text and recoverable PDF cases', async () => {
  await assert.rejects(parseResumeFile('resume.exe', '', Buffer.from('text')), rejected(400))
  await assert.rejects(parseResumeFile('resume.pdf', 'application/pdf', Buffer.from('not a PDF')), rejected(400))
  await assert.rejects(parseResumeFile('resume.docx', '', Buffer.from('not a DOCX')), rejected(400))
  await assert.rejects(parseResumeFile('resume.txt', 'application/pdf', Buffer.from('text')), rejected(400))
  await assert.rejects(parseResumeFile('resume.txt', 'text/plain', new Uint8Array(MAX_RESUME_BYTES + 1)), rejected(413, /5 MB/))
  await assert.rejects(parseResumeFile('resume.txt', 'text/plain', Buffer.from('字'.repeat(20001))), rejected(413, /20000/))
  await assert.rejects(parseResumeFile('resume-no-text.pdf', 'application/pdf', await fixture('resume-no-text.pdf')), rejected(422, /OCR/))
  await assert.rejects(parseResumeFile('resume-encrypted.pdf', 'application/pdf', await fixture('resume-encrypted.pdf')), rejected(422, /移除密码/))
})

test('multipart resume endpoint accepts one actual file and reports file/type limits without persisting an upload', async () => {
  const app = createApp().use(localMiddleware).use(apiHandler)
  const server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/resume/parse`
  const headers = process.env.MUZ_DESKTOP_TOKEN ? { 'x-muz-desktop-token': process.env.MUZ_DESKTOP_TOKEN } : undefined
  try {
    for (const extension of ['pdf', 'docx', 'txt', 'md']) {
      const name = `resume-synthetic.${extension}`
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(await fixture(name))]), name)
      const response = await fetch(url, { method: 'POST', headers, body: form })
      assert.equal(response.status, 200)
      const parsed = await response.json() as { fileName: string; text: string }
      assert.equal(parsed.fileName, name)
      assert.ok(parsed.text.length > 20)
    }
    const unsupported = new FormData()
    unsupported.append('file', new Blob(['not a PDF']), 'invalid.pdf')
    assert.equal((await fetch(url, { method: 'POST', headers, body: unsupported })).status, 400)
    const oversize = new FormData()
    oversize.append('file', new Blob([new Uint8Array(MAX_RESUME_BYTES + 1)]), 'too-large.txt')
    assert.equal((await fetch(url, { method: 'POST', headers, body: oversize })).status, 413)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('resume text enters the first generation and later interview calls, while grading stays compact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'muz-resume-test-'))
  const resume = await parseResumeFile('resume-synthetic.txt', 'text/plain', await fixture('resume-synthetic.txt'))
  const phases: string[] = []
  const fetcher: ProviderFetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const phase = body.text.format.name as string
    const input = JSON.parse(body.input[0].content).taskInput
    phases.push(phase)
    let output: unknown
    if (phase === 'interview_generation') {
      assert.equal(input.config.resumeText, resume.text)
      assert.equal(input.config.resumeFileName, resume.fileName)
      assert.match(body.instructions, /简历自述/)
      const card = input.knowledgeCards[0]
      output = { questions: [{ knowledgeCardId: card.id, title: '任务隔离的原创练习', stem: '在一个假设的任务队列服务中，某个处理任务会异常退出。你会怎样划分工作单元，并验证其他任务的影响范围？', expectedPointIds: [card.points[0].id], rubric: [{ pointId: card.points[0].id, criterion: '结合实际问题解释地址空间、共享资源与故障边界。' }], referenceAnswer: '先区分工作单元的地址空间和共享资源，再依据故障影响范围选择隔离方式并进行可控验证。', hints: ['先说明哪些资源是共享的。'], pitfalls: ['不能假设所有任务都完全隔离。'], sourceIds: card.sources.map((source: { id: string }) => source.id) }] }
    } else if (phase === 'interview_answer') {
      assert.equal(input.config.resumeText, resume.text)
      assert.match(body.instructions, /不编造项目或指标/)
      const answer = input.transcript.find((turn: { id: string }) => turn.id === input.currentAnswerTurnId)
      output = { judgment: { verdict: 'insufficient', explanation: '当前没有足够作答信息，需要后续练习。', evidence: [{ quote: answer.text, pointId: input.card.points[0].id, observation: '候选人明确表示不会。' }] }, action: 'advance', followup: null }
    } else {
      assert.equal(input.config.resumeText, undefined)
      assert.equal(input.config.resumeFileName, undefined)
      assert.equal(JSON.stringify(input).includes(resume.text), false)
      output = { summary: '记录不足，维度暂不评分。', evaluations: [{ questionId: input.cards[0].id, independent: { correctness: null, reasoning: null, application: null, validation: null, communication: null }, assisted: null, evidence: [], strengths: [], gaps: [], confidence: 'low' }], improvements: [] }
    }
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }), { status: 200 })
  }
  try {
    const service = new InterviewService(new JsonStore(directory), fetcher)
    await service.saveSettings({ protocol: 'responses', baseUrl: 'https://models.invalid/v1', model: 'resume-test-model', apiKey: mockApiKey })
    let session = await service.create({ ...config, resumeText: resume.text, resumeFileName: resume.fileName })
    assert.match(session.turns[0]!.text, /已载入简历「resume-synthetic.txt」/)
    assert.equal(session.turns[0]!.text.includes(resume.text), false)
    session = await service.turn(session.id, { action: 'answer', text: '不会', version: session.version })
    await service.generateReport(session.id)
    assert.deepEqual(phases, ['interview_generation', 'interview_answer', 'interview_evaluation'])
    const local = await service.create({ ...config, engine: 'local', resumeText: resume.text, resumeFileName: resume.fileName })
    assert.match(local.turns[0]!.text, /本地脚本练习不按简历进行语义个性化/)
    assert.equal(phases.length, 3)
    const legacyInput = await service.create({ ...config, engine: 'local' })
    assert.equal(legacyInput.config.resumeText, '')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
