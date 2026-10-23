import type { Topic } from '../shared/types'

export interface ExperienceSource {
  title: string
  url: string
  /** Exact publication date only. Null when the page exposes only an edit date or month/day. */
  publishedAt: string | null
  kind: 'self-report' | 'interviewer-report'
}

export interface ExperiencePattern {
  id: string
  title: string
  roles: string[]
  topics: Topic[]
  guidance: string[]
  sources: ExperienceSource[]
}

// Public first-person recollections, read on 2026-10-24; events and identities are not independently verified.
// These are original behavioral suggestions, not company requirements, technical answer keys, or scoring facts.
const sources: Record<string, ExperienceSource> = {
  backend: {
    title: '26届秋招字节后端二+三面速通面经详细版（附timeline）',
    url: 'https://ac.nowcoder.com/discuss/1554249?type=0',
    publishedAt: null, // Page shows “edited 2025-10-09”, not an independently confirmed first-published date.
    kind: 'self-report',
  },
  cpp: {
    title: '暑期实习记录（附c++面经）',
    url: 'https://ac.nowcoder.com/discuss/1500141?type=0',
    publishedAt: null, // Page shows “edited 2025-04-28”.
    kind: 'self-report',
  },
  frontendMulti: {
    title: '前端网易、字节、京东一面面经（大二下实习投递经历）',
    url: 'https://www.nowcoder.com/discuss/762390659880734720',
    publishedAt: '2025-06-11',
    kind: 'self-report',
  },
  frontendPractice: {
    title: '补一些前端实习面经',
    url: 'https://www.nowcoder.com/discuss/759826683523239936',
    publishedAt: '2025-06-04',
    kind: 'self-report',
  },
  frontendProject: {
    title: '字节前端实习二面',
    url: 'https://www.codefather.cn/post/1935618977407737858',
    publishedAt: '2025-06-19',
    kind: 'self-report',
  },
  ai: {
    title: '阿里Agent开发岗暑期实习面经（挂）',
    url: 'https://www.nowcoder.com/feed/main/detail/3181217280144ee0ab47fe979dc28ff1',
    publishedAt: null, // The page displays “08-05 17:48”; no publication year is shown.
    kind: 'self-report',
  },
  fullstack: {
    title: '满帮集团 27届全栈开发工程师一面面经',
    url: 'https://www.nowcoder.com/discuss/931583620966281216',
    publishedAt: null, // The page displays “09-21 16:20”; graduation cohort does not prove publication year.
    kind: 'self-report',
  },
}

const allRoles = ['backend', 'frontend', 'fullstack', 'platform', 'cpp', 'ai']

