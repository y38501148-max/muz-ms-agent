export class AppError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
  }
}

export function requireValue<T>(value: T | undefined | null, message = '记录不存在。'): T {
  if (value === undefined || value === null) throw new AppError(404, message)
  return value
}
