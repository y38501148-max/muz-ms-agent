<script setup lang="ts">
import { ArrowRightOutlined, CheckOutlined, SlidersOutlined, PlusOutlined, ThunderboltOutlined, UploadOutlined, FileTextOutlined, DeleteOutlined } from '@ant-design/icons-vue'
import type { SessionConfig, InterviewSession, SessionSummary, Topic } from '../../shared/types'

const { data: catalog } = await useCatalog()
const { data: sessions } = await useFetch<SessionSummary[]>('/api/sessions', { key: 'home-sessions' })
const setupDraft = useState<SessionConfig>('interview-config-draft', () => ({
  roleId: 'backend', companyId: 'general', difficulty: 'medium', mode: 'coaching', engine: 'ai',
  durationMinutes: 15, maxQuestions: 5, topics: [], candidateContext: '', customCompanyName: '', customJobDescription: '', resumeText: '', resumeFileName: '',
}))
const form = setupDraft.value
const roles = computed(() => catalog.value?.roleProfiles || [])
const role = computed(() => roles.value.find(item => item.id === form.roleId))
const company = computed(() => catalog.value?.companyProfiles.find(item => item.id === form.companyId))
const topicEntries = computed(() => Object.entries(catalog.value?.topicLabels || {}) as [Topic, string][])
const topicLabel = (topic: Topic) => catalog.value?.topicLabels[topic] || topic
const available = computed(() => catalog.value?.questions.filter(q => q.roles.includes(form.roleId) && (!form.topics.length || form.topics.includes(q.topic))) || [])
const activeSession = computed(() => sessions.value?.find(s => s.status !== 'completed'))
const showContext = ref(false)
const submitting = ref(false)
const resumeImporting = ref(false)
const resumeError = ref('')
const showResume = ref(false)
const error = ref('')
const difficulties = [
  { value: 'easy', label: '简单', name: '引导型', bars: 1, description: '基础理解 · 明确条件' },
  { value: 'medium', label: '中等', name: '求证型', bars: 2, description: '应用分析 · 解释依据' },
  { value: 'hard', label: '困难', name: '挑战型', bars: 3, description: '边界约束 · 工程取舍' },
] as const
const selectedTopics = computed(() => form.topics.length ? form.topics : role.value?.topics || [])
const selectedCount = computed(() => Math.min(form.maxQuestions, new Set(available.value.map(q => q.familyId)).size))

watch(() => form.roleId, (_roleId, previousRoleId) => { if (previousRoleId === undefined && form.topics.length) return; form.topics = [...(role.value?.topics || [])] }, { immediate: true })
function toggleTopic(topic: Topic) {
  form.topics = form.topics.includes(topic) ? form.topics.filter(t => t !== topic) : [...form.topics, topic]
}
async function importResume(file: File) {
  resumeError.value = ''
  if (file.size > 5 * 1024 * 1024) { resumeError.value = '简历文件不能超过 5 MB。'; return false }
  resumeImporting.value = true
  try {
    const body = new FormData(); body.append('file', file)
    const result = await $fetch<{ fileName: string; text: string }>('/api/resume/parse', { method: 'POST', body })
    form.resumeText = result.text; form.resumeFileName = result.fileName; showResume.value = true
  } catch (e) { resumeError.value = readableError(e) }
  finally { resumeImporting.value = false }
  return false
}
function clearResume() { form.resumeText = ''; form.resumeFileName = ''; showResume.value = false; resumeError.value = '' }
async function start() {
  if (resumeImporting.value) return
  if (!form.topics.length) { error.value = '请选择至少一个考点。'; return }
  if (!available.value.length) { error.value = '当前方向和考点没有可用题目，请调整选择。'; return }
  if (form.engine === 'ai' && !catalog.value?.provider.configured) { await navigateTo('/settings'); return }
  if (form.companyId === 'custom' && (!form.customCompanyName.trim() || !form.customJobDescription.trim())) { error.value = '请填写目标公司和岗位描述。'; return }
  submitting.value = true
  error.value = ''
  try {
    const session = await $fetch<InterviewSession>('/api/sessions', { method: 'POST', body: form })
    await navigateTo(`/session/${session.id}`)
  } catch (e) { error.value = readableError(e) }
  finally { submitting.value = false }
}
</script>

