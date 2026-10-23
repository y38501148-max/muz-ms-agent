export type Difficulty = 'easy' | 'medium' | 'hard'
export type InterviewMode = 'simulation' | 'coaching'
export type Engine = 'local' | 'ai'
export type Topic = 'os' | 'network' | 'database' | 'frontend' | 'backend' | 'system-design' | 'devops' | 'algorithms' | 'languages' | 'ai-agent' | 'projects' | 'behavior'
export type Dimension = 'correctness' | 'reasoning' | 'application' | 'validation' | 'communication'
export type AnswerVerdict = 'correct' | 'partial' | 'incorrect' | 'insufficient'

export interface AnswerJudgment {
  answerTurnId: string
  questionId: string
  verdict: AnswerVerdict
  explanation: string
  evidence: { turnId: string; quote: string; pointId: string; observation: string }[]
  assisted: boolean
  createdAt: string
}

export interface Question {
  id: string
  familyId: string
  version: number
  title: string
  topic: Topic
  tags: string[]
  roles: string[]
  origin: 'generated' | 'adapted' | 'reported'
  review: 'assistant_checked' | 'draft'
  variants: Record<Difficulty, { stem: string; expectedPointIds: string[] }>
  points: { id: string; text: string }[]
  followups: { id: string; prompt: string; targetPointIds: string[] }[]
  hints: string[]
  pitfalls: string[]
  referenceAnswer: string
  sources: { title: string; url: string; type: 'official' | 'opensource' | 'editorial' }[]
  generation?: {
    kind: 'ai-authored'
    knowledgeCardId: string
    knowledgeCardVersion: number
    knowledgePoints: { id: string; text: string }[]
    sourceIds: string[]
    experiencePatternIds?: string[]
    generatedAt: string
  }
}

export interface RoleProfile {
  id: string
  title: string
  subtitle: string
  icon: string
  topics: Topic[]
}
export interface CompanyProfile {
  id: string
  name: string
  kind: 'generic' | 'fictional'
  description: string
  emphasis: Topic[]
  scenario: string | null
}

export interface SessionConfig {
  roleId: string
  companyId: string
  difficulty: Difficulty
  mode: InterviewMode
  engine: Engine
  durationMinutes: number
  maxQuestions: number
  topics: Topic[]
  candidateContext: string
  customCompanyName: string
  customJobDescription: string
  resumeText?: string
  resumeFileName?: string
}

export interface Turn {
  id: string
  role: 'interviewer' | 'candidate'
  text: string
  questionId: string | null
  kind: 'opening' | 'question' | 'answer' | 'followup' | 'hint' | 'teaching' | 'clarification' | 'control' | 'closing' | 'feedback'
  assisted: boolean
  timestamp: string
  feedback?: AnswerJudgment
}

export interface InterviewSession {
  id: string
  version: number
  createdAt: string
  updatedAt: string
  status: 'active' | 'paused' | 'completed'
  config: SessionConfig
  questionIds: string[]
  currentQuestionIndex: number
  followupsUsed: number
  hintsUsed: number
  assistanceStarted: boolean
  turns: Turn[]
  coverageNotice: string | null
  questionStrategy?: 'fixed-cards' | 'knowledge-generated'
  answerJudgments?: AnswerJudgment[]
}

export interface QuestionEvaluation {
  questionId: string
  independent: Record<Dimension, number | null>
  assisted: Record<Dimension, number | null> | null
  evidence: { turnId: string; quote: string; pointId: string; observation: string }[]
  strengths: string[]
  gaps: string[]
  confidence: 'high' | 'medium' | 'low'
}
export interface InterviewReport {
  sessionId: string
  createdAt: string
  engine: Engine
  summary: string
  evaluations: QuestionEvaluation[]
  improvements: { title: string; exercise: string; acceptance: string }[]
  retestQuestionIds: string[]
  limitation: string
  answerJudgments?: AnswerJudgment[]
}

export interface ProviderSettings {
  protocol: 'responses' | 'chat-completions' | 'anthropic'
  baseUrl: string
  model: string
  apiKey: string
}
export interface PublicProviderSettings extends Omit<ProviderSettings, 'apiKey'> {
  hasApiKey: boolean
  configured: boolean
}

export interface SessionSummary {
  id: string
  createdAt: string
  updatedAt: string
  status: InterviewSession['status']
  config: SessionConfig
  answeredCount: number
  questionCount: number
  hasReport: boolean
}

export type SessionAction = 'answer' | 'hint' | 'skip' | 'pause' | 'resume' | 'end' | 'switch-mode'

export interface PublicQuestion extends Omit<Question, 'points' | 'followups' | 'hints' | 'pitfalls' | 'referenceAnswer' | 'sources' | 'variants' | 'generation'> {
  variants: Record<Difficulty, { stem: string }>
}
export interface Catalog {
  questions: PublicQuestion[]
  roleProfiles: RoleProfile[]
  companyProfiles: CompanyProfile[]
  topicLabels: Record<Topic, string>
  provider: PublicProviderSettings
}
