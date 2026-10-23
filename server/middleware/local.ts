import { createError, defineEventHandler, getHeader, getMethod, getRequestURL } from 'h3'

export default defineEventHandler((event) => {
  const url = getRequestURL(event)
  if (!url.pathname.startsWith('/api/')) return
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) throw createError({ statusCode: 403, message: '本地应用只接受本机地址访问。' })
  if (process.env.MUZ_DESKTOP_TOKEN && getHeader(event, 'x-muz-desktop-token') !== process.env.MUZ_DESKTOP_TOKEN) throw createError({ statusCode: 403, message: '桌面应用访问凭证无效。' })
  if (['GET', 'HEAD', 'OPTIONS'].includes(getMethod(event))) return
  const origin = getHeader(event, 'origin')
  if ((origin && origin !== url.origin) || getHeader(event, 'sec-fetch-site') === 'cross-site') {
    throw createError({ statusCode: 403, message: '拒绝来自其他网站的修改请求。' })
  }
})
