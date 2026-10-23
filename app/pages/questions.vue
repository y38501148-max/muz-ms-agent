<script setup lang="ts">
import { SearchOutlined, ArrowUpOutlined, ReadOutlined, ArrowRightOutlined } from '@ant-design/icons-vue'
import { experiencePatterns } from '../../content/interview-patterns'
import type { Difficulty, Question, Topic } from '../../shared/types'

const { data: catalog } = await useCatalog()
const libraryView = ref<'knowledge' | 'patterns'>('knowledge')
const search = ref('')
const topic = ref<string>('all')
const role = ref('all')
const difficulty = ref<Difficulty>('medium')
const detail = ref<Question | null>(null)
const drawerOpen = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const showAnswer = ref(false)
const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return catalog.value?.questions.filter(q =>
    (topic.value === 'all' || q.topic === topic.value) &&
    (role.value === 'all' || q.roles.includes(role.value)) &&
    (!keyword || [q.title, ...q.tags, catalog.value?.topicLabels[q.topic]].join(' ').toLowerCase().includes(keyword)),
  ) || []
})
const topicOptions = computed(() => [{ value: 'all', label: '全部考点' }, ...Object.entries(catalog.value?.topicLabels || {}).map(([value, label]) => ({ value, label }))])
const roleOptions = computed(() => [{ value: 'all', label: '全部方向' }, ...(catalog.value?.roleProfiles || []).map(r => ({ value: r.id, label: r.title }))])
const difficultyOptions = [{ value: 'easy', label: '简单' }, { value: 'medium', label: '中等' }, { value: 'hard', label: '困难' }]
async function openQuestion(id: string) {
  drawerOpen.value = true
  showAnswer.value = false
  detail.value = null
  detailLoading.value = true
  detailError.value = ''
  try { detail.value = await $fetch<Question>(`/api/questions/${id}`) }
  catch (e) { detailError.value = readableError(e) }
  finally { detailLoading.value = false }
}
const topicLabel = (value: Topic) => catalog.value?.topicLabels[value] || value
</script>

<template>
  <div class="page">
    <div class="page-heading"><div><div class="eyebrow">内容库</div><h1>题库与知识点</h1><p class="page-description">知识题卡提供出题依据，也可展开参考答案自学。</p></div><NuxtLink to="/" class="text-link">配置面试 <ArrowRightOutlined /></NuxtLink></div>
    <a-segmented v-model:value="libraryView" :options="[{ value: 'knowledge', label: '知识题卡' }, { value: 'patterns', label: '面经提问策略' }]" class="library-switch" aria-label="内容类型" />
    <template v-if="libraryView === 'knowledge'">
    <div class="filter-bar panel">
      <a-input v-model:value="search" aria-label="搜索题目或标签" allow-clear placeholder="搜索题目或标签" class="filter-search"><template #prefix><SearchOutlined class="muted" /></template></a-input>
      <a-select id="question-topic-filter" v-model:value="topic" aria-label="按考点筛选" :options="topicOptions" class="filter-select" />
      <a-select id="question-role-filter" v-model:value="role" aria-label="按方向筛选" :options="roleOptions" class="filter-select" />
    </div>
    <p class="result-count">共 {{ filtered.length }} 道题<span v-if="search || topic !== 'all' || role !== 'all'"> · 已筛选</span></p>
    <div v-if="filtered.length" class="question-grid">
      <button v-for="q in filtered" :key="q.id" type="button" class="question-card panel" @click="openQuestion(q.id)">
        <div class="question-card-top"><span class="question-topic-icon"><AppIcon :name="q.topic" /></span><span class="subtle-tag">{{ topicLabel(q.topic) }}</span></div>
        <h3>{{ q.title }}</h3><p>{{ q.variants.medium.stem }}</p>
        <div class="question-card-bottom"><span>{{ q.tags.slice(0, 2).join(' / ') }}</span><ArrowUpOutlined class="tilted-arrow" /></div>
      </button>
    </div>
    <div v-else class="panel empty-state"><span class="empty-state-icon"><SearchOutlined /></span><h2>没有匹配的题目</h2><p>试试其他关键词，或扩大考点与方向范围。</p><a-button @click="search = ''; topic = 'all'; role = 'all'">清除筛选</a-button></div>

    </template>
    <section v-else class="experience-library"><p class="field-help">公开面经用于改进提问方式，技术判断仍依据知识题卡。公司与面试过程为作者自述。</p><article v-for="pattern in experiencePatterns" :key="pattern.id" class="panel experience-card"><h2>{{ pattern.title }}</h2><div class="inline-tags"><span v-for="roleId in pattern.roles" :key="roleId" class="subtle-tag">{{ catalog?.roleProfiles.find(r => r.id === roleId)?.title }}</span></div><ul><li v-for="rule in pattern.guidance" :key="rule">{{ rule }}</li></ul><div class="source-list"><a v-for="source in pattern.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title }} ↗ <span class="muted">{{ source.publishedAt || '发布日期未完整显示' }}</span></a></div></article></section>

    <a-drawer :open="drawerOpen" width="min(640px, 100vw)" :title="detail?.title || '题目详情'" @close="drawerOpen = false">
      <div v-if="detailLoading" class="loading-state"><a-spin /></div>
      <p v-else-if="detailError" class="error-message" role="alert">{{ detailError }}</p>
      <template v-else-if="detail">
        <div class="detail-tags"><span class="subtle-tag">{{ topicLabel(detail.topic) }}</span><span class="subtle-tag">知识题卡</span><span class="subtle-tag">v{{ detail.version }} · 助手核对</span></div>
        <section class="detail-section"><h3>题目</h3><a-segmented v-model:value="difficulty" :options="difficultyOptions" aria-label="题目难度" /><div class="detail-stem">{{ detail.variants[difficulty].stem }}</div></section>
        <section class="detail-section"><h3>练习标签</h3><div class="inline-tags"><span v-for="tag in detail.tags" :key="tag" class="subtle-tag">{{ tag }}</span></div></section>
        <a-button block @click="showAnswer = !showAnswer"><ReadOutlined />{{ showAnswer ? '收起参考与追问' : '展开参考与追问' }}</a-button>
        <div v-if="showAnswer" style="margin-top: 28px">
          <section class="detail-section"><h3>本档合格要点</h3><ul><li v-for="point in detail.points.filter(p => detail?.variants[difficulty].expectedPointIds.includes(p.id))" :key="point.id">{{ point.text }}</li></ul></section>
          <section class="detail-section"><h3>参考回答</h3><p style="white-space: pre-wrap">{{ detail.referenceAnswer }}</p></section>
          <section class="detail-section"><h3>可能的追问</h3><ul><li v-for="f in detail.followups" :key="f.id">{{ f.prompt }}</li></ul></section>
          <section class="detail-section"><h3>常见问题</h3><ul><li v-for="item in detail.pitfalls" :key="item">{{ item }}</li></ul></section>
          <section v-if="detail.sources.length" class="detail-section"><h3>阅读资料</h3><div class="source-list"><a v-for="source in detail.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title }} <ArrowUpOutlined class="tilted-arrow" /></a></div></section>
          <p class="field-help">题卡为原创练习设计；阅读资料用于核对知识，不代表任何公司使用过本题。</p>
        </div>
      </template>
    </a-drawer>
  </div>
</template>
