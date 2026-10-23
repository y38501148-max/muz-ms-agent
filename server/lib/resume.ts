import { getHeader, getRequestWebStream, type H3Event } from 'h3'
import { AppError } from './errors'

export const MAX_RESUME_BYTES = 5 * 1024 * 1024
export const MAX_RESUME_CHARACTERS = 20000
const MAX_MULTIPART_BYTES = MAX_RESUME_BYTES + 64 * 1024
const allowedMimeTypes: Record<string, string[]> = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
  txt: ['text/plain'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
}

/** Extract plain text in memory. Document bytes are neither saved nor submitted to a model. */
export async function parseResumeFile(fileName: string, mimeType: string, bytes: Uint8Array): Promise<{ fileName: string; text: string }> {
  const name = fileName.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '').trim() || ''
  if (!name || name.length > 200) throw new AppError(400, '简历文件名无效，请使用不超过 200 字的文件名。')
  const extension = name.split('.').at(-1)?.toLowerCase() || ''
  if (!allowedMimeTypes[extension]) throw new AppError(400, '请选择 PDF、DOCX、TXT 或 Markdown 简历文件；旧版 DOC 请先另存为 DOCX。')
  const mime = mimeType.toLowerCase().split(';')[0]!.trim()
  if (mime && mime !== 'application/octet-stream' && !allowedMimeTypes[extension]!.includes(mime)) throw new AppError(400, '文件类型与扩展名不一致，请重新选择或导出简历文件。')
  if (!bytes.byteLength) throw new AppError(400, '简历文件为空，请重新选择。')
  if (bytes.byteLength > MAX_RESUME_BYTES) throw new AppError(413, '简历文件不能超过 5 MB，请压缩文件或改用文本版本。')
  const signature = Buffer.from(bytes.subarray(0, 8))
  let text: string
  try {
    if (extension === 'pdf') {
      if (signature.subarray(0, 5).toString('ascii') !== '%PDF-') throw new AppError(400, '文件内容不是有效 PDF，请重新导出简历。')
      const { getDocumentProxy, extractText } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
      try { text = (await extractText(pdf, { mergePages: true })).text }
      finally { await pdf.loadingTask.destroy() }
    } else if (extension === 'docx') {
      if (!signature.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new AppError(400, '文件内容不是有效 DOCX，请使用 Word 的“另存为 DOCX”后重试。')
      const mammoth = (await import('mammoth')).default
      text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value
    } else {
      if (signature.subarray(0, 5).toString('ascii') === '%PDF-' || signature.subarray(0, 2).toString('ascii') === 'PK') throw new AppError(400, '文本文件包含其他文档格式，请按实际格式选择文件。')
      const utf16le = signature[0] === 0xff && signature[1] === 0xfe
      const utf16be = signature[0] === 0xfe && signature[1] === 0xff
      text = new TextDecoder(utf16le ? 'utf-16le' : utf16be ? 'utf-16be' : 'utf-8', { fatal: true }).decode(bytes)
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new AppError(400, '文件包含非文本数据，请另存为 UTF-8 TXT 或 Markdown 后重试。')
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    if (extension === 'pdf' && error instanceof Error && /password/i.test(error.name)) throw new AppError(422, 'PDF 已加密或需要密码。请先移除密码后导入，或粘贴简历文字。')
    if (extension === 'pdf') throw new AppError(422, '无法读取此 PDF。请重新导出可复制文字的 PDF，或改用 DOCX/TXT。')
    if (extension === 'docx') throw new AppError(422, '无法读取此 DOCX。请重新另存为 DOCX，或复制内容到 TXT 后导入。')
    throw new AppError(422, '无法识别文本编码，请另存为 UTF-8 TXT 或 Markdown 后重试。')
  }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()
  if (!text) throw new AppError(422, extension === 'pdf'
    ? 'PDF 没有可提取的文字，可能是扫描件。请先进行 OCR，或导入 DOCX/TXT、直接粘贴文字。'
    : '文件中没有可提取的简历文字，请检查后重新导入。')
  if (text.length > MAX_RESUME_CHARACTERS) throw new AppError(413, '简历文字超过 20000 字，请精简后重新导入，或粘贴需要练习的部分。')
  return { fileName: name, text }
}

export async function parseResumeUpload(event: H3Event) {
  const contentType = getHeader(event, 'content-type') || ''
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new AppError(400, '请使用 multipart/form-data 上传一个简历文件。')
  if (Number(getHeader(event, 'content-length')) > MAX_MULTIPART_BYTES) throw new AppError(413, '简历文件不能超过 5 MB。')
  const stream = getRequestWebStream(event)
  if (!stream) throw new AppError(400, '没有收到简历文件。')
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_MULTIPART_BYTES) throw new AppError(413, '简历上传内容超过 5 MB，请缩小文件后重试。')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  let form: FormData
  try { form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': contentType } }).formData() }
  catch { throw new AppError(400, '简历上传格式无效，请重新选择文件。') }
  const files = form.getAll('file')
  if (files.length !== 1 || typeof files[0] === 'string' || !files[0]) throw new AppError(400, '每次请选择一个简历文件，表单字段为 file。')
  const file = files[0]
  return parseResumeFile(file.name, file.type, new Uint8Array(await file.arrayBuffer()))
}
