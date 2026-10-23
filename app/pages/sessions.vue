<script setup lang="ts">
import { HistoryOutlined, ArrowRightOutlined, DeleteOutlined } from '@ant-design/icons-vue'
import type { SessionSummary } from '../../shared/types'

const { data: catalog } = await useCatalog()
const { data: sessions, refresh, error: loadError } = await useFetch<SessionSummary[]>('/api/sessions', { key: 'history-sessions' })
const error = ref('')
const deleting = ref<string | null>(null)
const statusFilter = ref('all')
const filtered = computed(() => sessions.value?.filter(s => statusFilter.value === 'all' || s.status === statusFilter.value) || [])
const roleTitle = (id: string) => catalog.value?.roleProfiles.find(r => r.id === id)?.title || id
const statusLabel = (status: string) => ({ active: '进行中', paused: '已暂停', completed: '已结束' })[status] || status
const difficultyLabel = (value: string) => ({ easy: '简单', medium: '中等', hard: '困难' })[value]
async function remove(id: string) {
  deleting.value = id
  error.value = ''
  try { await $fetch(`/api/sessions/${id}`, { method: 'DELETE' }); await refresh() }
  catch (e) { error.value = readableError(e) }
  finally { deleting.value = null }
}
</script>

<template>
  <div class="page">
    <div class="page-heading"><div><div class="eyebrow">练习档案</div><h1>练习记录</h1><p class="page-description">继续未完成的面试，或回看回答与复盘。</p></div><NuxtLink to="/" class="text-link">开始新面试 <ArrowRightOutlined /></NuxtLink></div>
    <p v-if="error || loadError" class="error-message" role="alert" style="margin-bottom: 20px">{{ error || '记录读取失败，请刷新后重试。' }}</p>
    <div v-if="sessions?.length" class="filter-bar panel"><a-segmented v-model:value="statusFilter" :options="[{ value: 'all', label: '全部' }, { value: 'active', label: '进行中' }, { value: 'paused', label: '已暂停' }, { value: 'completed', label: '已结束' }]" aria-label="筛选面试状态" /><span class="section-meta">{{ filtered.length }} 场练习</span></div>
    <div v-if="filtered.length" class="history-list">
      <article v-for="s in filtered" :key="s.id" class="history-card panel">
        <span class="history-icon"><AppIcon :name="s.config.roleId" /></span>
        <div class="history-info"><div class="history-title"><h3>{{ roleTitle(s.config.roleId) }}</h3><span class="status-tag" :class="s.status">{{ statusLabel(s.status) }}</span></div><div class="history-meta"><time :datetime="s.createdAt">{{ formatDate(s.createdAt) }}</time><span>{{ difficultyLabel(s.config.difficulty) }} · {{ s.config.mode === 'simulation' ? '模拟面试' : '辅导练习' }}</span><span>{{ s.config.engine === 'ai' ? 'AI 面试' : '本地练习' }}</span><span>回答 {{ s.answeredCount }} / {{ s.questionCount }} 题</span></div></div>
        <div class="history-actions"><AppLinkButton v-if="s.status !== 'completed'" :to="`/session/${s.id}`" type="primary">继续练习</AppLinkButton><AppLinkButton v-else :to="`/reports/${s.id}`">{{ s.hasReport ? '查看复盘' : '生成复盘' }}</AppLinkButton><a-popconfirm title="删除本场记录及复盘？" ok-text="删除" cancel-text="取消" @confirm="remove(s.id)"><a-button :loading="deleting === s.id" type="text" aria-label="删除本场记录"><DeleteOutlined /></a-button></a-popconfirm></div>
      </article>
    </div>
    <div v-else class="panel empty-state"><span class="empty-state-icon"><HistoryOutlined /></span><h2>{{ sessions?.length ? '当前没有此状态的练习' : '还没有练习记录' }}</h2><p>{{ sessions?.length ? '切换筛选条件查看其他记录。' : '完成一场面试后，可以在这里查看回答和复盘。' }}</p><AppLinkButton v-if="!sessions?.length" to="/" type="primary">开始第一场面试 <ArrowRightOutlined /></AppLinkButton></div>
  </div>
</template>
