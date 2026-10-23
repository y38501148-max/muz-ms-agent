import { createError, defineEventHandler, getMethod, getRequestURL, readBody, setResponseHeader } from 'h3'
import { z } from 'zod'
import { InterviewService } from '../lib/engine'
import { AppError } from '../lib/errors'
import { store } from '../lib/store'
import { parseResumeUpload } from '../lib/resume'

const service = new InterviewService(store)

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const method = getMethod(event)
  const path = getRequestURL(event).pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)
  const [resource, id, action] = path
  try {
    if (path.length > 3) throw new AppError(404, '接口不存在。')
    if (resource === 'resume' && id === 'parse' && !action && method === 'POST') return await parseResumeUpload(event)
    if (resource === 'catalog' && !id && method === 'GET') return await service.catalog()
    if (resource === 'questions' && id && !action && method === 'GET') return service.question(id)
    if (resource === 'settings' && !id) {
      if (method === 'GET') return await service.settings()
      if (method === 'PUT') return await service.saveSettings(await readBody(event))
    }
    if (resource === 'settings' && id === 'test' && !action && method === 'POST') return await service.testSettings()
    if (resource === 'sessions') {
      if (!id && method === 'GET') return await service.sessions()
      if (!id && method === 'POST') return await service.create(await readBody(event))
      if (id && !action && method === 'GET') return await service.getSession(id)
      if (id && !action && method === 'DELETE') return await service.deleteSession(id)
      if (id && action === 'turn' && method === 'POST') return await service.turn(id, await readBody(event))
      if (id && action === 'questions' && method === 'GET') return await service.completedQuestions(id)
      if (id && action === 'report' && method === 'GET') return await service.getReport(id)
      if (id && action === 'report' && method === 'POST') return await service.generateReport(id)
    }
    throw new AppError(404, '接口不存在。')
  } catch (error) {
    if (error instanceof AppError) throw createError({ statusCode: error.statusCode, statusMessage: 'Request rejected', message: error.message })
    if (error instanceof z.ZodError) throw createError({ statusCode: 400, statusMessage: 'Invalid request', message: '请求参数不符合要求，请检查填写内容。' })
    throw createError({ statusCode: 500, statusMessage: 'Request failed', message: '本地操作失败，请检查数据目录权限和磁盘空间后重试。' })
  }
})
