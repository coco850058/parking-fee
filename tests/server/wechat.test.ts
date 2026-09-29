import {
  createCipheriv,
  createSign,
  generateKeyPairSync,
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/server/config.js'
import { AppError } from '../../src/server/errors.js'
import type { OrderRecord } from '../../src/server/domain.js'
import { WechatPayClient } from '../../src/server/wechat.js'

const apiV3Key = '12345678901234567890123456789012'

function signedNotification(timestampSeconds = Math.floor(Date.now() / 1000)) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const transaction = {
    appid: 'wx-test-app',
    mchid: '1900000001',
    out_trade_no: 'PF202609220001',
    transaction_id: '4200000000001',
    trade_state: 'SUCCESS',
    success_time: '2026-09-22T12:00:00+08:00',
    amount: { total: 8_000, currency: 'CNY' },
  }
  const nonce = '0123456789ab'
  const associatedData = 'transaction'
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce))
  cipher.setAAD(Buffer.from(associatedData))
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(transaction), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const rawBody = JSON.stringify({
    id: 'EV-001',
    event_type: 'TRANSACTION.SUCCESS',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      ciphertext: encrypted.toString('base64'),
      nonce,
      associated_data: associatedData,
    },
  })
  const timestamp = String(timestampSeconds)
  const headerNonce = 'callback-nonce'
  const signer = createSign('RSA-SHA256')
  signer.update(`${timestamp}\n${headerNonce}\n${rawBody}\n`)
  signer.end()
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    rawBody,
    headers: {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': headerNonce,
      'wechatpay-signature': signer.sign(privateKey, 'base64'),
      'wechatpay-serial': 'PUB_KEY_ID_TEST',
    },
    transaction,
  }
}

describe('微信支付回调校验', () => {
  it('基于原始请求体验签并使用 APIv3 密钥解密', () => {
    const fixture = signedNotification()
    const config = loadConfig({
      NODE_ENV: 'test',
      PAYMENT_MODE: 'wechat',
      WECHAT_APP_ID: 'wx-test-app',
      WECHAT_MCH_ID: '1900000001',
      WECHAT_API_V3_KEY: apiV3Key,
      WECHAT_PLATFORM_PUBLIC_KEY: fixture.publicKey,
      WECHAT_PLATFORM_PUBLIC_KEY_ID: 'PUB_KEY_ID_TEST',
    })
    const notification = new WechatPayClient(config).verifyAndDecryptNotification(
      fixture.rawBody,
      fixture.headers,
    )
    expect(notification).toEqual({
      id: 'EV-001',
      eventType: 'TRANSACTION.SUCCESS',
      transaction: fixture.transaction,
    })
  })

  it('拒绝被修改的原文和超过五分钟的时间戳', () => {
    const fixture = signedNotification()
    const config = loadConfig({
      NODE_ENV: 'test',
      PAYMENT_MODE: 'wechat',
      WECHAT_API_V3_KEY: apiV3Key,
      WECHAT_PLATFORM_PUBLIC_KEY: fixture.publicKey,
      WECHAT_PLATFORM_PUBLIC_KEY_ID: 'PUB_KEY_ID_TEST',
    })
    const client = new WechatPayClient(config)
    expect(() => client.verifyAndDecryptNotification(`${fixture.rawBody} `, fixture.headers)).toThrowError(
      expect.objectContaining<AppError>({ code: 'WECHAT_SIGNATURE_INVALID' }),
    )

    const stale = signedNotification(Math.floor(Date.now() / 1000) - 301)
    const staleClient = new WechatPayClient(
      loadConfig({
        NODE_ENV: 'test',
        PAYMENT_MODE: 'wechat',
        WECHAT_API_V3_KEY: apiV3Key,
        WECHAT_PLATFORM_PUBLIC_KEY: stale.publicKey,
        WECHAT_PLATFORM_PUBLIC_KEY_ID: 'PUB_KEY_ID_TEST',
      }),
    )
    expect(() => staleClient.verifyAndDecryptNotification(stale.rawBody, stale.headers)).toThrowError(
      expect.objectContaining<AppError>({ code: 'WECHAT_TIMESTAMP_INVALID' }),
    )
  })

  it('预下单传入与本地一致的失效时间，并可调用微信关单', async () => {
    const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const requests: Array<{ url: string; method: string; body: string; acceptLanguage: string | null }> = []
    const response = (rawBody: string, status: number): Response => {
      const timestamp = String(Math.floor(Date.now() / 1000))
      const nonce = `response-${requests.length}`
      const signer = createSign('RSA-SHA256')
      signer.update(`${timestamp}\n${nonce}\n${rawBody}\n`)
      signer.end()
      return new Response(status === 204 ? null : rawBody, {
        status,
        headers: {
          'wechatpay-timestamp': timestamp,
          'wechatpay-nonce': nonce,
          'wechatpay-signature': signer.sign(platformKeys.privateKey, 'base64'),
          'wechatpay-serial': 'PUB_KEY_ID_TEST',
          'content-type': 'application/json',
        },
      })
    }
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: String(init?.body ?? ''),
        acceptLanguage: new Headers(init?.headers).get('Accept-Language'),
      })
      return url.endsWith('/close')
        ? response('', 204)
        : response(JSON.stringify({ prepay_id: 'wx-prepay-1' }), 200)
    }) as typeof fetch
    const config = loadConfig({
      NODE_ENV: 'test',
      PAYMENT_MODE: 'wechat',
      WECHAT_APP_ID: 'wx-test-app',
      WECHAT_MCH_ID: '1900000001',
      WECHAT_MCH_SERIAL_NO: 'MERCHANT-SERIAL',
      WECHAT_MCH_PRIVATE_KEY: merchantKeys.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      WECHAT_PLATFORM_PUBLIC_KEY: platformKeys.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
      WECHAT_PLATFORM_PUBLIC_KEY_ID: 'PUB_KEY_ID_TEST',
    })
    const client = new WechatPayClient(config, fetchImpl)
    const order: OrderRecord = {
      id: '40296c77-4bc8-4f74-a2ac-a04a214979e9',
      orderNo: 'PF202609220001',
      clientRequestId: '4c5e34db-e048-4eb4-b7c1-fb5a5c2d4183',
      openid: 'wx-openid-1',
      customerType: 'resident',
      address: '幸福小区6栋',
      plateNumber: '苏A88888',
      durationMonths: 1,
      amount: 8_000,
      priceVersion: 1,
      status: 'pending',
      paymentMode: 'wechat',
      transactionId: null,
      createdAt: '2026-09-22T00:00:00.000Z',
      expiresAt: '2026-09-22T02:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
      paidAt: null,
      refund: null,
    }

    const created = await client.createJsapiOrder(order)
    expect(created.prepayId).toBe('wx-prepay-1')
    expect(requests[0]?.acceptLanguage).toBe('zh-CN')
    const createPayload = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>
    expect(createPayload.time_expire).toBe(order.expiresAt)

    await client.closeOrder(order.orderNo)
    expect(requests[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ mchid: '1900000001' }),
      acceptLanguage: 'zh-CN',
    })
    expect(requests[1]?.url).toContain(`/v3/pay/transactions/out-trade-no/${order.orderNo}/close`)
  })
})
