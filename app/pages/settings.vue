<script setup lang="ts">
import { CheckCircleOutlined, ApiOutlined, SaveOutlined } from '@ant-design/icons-vue'
import type { PublicProviderSettings } from '../../shared/types'

const { data: settings, refresh } = await useFetch<PublicProviderSettings>('/api/settings')
const { refresh: refreshCatalog } = await useCatalog()
const form = reactive({
  protocol: settings.value?.protocol || 'responses',
  baseUrl: settings.value?.baseUrl || '',
  model: settings.value?.model || '', apiKey: '',
})
const saving = ref(false)
const testing = ref(false)
const error = ref('')
const success = ref('')
async function save(test = false) {
  error.value = ''; success.value = ''
  if (!form.baseUrl.trim() || !form.model.trim()) { error.value = '请填写接口地址和模型名称。'; return }
  saving.value = true
  testing.value = test
  try {
    await $fetch('/api/settings', { method: 'PUT', body: form })
    form.apiKey = ''
    await Promise.all([refresh(), refreshCatalog()])
    if (test) {
      const result = await $fetch<{ verified: boolean; message?: string }>('/api/settings/test', { method: 'POST' })
      if (!result.verified) throw new Error('模型连接未通过验证。')
      success.value = '配置已保存，模型连接测试通过。'
    } else success.value = '配置已保存，可使用 AI 面试。尚未测试连接。'
  } catch (e) { error.value = readableError(e) }
  finally { saving.value = false; testing.value = false }
}
async function clearKey() {
  saving.value = true; error.value = ''; success.value = ''
  try { await $fetch('/api/settings', { method: 'PUT', body: { ...form, apiKey: '', clearApiKey: true } }); await Promise.all([refresh(), refreshCatalog()]); success.value = '已清除保存的密钥。' }
  catch (e) { error.value = readableError(e) }
  finally { saving.value = false }
}
</script>

<template>
  <div class="page">
    <div class="page-heading"><div><div class="eyebrow">连接配置</div><h1>模型设置</h1><p class="page-description">配置模型，启用自主出题、回答判断与追问。</p></div></div>
    <div class="settings-layout">
      <form class="panel settings-form" @submit.prevent="save(false)">
        <div><h2>模型服务</h2><p class="field-help" style="margin-top: 8px">支持 OpenAI 与 Anthropic 格式，由你选择服务地址和模型。</p></div>
        <div class="field-block"><label for="protocol">接口协议</label><a-select id="protocol" v-model:value="form.protocol" :options="[{ value: 'chat-completions', label: 'OpenAI Chat Completions' }, { value: 'responses', label: 'OpenAI Responses' }, { value: 'anthropic', label: 'Anthropic Messages' }]" class="full-width" /></div>
        <div class="field-block"><label for="base-url">接口地址（Base URL）</label><a-input id="base-url" v-model:value="form.baseUrl" :placeholder="form.protocol === 'anthropic' ? '例如 https://api.anthropic.com/v1' : '例如 https://api.openai.com/v1'" autocomplete="url" /><p class="field-help">填写包含 /v1 的服务地址，应用会自动追加接口路径。本地服务可使用 HTTP。</p></div>
        <div class="field-block"><label for="model-name">模型名称</label><a-input id="model-name" v-model:value="form.model" placeholder="填写服务支持的模型 ID" autocomplete="off" /><p class="field-help">模型需支持 JSON Schema 结构化输出。</p></div>
        <div class="field-block"><label for="api-key">API 密钥</label><a-input-password id="api-key" v-model:value="form.apiKey" :placeholder="settings?.hasApiKey ? '已保存密钥，留空保留' : '填写 API Key'" autocomplete="new-password" /><p class="field-help">仅保存在本机服务端；AI 面试时，所选题目、岗位资料和问答会发送至此服务。调用可能产生费用。</p></div>
        <p v-if="error" class="error-message" role="alert">{{ error }}</p><p v-if="success" class="success-message" role="status"><CheckCircleOutlined /> {{ success }}</p>
        <div class="settings-actions"><a-button type="primary" html-type="submit" :loading="saving && !testing" :disabled="testing"><SaveOutlined />保存配置</a-button><a-button :loading="testing" :disabled="saving && !testing" @click="save(true)"><ApiOutlined />保存并测试</a-button></div>
        <div v-if="settings?.hasApiKey"><a-popconfirm title="清除服务端保存的密钥？" ok-text="清除" cancel-text="取消" @confirm="clearKey"><a-button type="link" danger :disabled="saving" style="padding-left: 0">清除密钥</a-button></a-popconfirm></div>
      </form>
      <aside class="panel settings-info"><h3>当前状态</h3><span class="status-tag" :class="{ completed: settings?.configured }">{{ settings?.configured ? '配置已就绪' : '尚未配置模型' }}</span><dl><dt>已保存模型</dt><dd>{{ settings?.model || '—' }}</dd><dt>接口协议</dt><dd>{{ settings?.protocol === 'anthropic' ? 'Anthropic Messages' : settings?.protocol === 'chat-completions' ? 'OpenAI Chat Completions' : 'OpenAI Responses' }}</dd></dl><div style="height: 24px" /><h3>本地练习仍可使用</h3><p>本地模式提供题卡、预设追问、提示与回答记录。报告展示参考要点，不提供语义能力分数。</p><NuxtLink to="/" class="text-link">返回开始练习 →</NuxtLink></aside>
    </div>
  </div>
</template>
