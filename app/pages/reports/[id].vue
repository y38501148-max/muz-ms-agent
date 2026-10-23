<script setup lang="ts">
import { ArrowLeftOutlined, DownloadOutlined, ReloadOutlined, ArrowRightOutlined, CheckCircleOutlined } from '@ant-design/icons-vue'
import type { Dimension, InterviewReport, InterviewSession, Question, AnswerVerdict } from '../../../shared/types'

const verdictLabels: Record<AnswerVerdict, string> = { correct: '回答正确', partial: '部分正确', incorrect: '回答有误', insufficient: '信息不足' }
const route = useRoute()
const { data: catalog } = await useCatalog()
const { data: session, error: sessionError } = await useFetch<InterviewSession>(`/api/sessions/${route.params.id}`, { key: `report-session-${route.params.id}` })
const report = ref<InterviewReport | null>(null)
const cards = ref<Question[]>([])
const loading = ref(true)
const error = ref('')
const retesting = ref(false)
const quickJudgments = computed(() => report.value?.answerJudgments ?? session.value?.answerJudgments ?? [])
const role = computed(() => catalog.value?.roleProfiles.find(r => r.id === session.value?.config.roleId))
const dimensions: { key: Dimension; label: string; weight: number }[] = [
  { key: 'correctness', label: '正确性', weight: .35 }, { key: 'reasoning', label: '推理与解释', weight: .25 },
  { key: 'application', label: '工程应用', weight: .2 }, { key: 'validation', label: '验证与取舍', weight: .1 },
  { key: 'communication', label: '表达清晰度', weight: .1 },
]
const answerTurns = computed(() => session.value?.turns.filter(t => t.role === 'candidate' && t.kind === 'answer') || [])
const answeredCount = computed(() => new Set(answerTurns.value.map(t => t.questionId)).size)
const hintsCount = computed(() => session.value?.turns.filter(t => t.kind === 'hint' || t.kind === 'teaching').length || 0)
const coveredTopics = computed(() => [...new Set(answerTurns.value.map(t => catalog.value?.questions.find(q => q.id === t.questionId)?.topic).filter((t): t is NonNullable<typeof t> => Boolean(t)))])
const modeChanged = computed(() => session.value?.turns.some(t => t.kind === 'control' && t.text.startsWith('模式已切换')))
const independentMeans = computed(() => dimensions.map(d => {
  const values = report.value?.evaluations.map(e => e.independent[d.key]).filter((v): v is number => v !== null) || []
  return { ...d, value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, count: values.length }
}))