export const experiencePatterns: ExperiencePattern[] = [
  {
    id: 'project-request-chain',
    title: '沿一条真实业务链路展开项目',
    roles: allRoles,
    topics: ['projects', 'backend', 'system-design'],
    guidance: [
      '候选人介绍项目后，选其明确提到的一项用户操作，请其说明输入、经过的模块、输出以及本人负责的位置。',
      '沿上一回答只追一个上下游接口或状态变化；未提供模块细节时先澄清，不能替候选人补出实现。',
      '出现“优化”“可靠”等主张时，询问原始问题、所做修改和验证证据；没有测量时接受如实说明，不编造指标。',
    ],
    sources: [sources.backend!, sources.fullstack!],
  },
  {
    id: 'resume-claim-to-code',
    title: '把简历能力落到可解释的实现',
    roles: allRoles,
    topics: ['projects', 'languages', 'ai-agent'],
    guidance: [
      '从候选人主动声称实现的一个功能切入，询问具体输入输出、关键步骤及其亲自修改的部分。',
      '若回答停留在库名或功能名，邀请其解释一段伪代码或一个边界；无需展示私有代码，也不预设其没有参与。',
      '功能尚未完成、由模板或 AI 辅助的部分允许重新澄清贡献边界，后续只围绕已确认内容提问。',
    ],
    sources: [sources.frontendProject!, sources.frontendPractice!],
  },
  {
    id: 'frontend-observable-interaction',
    title: '前端从解释转入可观察的交互',
    roles: ['frontend', 'fullstack'],
    topics: ['frontend', 'languages', 'network'],
    guidance: [
      '概念回答后改问一个短小的执行顺序、状态变化或界面交互，让候选人说明浏览器中会出现什么。',
      '对同一交互只改变一个条件，如快速重复操作、请求乱序或组件离开页面，再询问预期与处理方式。',
      '实现讨论先明确输入、状态和可验证行为；文字环境可以用伪代码解释，并标明尚未实际运行验证。',
    ],
    sources: [sources.frontendMulti!, sources.frontendPractice!],
  },
  {
    id: 'backend-component-boundary',
    title: '后端从组件选择追到系统边界',
    roles: ['backend', 'fullstack', 'ai'],
    topics: ['backend', 'database', 'network', 'system-design'],
    guidance: [
      '针对候选人实际提及的数据库、线程池、缓存或权限方案，先问它解决的具体限制与选择依据。',
      '解释清楚后只增加一个失败条件，例如重复请求或部分写入，追问影响范围、状态与恢复方法。',
      '项目没有使用该组件时改成明确标注的假设场景，不将假设方案记录为个人履历。',
    ],
    sources: [sources.fullstack!, sources.backend!],
  },
  {
    id: 'cpp-mechanism-to-execution',
    title: 'C++ 将机制连接到执行与约束',
    roles: ['cpp', 'backend', 'platform'],
    topics: ['languages', 'os', 'algorithms'],
    guidance: [
      '候选人解释资源或并发机制后，要求在一个小范围实现中说明所有者、状态变化与退出路径。',
      '结合当前实现询问一个边界，如空输入、容量已满或工作线程退出，避免无关语言冷知识连续跳题。',
      '提到性能改善时先确认数据规模、测量方式与目标，不能从采用某语言或容器直接推断更快。',
    ],
    sources: [sources.cpp!],
  },
  {
    id: 'algorithm-explain-and-vary',
    title: '算法追问围绕推理和小幅变式',
    roles: allRoles,
    topics: ['algorithms'],
    guidance: [
      '先确认题意和一个可行基线，再询问不变量、关键步骤或复杂度，使推理过程能够被核对。',
      '完成后仅改变一个条件，如输出格式或资源上限，请其解释原方法哪些部分仍成立，而非突然更换知识领域。',
      '卡住时先让候选人澄清困难或尝试样例；辅导提示必须记录为辅助，不将提示后的实现算作独立完成。',
    ],
    sources: [sources.backend!, sources.cpp!],
  },
  {
    id: 'agent-one-request-lifecycle',
    title: 'Agent 项目追一条完整执行过程',
    roles: ['ai', 'fullstack', 'backend'],
    topics: ['ai-agent', 'projects', 'system-design'],
    guidance: [
      '围绕候选人的一个具体请求，追踪上下文如何进入、如何检索或调用工具、结果如何返回，先定位其亲自实现的环节。',
      '提到框架后询问实际采用的能力和选择依据；不把会报框架名等同于理解执行流程。',
      '选一个和前述流程相关的变化，如多会话、工具异常或输入增大，请其说明状态边界和验证方式。',
      '面经只用于选择追问角度；技术正确性仍以当前题目要点和可核对资料判断，不能把原帖答案作为事实。',
    ],
    sources: [sources.ai!, sources.frontendProject!],
  },
  {
    id: 'bounded-adaptive-interview',
    title: '按回答调整分支与时间',
    roles: allRoles,
    topics: ['projects', 'behavior', 'algorithms'],
    guidance: [
      '开场说明当前练习范围与时间，自我介绍较长时温和收束到一项相关经历，给后续作答留下时间。',
      '项目、基础与实现题之间根据已知经历切换，不声称某公司某轮必有固定顺序，也不以轮次自动推定难度。',
      '对明确不会的回答最多做一次澄清或缩小范围，再换分支；语气保持尊重，不能用面试官友善程度推断录取结果。',
    ],
    sources: [sources.frontendProject!, sources.frontendMulti!, sources.backend!],
  },
  {
    id: 'collaboration-evidence',
    title: '协作问题追具体行动与决策依据',
    roles: allRoles,
    topics: ['behavior', 'projects'],
    guidance: [
      '在技术经历后选择一次具体分歧或受挫事件，分别澄清当时限制、本人行动和后续变化。',
      '意见不被采纳时询问对方依据、决定方式及下一步工作，允许承认判断改变，避免逼迫候选人证明自己总是正确。',
      '没有对应经历时允许明确以假设场景作答；只评价已给出的行动与推理，不从性格、措辞熟练度推定协作能力。',
    ],
    sources: [sources.fullstack!],
  },
]
