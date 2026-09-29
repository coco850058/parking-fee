import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPrivateKey, createPublicKey } from 'node:crypto'

export type PaymentMode = 'mock' | 'wechat'

export interface AppConfig {
  nodeEnv: string
  isProduction: boolean
  host: string
  port: number
  databasePath: string
  paymentMode: PaymentMode
  jwtSecret: string
  adminPassword?: string
  adminPasswordHash?: string
  publicBaseUrl: string
  wechat: {
    appId?: string
    appSecret?: string
    mchId?: string
    mchSerialNo?: string
    mchPrivateKey?: string
    apiV3Key?: string
    platformPublicKey?: string
    platformPublicKeyId?: string
    notifyUrl: string
    oauthRedirectUri: string
  }
}

export type Environment = Record<string, string | undefined>

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? 3000)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 3000
}

export function loadConfig(env: Environment = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV || 'development'
  const isProduction = nodeEnv === 'production'
  if (env.PAYMENT_MODE && env.PAYMENT_MODE !== 'wechat' && env.PAYMENT_MODE !== 'mock') {
    throw new Error('PAYMENT_MODE 只能是 mock 或 wechat')
  }
  const paymentMode: PaymentMode =
    env.PAYMENT_MODE === 'mock' || env.PAYMENT_MODE === 'wechat'
      ? env.PAYMENT_MODE
      : isProduction
        ? 'wechat'
        : 'mock'
  const publicBaseUrl = (env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')

  if (isProduction && !env.ADMIN_PASSWORD_HASH) {
    throw new Error('生产环境必须配置 ADMIN_PASSWORD_HASH')
  }
  if (isProduction && (!env.JWT_SECRET || env.JWT_SECRET.length < 32)) {
    throw new Error('生产环境必须配置至少 32 位的 JWT_SECRET')
  }
  if (
    env.DATABASE_PATH &&
    env.DB_PATH &&
    resolve(env.DATABASE_PATH) !== resolve(env.DB_PATH)
  ) {
    throw new Error('DATABASE_PATH 与 DB_PATH 指向不同，请只保留一个配置')
  }

  const config: AppConfig = {
    nodeEnv,
    isProduction,
    host: env.HOST || '127.0.0.1',
    port: parsePort(env.PORT),
    databasePath: env.DATABASE_PATH || env.DB_PATH || resolve(process.cwd(), 'data', 'parking.db'),
    paymentMode,
    jwtSecret: env.JWT_SECRET || 'development-only-secret-change-me',
    adminPassword: env.ADMIN_PASSWORD || undefined,
    adminPasswordHash: env.ADMIN_PASSWORD_HASH || undefined,
    publicBaseUrl,
    wechat: {
      appId: env.WECHAT_APP_ID || env.WECHATPAY_APP_ID || undefined,
      appSecret: env.WECHAT_APP_SECRET || undefined,
      mchId: env.WECHAT_MCH_ID || env.WECHATPAY_MCH_ID || undefined,
      mchSerialNo: env.WECHAT_MCH_SERIAL_NO || env.WECHATPAY_MCH_SERIAL_NO || undefined,
      mchPrivateKey:
        env.WECHAT_MCH_PRIVATE_KEY ||
        env.WECHAT_MCH_PRIVATE_KEY_PATH ||
        env.WECHATPAY_PRIVATE_KEY ||
        env.WECHATPAY_PRIVATE_KEY_PATH ||
        undefined,
      apiV3Key: env.WECHAT_API_V3_KEY || env.WECHATPAY_API_V3_KEY || undefined,
      platformPublicKey:
        env.WECHAT_PLATFORM_PUBLIC_KEY ||
        env.WECHATPAY_PUBLIC_KEY ||
        env.WECHATPAY_PUBLIC_KEY_PATH ||
        undefined,
      platformPublicKeyId:
        env.WECHAT_PLATFORM_PUBLIC_KEY_ID || env.WECHATPAY_PUBLIC_KEY_ID || undefined,
      notifyUrl: env.WECHAT_NOTIFY_URL || `${publicBaseUrl}/api/wechat/pay/notify`,
      oauthRedirectUri: env.WECHAT_OAUTH_REDIRECT_URI || `${publicBaseUrl}/`,
    },
  }

  if (isProduction && paymentMode === 'wechat') {
    if (!publicBaseUrl.startsWith('https://')) {
      throw new Error('生产微信支付必须使用 HTTPS 的 PUBLIC_BASE_URL')
    }
    const required: Array<[string, string | undefined]> = [
      ['WECHAT_APP_ID', config.wechat.appId],
      ['WECHAT_APP_SECRET', config.wechat.appSecret],
      ['WECHAT_MCH_ID', config.wechat.mchId],
      ['WECHAT_MCH_SERIAL_NO', config.wechat.mchSerialNo],
      ['WECHAT_MCH_PRIVATE_KEY_PATH', config.wechat.mchPrivateKey],
      ['WECHAT_API_V3_KEY', config.wechat.apiV3Key],
      ['WECHATPAY_PUBLIC_KEY_PATH', config.wechat.platformPublicKey],
      ['WECHATPAY_PUBLIC_KEY_ID', config.wechat.platformPublicKeyId],
    ]
    const missing = required.filter(([, value]) => !value).map(([name]) => name)
    if (missing.length > 0) {
      throw new Error(`生产微信支付缺少配置：${missing.join(', ')}`)
    }
    if (Buffer.byteLength(config.wechat.apiV3Key ?? '', 'utf8') !== 32) {
      throw new Error('WECHAT_API_V3_KEY 必须恰好为 32 字节')
    }
    try {
      createPrivateKey(readSecretOrFile(config.wechat.mchPrivateKey, 'WECHAT_MCH_PRIVATE_KEY'))
    } catch {
      throw new Error('微信支付商户私钥无法读取或格式不正确')
    }
    try {
      createPublicKey(readSecretOrFile(config.wechat.platformPublicKey, 'WECHAT_PLATFORM_PUBLIC_KEY'))
    } catch {
      throw new Error('微信支付平台公钥无法读取或格式不正确')
    }
  }

  return config
}

/**
 * 密钥既可直接放入环境变量，也可配置为 PEM 文件路径。环境变量中的 `\\n`
 * 会转换为真实换行，方便 systemd EnvironmentFile 使用。
 */
export function readSecretOrFile(value: string | undefined, name: string): string {
  if (!value) throw new Error(`缺少 ${name}`)
  const possiblePath = resolve(value)
  if (!value.includes('BEGIN') && existsSync(possiblePath)) {
    return readFileSync(possiblePath, 'utf8')
  }
  return value.replace(/\\n/g, '\n')
}
