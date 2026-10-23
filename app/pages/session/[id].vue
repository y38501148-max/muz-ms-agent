<script setup lang="ts">
import { ArrowLeftOutlined, SendOutlined, PauseOutlined, PlayCircleOutlined, BulbOutlined, StepForwardOutlined, CheckOutlined, RobotOutlined } from '@ant-design/icons-vue'
import type { InterviewSession, SessionAction, Topic, AnswerVerdict } from '../../../shared/types'

const route = useRoute()
const { data: catalog } = await useCatalog()
const { data: session, error: loadError, refresh } = await useFetch<InterviewSession>(`/api/sessions/${route.params.id}`, { key: `session-${route.params.id}` })
const verdictLabels: Record<AnswerVerdict, string> = { correct: '回答正确', partial: '部分正确', incorrect: '回答有误', insufficient: '信息不足' }
const draft = ref('')
const busy = ref(false)
const pendingAction = ref<SessionAction | null>(null)
const error = ref('')
const log = ref<HTMLElement | null>(null)
const role = computed(() => catalog.value?.roleProfiles.find(r => r.id === session.value?.config.roleId))
const company = computed(() => catalog.value?.companyProfiles.find(c => c.id === session.value?.config.companyId))
const difficultyNames: Record<string, string> = { easy: '简单 · 引导型', medium: '中等 · 求证型', hard: '困难 · 挑战型' }
const currentQuestion = computed(() => catalog.value?.questions.find(q => q.id === session.value?.questionIds[session.value.currentQuestionIndex]))
const answeredCount = computed(() => new Set(session.value?.turns.filter(t => t.role === 'candidate' && t.kind === 'answer').map(t => t.questionId)).size)
const progress = computed(() => session.value?.questionIds.length ? Math.round(answeredCount.value / session.value.questionIds.length * 100) : 0)
const hintDisabled = computed(() => busy.value || session.value?.status !== 'active' || session.value?.config.mode !== 'coaching')
const topicLabel = (topic: Topic) => catalog.value?.topicLabels[topic] || topic

async function perform(action: SessionAction, text?: string) {
  if (busy.value || !session.value) return
  if (action === 'answer' && !draft.value.trim()) return
  busy.value = true; pendingAction.value = action; error.value = ''
  try {
    session.value = await $fetch<InterviewSession>(`/api/sessions/${session.value.id}/turn`, { method: 'POST', body: { action, text: action === 'answer' ? draft.value.trim() : text, mode: action === 'switch-mode' ? 'coaching' : undefined, version: session.value.version } })
    if (action === 'answer') draft.value = ''
    if (session.value.status === 'completed') await navigateTo(`/reports/${session.value.id}`)
  } catch (e) {
    error.value = readableError(e)
    if ((e as { statusCode?: number }).statusCode === 409) await refresh()
  } finally { busy.value = false; pendingAction.value = null; await scrollLog() }
}
async function scrollLog() { await nextTick(); if (log.value) log.value.scrollTop = log.value.scrollHeight }
function onKeydown(event: KeyboardEvent) { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void perform('answer') } }
onMounted(async () => { if (session.value?.status === 'completed') await navigateTo(`/reports/${session.value.id}`); else await scrollLog() })
watch(() => session.value?.turns.length, scrollLog)
</script>

