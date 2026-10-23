import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InterviewService } from '../server/lib/engine'
import { JsonStore } from '../server/lib/store'
import { parseResumeFile } from '../server/lib/resume'
import type { ProviderSettings } from '../shared/types'

const settings: ProviderSettings = {
  protocol: (process.env.MUZ_AI_PROTOCOL || 'responses') as ProviderSettings['protocol'],
  baseUrl: process.env.MUZ_AI_BASE_URL || '',
  model: process.env.MUZ_AI_MODEL || '',
  apiKey: process.env.MUZ_AI_API_KEY || '',
}
assert.ok(['responses', 'chat-completions', 'anthropic'].includes(settings.protocol), 'MUZ_AI_PROTOCOL 无效')
assert.ok(settings.baseUrl && settings.model && settings.apiKey, '请设置 MUZ_AI_BASE_URL、MUZ_AI_MODEL 和 MUZ_AI_API_KEY。此检查会调用模型并产生费用。')

const directory = await mkdtemp(join(tmpdir(), 'muz-live-interview-'))
try {
  const resume = await parseResumeFile('resume-synthetic.pdf', 'application/pdf', new Uint8Array(await readFile(new URL('../tests/fixtures/resume-synthetic.pdf', import.meta.url))))
  let firstGenerationChecked = false
  const service = new InterviewService(new JsonStore(directory), async (url, init) => {
    const body = JSON.parse(String(init?.body))
    const user = (body.input || body.messages).find((message: { role: string }) => message.role === 'user')
    const { taskInput } = JSON.parse(user.content)
    if (taskInput.knowledgeCards) {
      assert.equal(taskInput.config.resumeText, resume.text)
      assert.equal(taskInput.config.resumeFileName, resume.fileName)
      firstGenerationChecked = true
    }
    return fetch(url, init)
  })
  await service.saveSettings(settings)
  console.log(`导入合成 PDF 简历：${resume.text.length} 字`)
  let session = await service.create({
    roleId: 'backend', companyId: 'general', difficulty: 'easy', mode: 'coaching', engine: 'ai',
    durationMinutes: 45, maxQuestions: 1, topics: ['os'], candidateContext: '', customCompanyName: '', customJobDescription: '',
    resumeText: resume.text, resumeFileName: resume.fileName, questionIds: ['os-process-thread'],
  })
  assert.ok(firstGenerationChecked)
  assert.equal(session.questionStrategy, 'knowledge-generated')
  console.log('首轮出题完成，已检查简历注入。')
  session = await service.turn(session.id, { action: 'answer', version: session.version, text: '我会把任务放在不同线程中，因为每个线程都有独立地址空间，一个线程非法写内存不会影响其他任务。' })
  assert.ok(session.turns.some((turn) => turn.kind === 'followup'), '错误机制应触发一次针对性追问')
  assert.equal(session.turns.find((turn) => turn.kind === 'feedback')?.feedback?.verdict, 'incorrect')
  console.log('错误回答被识别，已生成追问。')
  session = await service.turn(session.id, {
    action: 'answer', version: session.version,
    text: '刚才说反了。线程共享进程的地址空间，包括堆和全局数据，分别拥有执行栈等上下文；越界写可能破坏整个进程。需要隔离不可信解析库或崩溃任务时，我选择有界的进程池。跨进程用队列或 IPC 传任务，付出序列化和通信成本；可信、线程安全且频繁共享数据的任务可考虑线程池，共享计数器用锁或原子操作保护。进程池的完成计数可由主进程按带任务 ID 的完成消息汇总，结果写库用唯一任务 ID 幂等更新，不能重复计数。CPU 密集任务先按可用核心数设并行度，例如 8 核从最多 8 个 worker 测起；单进程若约 300MB，8 个约 2.4GB，但须额外预留系统、API、缓冲和内存峰值，不能按理论内存上限开满。线程创建和内存开销通常较小，进程池可摊销启动成本；实际选型还须确认语言运行时的并行限制及库的线程安全。通过崩溃注入观察其他任务是否存活，检查失败任务、队列积压、重试和重复写入，再比较吞吐、尾延迟与内存峰值。简历只提到练习队列的输入校验，以上为假设方案，不声称已经实现。',
  })
  assert.equal(session.status, 'completed')
  const started = Date.now()
  const report = await service.generateReport(session.id)
  assert.equal(report.evaluations.length, 1)
  assert.ok(report.evaluations[0]!.evidence.length)
  assert.ok(report.evaluations[0]!.assisted)
  assert.ok(report.answerJudgments?.length === 2)
  assert.ok(report.improvements.length <= 3)
  console.log(`完整报告通过：${report.evaluations.length} 题、${report.evaluations[0]!.evidence.length} 条原话证据，评分耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。`)
  assert.deepEqual(await service.generateReport(session.id), report)
  console.log('重复读取复用已保存报告，无额外评分调用。')
} finally {
  await rm(directory, { recursive: true, force: true })
  console.log('已删除临时模型设置与合成练习数据。')
}