async function loadReport() {
  if (!session.value || session.value.status !== 'completed') { loading.value = false; return }
  loading.value = true; error.value = ''
  try {
    const askedIds = [...new Set(session.value.turns.filter(t => t.kind === 'question').map(t => t.questionId).filter((id): id is string => Boolean(id)))]
    const snapshots = await $fetch<Question[]>(`/api/sessions/${session.value.id}/questions`)
    cards.value = snapshots.filter(card => askedIds.includes(card.id))
    try { report.value = await $fetch<InterviewReport>(`/api/sessions/${session.value.id}/report`) }
    catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e
      report.value = await $fetch<InterviewReport>(`/api/sessions/${session.value.id}/report`, { method: 'POST' })
    }

  } catch (e) { error.value = readableError(e) }
  finally { loading.value = false }
}
async function retest() {
  if (!session.value || !report.value || retesting.value) return
  retesting.value = true; error.value = ''
  try {
    const ids = report.value.retestQuestionIds
    const created = await $fetch<InterviewSession>('/api/sessions', { method: 'POST', body: { ...session.value.config, maxQuestions: ids.length || session.value.config.maxQuestions, ...(ids.length ? { questionIds: ids } : {}) } })
    await navigateTo(`/session/${created.id}`)
  } catch (e) { error.value = readableError(e) }
  finally { retesting.value = false }
}
function exportMarkdown() {
  if (!session.value || !report.value) return
  const s = session.value, r = report.value
  const text = [
    `# ${role.value?.title || '面试'}练习复盘`, `\n日期：${formatDate(r.createdAt)}`, `\n引擎：${r.engine === 'ai' ? 'AI 面试' : '本地脚本练习'}`, `\n${r.summary}`, `\n${r.limitation}`,
    '\n## 逐题记录', ...cards.value.map(card => `\n### ${card.title}\n\n${s.turns.filter(t => t.questionId === card.id).map(t => `**${t.role === 'candidate' ? '我的回答' : '面试官'}${t.assisted ? '（辅助后）' : ''}**\n\n${t.text}`).join('\n\n')}\n\n**参考要点**\n\n${card.points.map(p => `- ${p.text}`).join('\n')}\n\n**参考回答**\n\n${card.referenceAnswer}\n\n${card.sources.map(src => `[${src.title}](${src.url})`).join(' · ')}`),
    '\n## 逐次回答判断', ...(r.answerJudgments || []).map(j => `\n### ${verdictLabels[j.verdict]}${j.assisted ? '（辅助后）' : '（独立作答）'}\n\n${j.explanation}\n\n${j.evidence.map(ev => `> ${ev.quote}`).join('\n')}`),
    '\n## 评分依据', ...r.evaluations.map(e => `\n### ${cards.value.find(c => c.id === e.questionId)?.title || e.questionId}\n\n独立：${JSON.stringify(e.independent)}\n\n辅助：${JSON.stringify(e.assisted)}\n\n${e.evidence.map(ev => `> ${ev.quote}\n\n${ev.turnId} · ${ev.observation}`).join('\n\n')}`),
    '\n## 后续练习', ...r.improvements.map(i => `\n### ${i.title}\n\n${i.exercise}\n\n验收：${i.acceptance}`),
  ].join('\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = `muz-ms-agent-${s.id.slice(0, 8)}.md`; a.click(); URL.revokeObjectURL(url)
}
onMounted(loadReport)
</script>

<template>
  <div class="page">
    <NuxtLink to="/sessions" class="page-back"><ArrowLeftOutlined />返回练习记录</NuxtLink>
    <div v-if="sessionError || !session" class="panel empty-state"><h2>未找到这场练习</h2><p>记录可能已删除。</p><AppLinkButton to="/sessions">查看练习记录</AppLinkButton></div>
    <div v-else-if="session.status !== 'completed'" class="panel empty-state"><h2>这场练习尚未结束</h2><p>结束面试后生成复盘。</p><AppLinkButton :to="`/session/${session.id}`" type="primary">继续练习</AppLinkButton></div>
    <template v-else>
      <div class="page-heading"><div><div class="eyebrow">面后复盘</div><h1>练习复盘</h1><p class="page-description">{{ role?.title }} · {{ formatDate(session.createdAt) }}</p></div><div class="report-heading-actions"><a-button :disabled="!report" @click="exportMarkdown"><DownloadOutlined />导出 Markdown</a-button></div></div>
      <section v-if="quickJudgments.length" class="panel report-section quick-judgments"><h2>逐次回答判断</h2><div class="judgment-list"><article v-for="(judgment, index) in quickJudgments" :key="judgment.answerTurnId" class="judgment-item"><div class="judgment-heading"><span class="verdict-label" :class="judgment.verdict">{{ verdictLabels[judgment.verdict] }}</span><span class="field-help">回答 {{ index + 1 }} · {{ judgment.assisted ? '辅助后作答' : '独立作答' }}</span></div><h3>{{ cards.find(c => c.id === judgment.questionId)?.title || catalog?.questions.find(c => c.id === judgment.questionId)?.title }}</h3><p>{{ judgment.explanation }}</p></article></div></section>
      <div v-if="loading" class="panel empty-state"><a-spin size="large" /><h2 style="margin-top: 22px">{{ session.config.engine === 'ai' ? '正在独立分析作答记录' : '正在整理练习记录' }}</h2><p style="margin-top: 10px">报告会保留独立与辅助后作答的区别。</p></div>
      <div v-else-if="error && !report" class="panel empty-state"><h2>完整维度复盘尚未生成</h2><p class="error-message" role="alert">{{ error }}</p><a-button type="primary" @click="loadReport"><ReloadOutlined />重新生成完整复盘</a-button></div>
      <template v-else-if="report">
        <p v-if="error" class="error-message" role="alert" style="margin-bottom: 20px">{{ error }}</p>
        <div class="report-layout">
          <div class="report-main">
            <section class="panel report-section"><div class="section-heading"><CheckCircleOutlined style="color: var(--primary)" /><h2 style="margin-bottom: 0">练习概览</h2><span class="section-meta">{{ report.engine === 'ai' ? 'AI 评分' : '本地练习 · 无能力评分' }}</span></div><p class="report-summary">{{ report.summary }}</p><div class="report-metrics"><div class="report-metric"><strong>{{ answeredCount }}</strong><span>已作答主问题</span></div><div class="report-metric"><strong>{{ coveredTopics.length }}</strong><span>已练习考点</span></div><div class="report-metric"><strong>{{ hintsCount }}</strong><span>内容提示次数</span></div></div></section>
            <section v-if="report.evaluations.length" class="panel report-section"><div class="section-heading"><h2 style="margin: 0">独立作答表现</h2></div><p v-if="modeChanged" class="field-help" style="margin-bottom: 18px">本场中途切换过模式，不合并总分；维度数据仅供本场逐题复盘参考。</p><div class="report-dimensions"><div v-for="d in independentMeans" :key="d.key" class="dimension-row"><span>{{ d.label }}</span><div class="progress-track"><span :style="{ width: `${d.value !== null ? d.value / 4 * 100 : 0}%` }" /></div><span class="dimension-score">{{ d.value !== null ? `${d.value.toFixed(1)}/4` : '未评估' }}</span></div></div></section>
            <section class="panel report-section"><h2>逐题复盘</h2><div v-if="!cards.length" class="field-help">本场没有展开题目。</div><article v-for="(card, index) in cards" :key="card.id" class="review-item"><div class="section-heading"><span class="step-number">{{ String(index + 1).padStart(2, '0') }}</span><h3 style="margin: 0">{{ card.title }}</h3><span class="section-meta">{{ catalog?.topicLabels[card.topic] }}</span></div>
              <template v-for="evaluation in report.evaluations.filter(e => e.questionId === card.id)" :key="evaluation.questionId"><p v-if="evaluation.strengths.length"><strong>已观察到：</strong>{{ evaluation.strengths.join('；') }}</p><p v-if="evaluation.gaps.length" style="margin-top: 8px"><strong>需要补充：</strong>{{ evaluation.gaps.join('；') }}</p><blockquote v-for="ev in evaluation.evidence" :key="`${ev.turnId}-${ev.pointId}`" class="evidence-quote">“{{ ev.quote }}”<cite>{{ ev.observation }} · 回答 {{ ev.turnId.slice(0, 8) }}</cite></blockquote><p class="field-help" style="margin-top: 12px">独立评分：{{ dimensions.map(d => `${d.label} ${evaluation.independent[d.key] ?? '—'}`).join(' / ') }}</p><p v-if="evaluation.assisted" class="field-help" style="margin-top: 8px">辅助评分：{{ dimensions.map(d => `${d.label} ${evaluation.assisted?.[d.key] ?? '—'}`).join(' / ') }}</p></template>
              <a-collapse ghost style="margin-top: 10px"><a-collapse-panel key="transcript" header="查看本题问答与辅助记录"><div class="records-transcript"><div v-for="t in session.turns.filter(t => t.questionId === card.id)" :key="t.id" class="record-turn"><strong>{{ t.role === 'candidate' ? '我的回答' : t.kind === 'hint' ? '内容提示' : '面试官' }}{{ t.assisted ? ' · 辅助后' : '' }}</strong><p>{{ t.text }}</p></div></div></a-collapse-panel><a-collapse-panel key="reference" header="参考要点与回答"><ul><li v-for="p in card.points" :key="p.id" style="font-size: 13px; line-height: 1.95; margin-bottom: 8px">{{ p.text }}</li></ul><div class="answer-reference">{{ card.referenceAnswer }}</div><p v-if="card.generation" class="field-help" style="margin-top: 14px">出题依据：{{ catalog?.questions.find(q => q.id === card.generation?.knowledgeCardId)?.title || card.generation.knowledgeCardId }} · 知识卡 v{{ card.generation.knowledgeCardVersion }}。本场问题与参考答案由 AI 生成。</p><div class="source-list" style="margin-top: 15px"><a v-for="source in card.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title }} ↗</a></div></a-collapse-panel></a-collapse>
            </article></section>
            <section v-if="report.improvements.length" class="panel report-section"><h2>{{ report.engine === 'local' ? '对照练习建议' : '下一步练习' }}</h2><article v-for="item in report.improvements" :key="item.title" class="improvement-item"><h3>{{ item.title }}</h3><p>{{ item.exercise }}</p><p class="acceptance"><strong>验收：</strong>{{ item.acceptance }}</p></article></section>
          </div>
          <aside class="report-aside"><section class="panel session-info"><h3>练习范围</h3><div class="inline-tags"><span v-for="topic in coveredTopics" :key="topic" class="subtle-tag">{{ catalog?.topicLabels[topic] }}</span><span v-if="!coveredTopics.length" class="field-help">暂无作答考点</span></div><p class="field-help" style="margin-top: 20px">{{ report.limitation }}</p></section><section class="panel session-info"><h3>接下来</h3><div class="report-actions"><a-button type="primary" :loading="retesting" :disabled="!report.retestQuestionIds.length" @click="retest"><ReloadOutlined />同主题复练</a-button><AppLinkButton to="/" class="full-width" block>重新配置面试 <ArrowRightOutlined /></AppLinkButton></div><p class="field-help" style="margin-top: 16px">AI 模式会依据同主题知识重新出题。</p></section></aside>
        </div>
      </template>
    </template>
  </div>
</template>