<template>
  <div class="page interview-page">
    <NuxtLink to="/" class="page-back"><ArrowLeftOutlined />返回练习台</NuxtLink>
    <div v-if="loadError || !session" class="panel empty-state"><h2>无法读取这场练习</h2><p>记录可能已删除，请返回练习台重新开始。</p><AppLinkButton to="/" type="primary">返回练习台</AppLinkButton></div>
    <template v-else>
      <div class="page-heading"><div><h1 style="font-size: 28px">{{ role?.title || '面试练习' }}</h1><p class="page-description">{{ company?.kind === 'fictional' ? `${company.name} · 虚构业务场景` : session.config.companyId === 'custom' ? `${session.config.customCompanyName} · 用户提供岗位资料` : '通用岗位练习' }}</p></div><span class="subtle-tag">{{ session.config.engine === 'ai' ? 'AI 面试' : '本地练习' }}</span></div>
      <div class="interview-layout">
        <section class="panel interview-main">
          <div class="interview-top"><span class="interview-agent-avatar"><RobotOutlined /></span><div><h2>{{ difficultyNames[session.config.difficulty] }}面试官</h2><p>{{ session.config.engine === 'local' ? '固定题卡 · 对照参考答案复盘' : session.config.mode === 'simulation' ? '模拟模式 · 面后统一反馈' : '辅导模式 · 逐次判断，反馈后作答单独记录' }}</p></div><span class="status-tag interview-status" :class="session.status">{{ busy ? '正在处理' : session.status === 'paused' ? '已暂停' : session.status === 'completed' ? '已结束' : '进行中' }}</span></div>
          <div ref="log" class="chat-log" role="log" aria-label="面试对话" aria-live="polite" :aria-busy="busy">
            <article v-for="turn in session.turns" :key="turn.id" class="chat-turn" :class="[turn.role === 'candidate' ? 'candidate' : 'interviewer', { control: turn.kind === 'control' || turn.kind === 'closing', feedback: turn.kind === 'feedback' }]">
              <span v-if="turn.kind !== 'control' && turn.kind !== 'closing'" class="turn-avatar"><span v-if="turn.role === 'candidate'">M</span><RobotOutlined v-else /></span>
              <div class="turn-content"><span v-if="turn.kind !== 'control' && turn.kind !== 'closing'" class="turn-label">{{ turn.role === 'candidate' ? '我的回答' : turn.kind === 'hint' ? '内容提示' : turn.kind === 'feedback' ? '回答判断' : '面试官' }}<span v-if="turn.assisted && turn.role === 'candidate'"> · 辅助后作答</span></span><div class="turn-bubble" :class="{ 'turn-hint': turn.kind === 'hint' || turn.kind === 'teaching' }"><span v-if="turn.feedback" class="verdict-label" :class="turn.feedback.verdict">{{ verdictLabels[turn.feedback.verdict] }}</span><br v-if="turn.feedback" />{{ turn.feedback?.explanation || turn.text }}</div></div>
            </article>
            <div v-if="busy" class="chat-turn"><span class="turn-avatar"><RobotOutlined /></span><div class="turn-content"><span class="turn-label">{{ pendingAction === 'answer' && session.config.engine === 'ai' ? '正在判断回答并生成下一问' : '正在处理' }}</span><a-spin size="small" /></div></div>
          </div>
          <div v-if="session.status === 'paused'" class="paused-panel"><h3>练习已暂停</h3><p>当前问题和回答已保存，恢复后继续。</p><a-button type="primary" :loading="busy" @click="perform('resume')"><PlayCircleOutlined />恢复练习</a-button></div>
          <form v-else-if="session.status === 'active'" class="chat-compose" @submit.prevent="perform('answer')">
            <div class="compose-label"><label for="answer-input">我的回答</label><span>Ctrl / ⌘ + Enter 发送</span></div>
            <a-textarea id="answer-input" v-model:value="draft" :auto-size="{ minRows: 4, maxRows: 6 }" :maxlength="12000" :disabled="busy" placeholder="写下你的思路、依据和验证方法……" @keydown="onKeydown" />
            <p v-if="error" class="error-message" role="alert" style="margin-top: 12px">{{ error }}</p>
            <div class="compose-actions"><div class="compose-secondary"><a-button v-if="session.config.mode === 'coaching'" type="text" :disabled="hintDisabled" :loading="pendingAction === 'hint'" @click="perform('hint')"><BulbOutlined />提示</a-button><a-button v-else type="text" :disabled="busy" @click="perform('switch-mode')"><BulbOutlined />切换辅导</a-button><a-button type="text" :disabled="busy" @click="perform('skip')"><StepForwardOutlined />跳过本题</a-button></div><a-button type="primary" html-type="submit" :loading="pendingAction === 'answer'" :disabled="busy || !draft.trim()"><SendOutlined />发送回答</a-button></div>
          </form>
          <div v-else class="paused-panel"><AppLinkButton :to="`/reports/${session.id}`" type="primary">查看复盘</AppLinkButton></div>
        </section>
        <aside class="session-aside">
          <section class="panel session-info"><h3>本场进度</h3><div class="session-stat-line"><span>已回答</span><strong>{{ answeredCount }} / {{ session.questionIds.length }} 题</strong></div><div class="progress-track" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100" aria-label="回答进度"><span :style="{ width: `${progress}%` }" /></div><div class="session-stat-line"><span>当前考点</span><strong>{{ currentQuestion ? topicLabel(currentQuestion.topic) : '—' }}</strong></div><div class="session-stat-line"><span>本题追问</span><strong>{{ session.followupsUsed }} 次</strong></div><div class="session-stat-line"><span>本题提示</span><strong>{{ session.hintsUsed }} 次</strong></div><div class="session-controls"><a-button v-if="session.status === 'active'" block :disabled="busy" @click="perform('pause')"><PauseOutlined />暂停练习</a-button><a-popconfirm v-if="session.status !== 'completed'" title="结束本场面试并进入复盘？" ok-text="结束并复盘" cancel-text="继续练习" @confirm="perform('end')"><a-button block :disabled="busy"><CheckOutlined />结束并复盘</a-button></a-popconfirm></div></section>
          <p class="session-note">{{ session.config.engine === 'local' ? '本地练习按预设顺序追问，不判断回答正误。结束后可对照参考要点复盘。' : '依据知识点自主出题并判断回答。辅导模式逐次反馈；模拟模式结束后统一复盘。' }}</p>
          <p v-if="error && session.status !== 'active'" class="error-message" role="alert">{{ error }}</p>
        </aside>
      </div>
    </template>
  </div>
</template>
