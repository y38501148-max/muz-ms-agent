import type { ProviderSettings } from '../../shared/types'
import { AppError } from './errors'

/** Aggregate visible text only. A native terminal event is required before validating model JSON. */
export async function readSse(response: Response, protocol: ProviderSettings['protocol']): Promise<Record<string, any>> {
  if (!response.body) throw new AppError(502, '模型流式响应没有内容。本次操作未保存。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let terminal = false
  let started = false
  let text = ''
  let finishReason: string | null = null
  let refusal = false
  let stopDetails: unknown
  let finalResponse: Record<string, any> | undefined
  const blocks = new Map<number, { type: string; text: string }>()
  const outputTexts = new Map<string, string>()

  function frame(rawFrame: string) {
    let event = ''
    const data: string[] = []
    for (const line of rawFrame.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') event = value
      if (field === 'data') data.push(value)
    }
    if (!data.length) return
    const raw = data.join('\n')
    if (raw === '[DONE]') {
      if (protocol !== 'chat-completions' || !finishReason) throw new AppError(502, '模型流式响应缺少完成状态。本次操作未保存。')
      terminal = true
      return
    }
    let payload: Record<string, any>
    try { payload = JSON.parse(raw) } catch { throw new AppError(502, '模型流式事件格式异常。本次操作未保存，请重试。') }
    const type = payload.type || event
    if (type === 'error' || payload.error || type === 'response.failed' || type === 'response.incomplete') throw new AppError(502, '模型流式服务报错或输出未完成。本次操作未保存，请重试。')

    if (protocol === 'chat-completions') {
      const choice = payload.choices?.find((entry: Record<string, any>) => entry.index === 0) || payload.choices?.[0]
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content
      if (choice?.delta?.refusal) refusal = true
      if (choice?.finish_reason) finishReason = choice.finish_reason
      // reasoning_content and other internal reasoning fields are intentionally ignored.
    } else if (protocol === 'anthropic') {
      if (type === 'message_start') {
        started = true
        finishReason = payload.message?.stop_reason || null
        stopDetails = payload.message?.stop_details
        for (const [index, block] of (payload.message?.content || []).entries()) {
          if (block.type === 'text') blocks.set(index, { type: 'text', text: block.text || '' })
          if (block.type === 'refusal') refusal = true
        }
      } else if (type === 'content_block_start') {
        const block = payload.content_block
        blocks.set(payload.index, { type: block?.type || '', text: block?.type === 'text' ? block.text || '' : '' })
        if (block?.type === 'refusal') refusal = true
      } else if (type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        const block = blocks.get(payload.index)
        if (!block || block.type !== 'text') throw new AppError(502, '模型文本流缺少对应内容块。本次操作未保存。')
        block.text += payload.delta.text || ''
      } else if (type === 'message_delta') {
        if (payload.delta?.stop_reason) finishReason = payload.delta.stop_reason
        if (payload.delta?.stop_details) stopDetails = payload.delta.stop_details
      } else if (type === 'message_stop') {
        if (!started || !finishReason) throw new AppError(502, '模型流式响应缺少完成状态。本次操作未保存。')
        terminal = true
      }
      // thinking_delta, signature_delta and redacted thinking blocks are never collected.
    } else {
      const key = `${payload.output_index ?? 0}:${payload.content_index ?? 0}`
      if (type === 'response.output_text.delta') outputTexts.set(key, (outputTexts.get(key) || '') + (payload.delta || ''))
      if (type === 'response.output_text.done' && typeof payload.text === 'string') outputTexts.set(key, payload.text)
      if (type === 'response.refusal.delta' || type === 'response.refusal.done') refusal = true
      if (type === 'response.completed') {
        finalResponse = payload.response || { status: 'completed' }
        terminal = true
      }
    }
  }

  function consumeFrames() {
    let match: RegExpExecArray | null
    while (!terminal && (match = /\r?\n\r?\n|\r\r/.exec(buffer))) {
      const next = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      frame(next)
    }
  }

  try {
    while (!terminal) {
      const chunk = await reader.read()
      if (chunk.done) {
        buffer += decoder.decode()
        consumeFrames()
        if (!terminal && buffer.trim()) frame(buffer)
        break
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      consumeFrames()
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (!terminal) throw new AppError(502, '模型流式响应意外中断，未收到完成事件。本次操作未保存，请重试。')
  if (protocol === 'chat-completions') return { choices: [{ finish_reason: finishReason, message: { content: text, refusal: refusal || undefined } }] }
  if (protocol === 'anthropic') return {
    type: 'message', stop_reason: finishReason, stop_details: stopDetails,
    content: refusal ? [{ type: 'refusal' }] : [{ type: 'text', text: [...blocks.entries()].sort(([a], [b]) => a - b).filter(([, block]) => block.type === 'text').map(([, block]) => block.text).join('') }],
  }
  const finalParts = (Array.isArray(finalResponse?.output) ? finalResponse.output : []).flatMap((item: Record<string, any>) => Array.isArray(item.content) ? item.content : [])
  const finalText = finalParts.filter((part: Record<string, any>) => part.type === 'output_text').map((part: Record<string, any>) => part.text).join('')
  if (finalParts.some((part: Record<string, any>) => part.type === 'refusal')) refusal = true
  return {
    status: finalResponse?.status || 'completed', error: finalResponse?.error,
    output: [{ type: 'message', content: refusal ? [{ type: 'refusal' }] : [{ type: 'output_text', text: finalText || [...outputTexts.values()].join('') }] }],
  }
}
