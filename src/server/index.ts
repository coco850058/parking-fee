import { createApp } from './app.js'
import { loadConfig } from './config.js'

try {
  process.loadEnvFile?.()
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== 'ENOENT') throw error
}

const config = loadConfig()
const app = await createApp()

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, '正在停止服务')
  await app.close()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
