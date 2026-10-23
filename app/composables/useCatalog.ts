import type { Catalog } from '../../shared/types'

export const useCatalog = () => useFetch<Catalog>('/api/catalog', { key: 'catalog' })

export function readableError(error: unknown): string {
  const e = error as { data?: { statusMessage?: string; message?: string }; statusMessage?: string; message?: string }
  return e?.data?.message || e?.data?.statusMessage || e?.statusMessage || '请求未完成，请稍后重试。'
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' }).format(new Date(value))
}
