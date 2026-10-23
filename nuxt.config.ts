export default defineNuxtConfig({
  compatibilityDate: '2026-10-23',
  devtools: { enabled: false },
  modules: ['@ant-design-vue/nuxt'],
  antd: { extractStyle: true },
  css: ['~/assets/main.css'],
  app: {
    head: {
      title: 'muz-ms-agent · 面试练习',
      htmlAttrs: { lang: 'zh-CN' },
      meta: [{ name: 'description', content: '按岗位、考点与难度进行面试练习，记录回答并复盘。' }],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
  typescript: { strict: true },
})
