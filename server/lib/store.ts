import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AnswerJudgment, InterviewReport, InterviewSession, ProviderSettings, Question } from '../../shared/types'

export interface Database {
  sessions: Record<string, InterviewSession>
  reports: Record<string, InterviewReport>
  questionSnapshots?: Record<string, Question[]>
  answerJudgments?: Record<string, AnswerJudgment[]>
  settings?: ProviderSettings
}

/** One process owns the local store; transactions include provider calls to avoid lost turns. */
export class JsonStore {
  private queue: Promise<unknown> = Promise.resolve()
  readonly directory: string

  constructor(directory = process.env.MUZ_DATA_DIR || resolve(process.cwd(), '.data')) {
    this.directory = directory
  }

  private async load(): Promise<Database> {
    try {
      return JSON.parse(await readFile(join(this.directory, 'store.json'), 'utf8')) as Database
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: {}, reports: {} }
      throw new Error('本地数据无法读取，请保留 .data 文件后检查磁盘与文件格式。')
    }
  }

  async read<T>(reader: (db: Database) => T): Promise<T> {
    await this.queue.catch(() => {})
    return reader(await this.load())
  }

  async transaction<T>(operation: (db: Database) => T | Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(async () => {
      const db = await this.load()
      const result = await operation(db)
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = join(this.directory, `store-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(db, null, 2), { mode: 0o600 })
      await rename(temporary, join(this.directory, 'store.json'))
      return result
    })
    this.queue = run
    return run
  }
}

export const store = new JsonStore()
