<script setup lang="ts">
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { AppstoreOutlined, ReadOutlined, HistoryOutlined, SettingOutlined, ArrowUpOutlined } from '@ant-design/icons-vue'

const route = useRoute()
const { data: catalog } = await useCatalog()
const nav = [
  { to: '/', label: '开始练习', icon: AppstoreOutlined, match: (p: string) => p === '/' || p.startsWith('/session/') },
  { to: '/questions', label: '题库与知识点', icon: ReadOutlined, match: (p: string) => p.startsWith('/questions') },
  { to: '/sessions', label: '练习记录', icon: HistoryOutlined, match: (p: string) => p.startsWith('/sessions') || p.startsWith('/reports') },
  { to: '/settings', label: '模型设置', icon: SettingOutlined, match: (p: string) => p.startsWith('/settings') },
]
const theme = {
  token: {
    colorPrimary: '#2563eb', colorInfo: '#2563eb', colorText: '#18243b', colorTextSecondary: '#66758c',
    colorBorder: '#dbe3ef', borderRadius: 8, fontSize: 14, controlHeight: 42,
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
}
</script>

<template>
  <a-extract-style>
    <a-config-provider :locale="zhCN" :theme="theme">
      <div class="app-shell">
        <a class="skip-link" href="#main-content">跳到主要内容</a>
        <aside class="sidebar">
          <NuxtLink to="/" class="brand" aria-label="muz-ms-agent 首页">
            <span class="brand-mark">m<span>·</span></span>
            <span class="brand-name">muz-ms-agent<small>面试练习工作台</small></span>
          </NuxtLink>
          <div class="nav-caption">工作空间</div>
          <nav class="main-nav" aria-label="主导航">
            <NuxtLink v-for="item in nav" :key="item.to" :to="item.to" :aria-label="item.label" :title="item.label" :class="{ active: item.match(route.path) }" :aria-current="item.match(route.path) ? 'page' : undefined">
              <component :is="item.icon" aria-hidden="true" /><span>{{ item.label }}</span>
            </NuxtLink>
          </nav>
          <div class="sidebar-bottom">
            <div class="workspace-note"><span class="tiny-dot" />个人练习空间<span class="version">v0.2</span></div>
            <NuxtLink to="/settings" class="provider-link">
              <span class="provider-symbol"><AppIcon name="ai" /></span>
              <span><strong>{{ catalog?.provider.configured ? '模型已配置' : '配置 AI 面试官' }}</strong><small>{{ catalog?.provider.configured ? catalog.provider.model : '设置服务地址与模型' }}</small></span>
              <ArrowUpOutlined class="tilted-arrow" aria-hidden="true" />
            </NuxtLink>
          </div>
        </aside>
        <div class="workspace">
          <header class="topbar">
            <span class="breadcrumb">个人空间<span>/</span>{{ nav.find(item => item.match(route.path))?.label || '面试练习' }}</span>
            <div class="topbar-right"><span class="local-tag"><span class="tiny-dot" />本机存储</span><span class="avatar" aria-label="个人用户">M</span></div>
          </header>
          <main id="main-content" tabindex="-1"><NuxtPage /></main>
          <footer v-if="!route.path.startsWith('/session/')" class="app-footer"><span>muz-ms-agent</span><span>v0.2.0</span></footer>
        </div>
      </div>
    </a-config-provider>
  </a-extract-style>
</template>
