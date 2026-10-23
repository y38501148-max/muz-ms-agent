import { z } from 'zod'

export const topicSchema = z.enum(['os', 'network', 'database', 'frontend', 'backend', 'system-design', 'devops', 'algorithms', 'languages', 'ai-agent', 'projects', 'behavior'])
export const modeSchema = z.enum(['simulation', 'coaching'])
export const configSchema = z.object({
  roleId: z.string().min(1).max(100),
  companyId: z.string().min(1).max(100),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  mode: modeSchema,
  engine: z.enum(['local', 'ai']),
  durationMinutes: z.number().int().min(5).max(90),
  maxQuestions: z.number().int().min(1).max(12),
  topics: z.array(topicSchema).max(12),
  candidateContext: z.string().max(12000),
  customCompanyName: z.string().max(120),
  customJobDescription: z.string().max(16000),
  resumeText: z.string().max(20000).default(''),
  resumeFileName: z.string().max(200).default(''),
}).strict()

export const createSessionSchema = configSchema.extend({ questionIds: z.array(z.string().min(1).max(100)).min(1).max(12).optional() })
export const turnSchema = z.object({
  action: z.enum(['answer', 'hint', 'skip', 'pause', 'resume', 'end', 'switch-mode']),
  text: z.string().max(16000).optional(),
  mode: modeSchema.optional(),
  version: z.number().int().positive(),
}).strict()

export const settingsSchema = z.object({
  protocol: z.enum(['responses', 'chat-completions', 'anthropic']),
  baseUrl: z.url().max(2000).refine((value) => {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  }, 'API 地址必须为不含账号、查询参数和片段的 HTTP(S) 地址。'),
  model: z.string().trim().min(1).max(150),
  apiKey: z.string().max(2000).optional(),
  clearApiKey: z.boolean().optional(),
}).strict()

export type TurnInput = z.infer<typeof turnSchema>
