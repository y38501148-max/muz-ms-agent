import type { CompanyProfile, Difficulty, InterviewMode, RoleProfile, Topic } from '../shared/types'

export const topicLabels: Record<Topic, string> = {
  os: '操作系统', network: '计算机网络', database: '数据库', frontend: '前端工程', backend: '后端工程',
  'system-design': '系统设计', devops: '交付与运维', algorithms: '算法与数据结构', languages: '编程语言',
  'ai-agent': 'AI 与 Agent', projects: '项目深挖', behavior: '沟通与协作',
}
export const difficultyLabels: Record<Difficulty, string> = { easy: '简单', medium: '中等', hard: '困难' }
export const modeLabels: Record<InterviewMode, string> = { simulation: '正式模拟', coaching: '辅导练习' }

export const roleProfiles: RoleProfile[] = [
  { id: 'backend', title: '后端开发', subtitle: '接口、数据、并发与服务可靠性', icon: 'server', topics: ['backend', 'database', 'network', 'os', 'system-design', 'languages', 'algorithms', 'projects', 'behavior'] },
  { id: 'frontend', title: '前端开发', subtitle: '交互、状态、浏览器与工程实践', icon: 'panels-top-left', topics: ['frontend', 'network', 'languages', 'algorithms', 'projects', 'behavior'] },
  { id: 'fullstack', title: '全栈开发', subtitle: '从界面到接口，交付完整功能', icon: 'layers', topics: ['frontend', 'backend', 'database', 'network', 'system-design', 'devops', 'languages', 'algorithms', 'projects', 'behavior'] },
  { id: 'platform', title: '平台与基础设施', subtitle: '部署、可观测性与资源管理', icon: 'cloud', topics: ['devops', 'os', 'network', 'database', 'system-design', 'backend', 'algorithms', 'projects', 'behavior'] },
  { id: 'cpp', title: 'C / C++ 开发', subtitle: '资源管理、并发与程序性能', icon: 'terminal', topics: ['languages', 'os', 'network', 'algorithms', 'system-design', 'projects', 'behavior'] },
  { id: 'ai', title: 'AI 应用与 Agent', subtitle: '检索、工具调用、评估与应用集成', icon: 'sparkles', topics: ['ai-agent', 'backend', 'database', 'system-design', 'devops', 'languages', 'algorithms', 'projects', 'behavior'] },
]

export const companyProfiles: CompanyProfile[] = [
  { id: 'general', name: '通用岗位面试', kind: 'generic', description: '按所选岗位考察基础理解与实际应用，不代表任何公司的真实面试。', emphasis: [], scenario: null },
  { id: 'demo-learning', name: '知阶学习 · 虚构公司', kind: 'fictional', description: '用于练习的在线学习产品场景，关注交互体验、学习进度与内容服务。', emphasis: ['frontend', 'backend', 'database', 'projects'], scenario: '虚构在线学习平台：课程列表、学习进度、视频观看与作业提交。把题目放进该业务背景，所有设计条件均为模拟，不宣称是真实公司题目。' },
  { id: 'demo-cloud', name: '云栈科技 · 虚构公司', kind: 'fictional', description: '用于练习的开发者云平台场景，关注任务调度、可靠性和可观测性。', emphasis: ['devops', 'system-design', 'network', 'os'], scenario: '虚构开发者云平台：用户提交构建任务，工作节点执行并存储产物。关注权限、资源约束、失败恢复与成本，业务设定为原创模拟。' },
  { id: 'custom', name: '自定义公司 / JD', kind: 'generic', description: '填写目标公司和岗位描述后调整考察重点；输入内容仅作为用户提供的背景，不视为已核实的招聘事实。', emphasis: [], scenario: null },
]
