import type { FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function sendError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AppError) {
    void reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message },
    })
    return
  }

  if (error instanceof ZodError) {
    const first = error.issues[0]
    void reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: first?.message ?? '提交的数据格式不正确',
      },
    })
    return
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    const message = statusCode === 413 ? '请求内容过大' : '请求格式不正确'
    void reply.status(statusCode).send({
      error: { code: 'BAD_REQUEST', message },
    })
    return
  }

  request.log.error(error)
  void reply.status(500).send({
    error: { code: 'INTERNAL_ERROR', message: '服务器暂时无法处理请求' },
  })
}
