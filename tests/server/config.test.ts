import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/server/config.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const productionBase = {
  NODE_ENV: 'production',
  JWT_SECRET: 'production-jwt-secret-with-at-least-32-characters',
  ADMIN_PASSWORD_HASH: '$2b$12$test-placeholder-hash',
}

const wechatBase = {
  ...productionBase,
  PAYMENT_MODE: 'wechat',
  PUBLIC_BASE_URL: 'https://pay.example.com',
  WECHAT_APP_ID: 'wx-test-app',
  WECHAT_APP_SECRET: 'test-secret',
  WECHAT_MCH_ID: '1234567890',
  WECHAT_MCH_SERIAL_NO: 'SERIAL-1',
  WECHAT_MCH_PRIVATE_KEY: privateKey,
  WECHAT_API_V3_KEY: '12345678901234567890123456789012',
  WECHATPAY_PUBLIC_KEY: publicKey,
  WECHATPAY_PUBLIC_KEY_ID: 'PUB_KEY_ID_1',
}

describe('运行配置校验', () => {
  it('拒绝指向不同文件的两个数据库变量', () => {
    expect(() =>
      loadConfig({
        DB_PATH: '/var/lib/parkfee/one.db',
        DATABASE_PATH: '/var/lib/parkfee/two.db',
      }),
    ).toThrow(/DATABASE_PATH.*DB_PATH/)
  })

  it('生产微信模式在启动时验证完整密钥配置', () => {
    const config = loadConfig(wechatBase)
    expect(config.paymentMode).toBe('wechat')
    expect(config.wechat.notifyUrl).toBe('https://pay.example.com/api/wechat/pay/notify')

    expect(() =>
      loadConfig({ ...wechatBase, WECHAT_API_V3_KEY: 'too-short' }),
    ).toThrow(/32 字节/)
    expect(() =>
      loadConfig({ ...wechatBase, WECHAT_MCH_PRIVATE_KEY: 'not-a-private-key' }),
    ).toThrow(/商户私钥/)
  })

  it('生产 mock 模式不要求微信密钥，便于离线验收', () => {
    const config = loadConfig({ ...productionBase, PAYMENT_MODE: 'mock' })
    expect(config.paymentMode).toBe('mock')
  })
})