<template>
  <div class="page home-page">
    <div class="page-heading">
      <div><h1>开始面试练习</h1><p class="page-description">选择知识范围，由 AI 出题、追问并判断回答。</p></div>
      <NuxtLink to="/sessions" class="text-link">练习记录 <ArrowRightOutlined /></NuxtLink>
    </div>
    <div v-if="activeSession" class="resume-banner">
      <div><span class="tiny-dot" /><strong>有一场未完成的练习</strong><span class="muted">已回答 {{ activeSession.answeredCount }} 题</span></div>
      <NuxtLink :to="`/session/${activeSession.id}`">继续练习 <ArrowRightOutlined /></NuxtLink>
    </div>
    <div class="setup-layout">
      <form class="setup-form panel configuration-panel" @submit.prevent="start">
        <section class="config-group">
          <div class="section-heading"><h2>面试方向</h2><span class="section-meta">实习 / 初级</span></div>
          <div class="role-grid" role="group" aria-label="面试方向">
            <button v-for="item in roles" :key="item.id" type="button" class="role-card" :class="{ selected: form.roleId === item.id }" :aria-pressed="form.roleId === item.id" @click="form.roleId = item.id">
              <span class="role-icon"><AppIcon :name="item.id" /></span><span class="role-copy"><strong>{{ item.title }}</strong></span><CheckOutlined v-if="form.roleId === item.id" class="selection-check" />
            </button>
          </div>
          <div class="field-block company-field">
            <label for="company-select">目标公司 / 业务场景</label>
            <a-select id="company-select" v-model:value="form.companyId" :options="catalog?.companyProfiles.map(c => ({ value: c.id, label: c.name }))" class="full-width" />
            <p v-if="company?.kind === 'fictional'" class="field-help">{{ company.description }} · 虚构场景</p>
          </div>
          <div v-if="form.companyId === 'custom'" class="custom-company-fields">
            <div class="field-block"><label for="company-name">公司名称</label><a-input id="company-name" v-model:value="form.customCompanyName" :maxlength="100" placeholder="输入目标公司" /></div>
            <div class="field-block"><label for="job-description">岗位描述</label><a-textarea id="job-description" v-model:value="form.customJobDescription" :rows="3" :maxlength="8000" placeholder="粘贴岗位职责、要求与业务背景" /></div>
          </div>
        </section>
        <section class="config-group">
          <div class="section-heading"><h2>难度与练习方式</h2></div>
          <div class="difficulty-grid" role="group" aria-label="面试难度">
            <button v-for="item in difficulties" :key="item.value" type="button" class="difficulty-card" :class="{ selected: form.difficulty === item.value }" :aria-pressed="form.difficulty === item.value" @click="form.difficulty = item.value">
              <span class="difficulty-top"><span class="difficulty-bars" aria-hidden="true"><i v-for="n in 3" :key="n" :class="{ filled: n <= item.bars }" /></span><CheckOutlined v-if="form.difficulty === item.value" /></span>
              <strong>{{ item.label }}<span>{{ item.name }}</span></strong><small>{{ item.description }}</small>
            </button>
          </div>
          <div class="two-fields">
            <div class="field-block"><label for="engine-select">出题方式</label><a-select id="engine-select" v-model:value="form.engine" :options="[{ value: 'ai', label: 'AI 自主出题' }, { value: 'local', label: '固定题卡练习' }]" class="full-width" /></div>
            <div class="field-block"><label for="mode-select">反馈方式</label><a-select id="mode-select" v-model:value="form.mode" :options="[{ value: 'coaching', label: '辅导 · 逐次判断回答' }, { value: 'simulation', label: '模拟 · 结束后反馈' }]" class="full-width" /></div>
            <div class="field-block"><label for="duration-select">预计时长</label><a-select id="duration-select" v-model:value="form.durationMinutes" :options="[15, 30, 45].map(n => ({ value: n, label: `${n} 分钟` }))" class="full-width" /></div>
            <div class="field-block"><label for="count-select">主问题数量</label><a-select id="count-select" v-model:value="form.maxQuestions" :options="[3, 5, 8].map(n => ({ value: n, label: `${n} 题` }))" class="full-width" /></div>
          </div>
        </section>
        <section class="config-group resume-section">
          <div class="section-heading"><h2>简历上下文</h2><span class="section-meta">可选 · 开始时注入首轮</span></div>
          <div class="resume-upload-actions"><a-upload accept=".pdf,.docx,.txt,.md" :max-count="1" :before-upload="importResume" :show-upload-list="false" :disabled="resumeImporting || submitting"><span class="resume-upload-trigger" :class="{ disabled: resumeImporting || submitting }"><a-spin v-if="resumeImporting" size="small" /><UploadOutlined v-else />{{ resumeImporting ? '正在解析简历' : '导入简历' }}</span></a-upload><a-button type="text" :disabled="resumeImporting || submitting" @click="showResume = !showResume">{{ showResume ? '收起文本' : '直接粘贴或编辑' }}</a-button></div>
          <p class="field-help resume-import-help">PDF / DOCX / TXT / Markdown，最大 5 MB。导入时仅在本机解析；开始 AI 面试时将预览文本发送给所配置的模型。</p>
          <div v-if="form.resumeFileName" class="resume-file"><FileTextOutlined /><strong>{{ form.resumeFileName }}</strong><span>{{ form.resumeText?.length || 0 }} 字</span><a-button type="text" size="small" aria-label="移除导入的简历" @click="clearResume"><DeleteOutlined /></a-button></div>
          <div v-if="showResume" class="field-block resume-preview"><label for="resume-preview">检查简历文本</label><a-textarea id="resume-preview" v-model:value="form.resumeText" :rows="6" :maxlength="20000" :disabled="resumeImporting || submitting" placeholder="粘贴简历，或在导入后检查项目、职责和段落顺序。" /><p class="field-help">可删除不希望发送的个人信息。文本随本场会话保存，后续追问沿用这一份上下文。</p></div>
          <p v-if="resumeError" class="error-message resume-error" role="alert">{{ resumeError }}</p>
        </section>
        <section class="config-group">
          <div class="section-heading"><h2>知识范围</h2><span class="section-meta">已选 {{ form.topics.length }} 项</span></div>
          <div class="topic-options" role="group" aria-label="考点">
            <button v-for="[key, label] in topicEntries" :key="key" type="button" class="topic-chip" :class="{ selected: form.topics.includes(key) }" :aria-pressed="form.topics.includes(key)" @click="toggleTopic(key)"><CheckOutlined v-if="form.topics.includes(key)" />{{ label }}</button>
          </div>
          <button type="button" class="context-toggle" :aria-expanded="showContext" @click="showContext = !showContext"><PlusOutlined v-if="!showContext" /><SlidersOutlined v-else />补充项目与经历<span class="muted">可选</span></button>
          <div v-if="showContext" class="field-block context-field"><label for="candidate-context">项目背景与重点练习内容</label><a-textarea id="candidate-context" v-model:value="form.candidateContext" :rows="4" :maxlength="10000" placeholder="项目职责、技术选择，或希望练习的薄弱点" /><p class="field-help">AI 模式会将这些内容发送给你配置的模型服务。</p></div>
        </section>
        <button class="sr-only" type="submit">开始面试</button>
      </form>
      <aside class="setup-aside">
        <section class="panel start-panel">
          <div class="start-panel-icon"><ThunderboltOutlined /></div>
          <h2>{{ form.engine === 'ai' ? 'AI 面试官' : '固定题卡练习' }}</h2>
          <p class="start-panel-description">{{ form.engine === 'ai' ? '依据知识点生成本场问题，根据你的回答继续追问。' : '按题卡提问，结束后对照参考答案。' }}</p>
          <dl class="session-plan"><div><dt>方向</dt><dd>{{ role?.title }}</dd></div><div><dt>难度</dt><dd>{{ difficulties.find(d => d.value === form.difficulty)?.label }}</dd></div><div><dt>安排</dt><dd>{{ selectedCount }} 题 · {{ form.durationMinutes }} 分钟</dd></div><div v-if="form.resumeText?.trim()"><dt>简历</dt><dd>已载入 {{ form.resumeText.length }} 字</dd></div><div><dt>反馈</dt><dd>{{ form.mode === 'coaching' ? '逐次判断回答' : '结束后复盘' }}</dd></div></dl>
          <a-button type="primary" size="large" block :loading="submitting" :disabled="!available.length || resumeImporting" @click="start">{{ submitting ? '正在准备面试…' : form.engine === 'ai' && !catalog?.provider.configured ? '配置模型' : '开始面试' }} <ArrowRightOutlined v-if="!submitting" /></a-button>
          <p class="start-panel-note">{{ form.engine === 'ai' ? '问题与回答会发送到所配置的模型，调用可能产生费用。' : '固定题卡模式不判断回答正误。' }}</p>
          <p v-if="error" class="error-message" role="alert">{{ error }}</p>
        </section>
        <section class="panel knowledge-summary"><div class="section-heading"><h3>知识依据</h3><NuxtLink to="/questions">浏览 <ArrowRightOutlined /></NuxtLink></div><div class="inline-tags"><span v-for="topic in selectedTopics" :key="topic" class="subtle-tag">{{ topicLabel(topic) }}</span></div><p>{{ available.length }} 张知识题卡支持本场出题</p></section>
      </aside>
    </div>
  </div>
</template>
