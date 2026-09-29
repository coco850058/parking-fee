import {
  createDecipheriv,
  createSign,
  createVerify,
  randomBytes,
} from 'node:crypto'
import type { AppConfig } from './config.js'
import { readSecretOrFile } from './config.js'
import type { OrderRecord } from './domain.js'
import type { RefundIntent } from './database.js'
import { AppError } from './errors.js'

export interface JsapiPaymentParams {
  appId: string
  timeStamp: string
  nonceStr: string
  package: string
  signType: 'RSA'
  paySign: string
}

export interface WechatTransaction {
  appid: string
  mchid: string
  out_trade_no: string
  transaction_id?: string
  trade_state: string
  success_time?: string
  amount: {
    total: number
    payer_total?: number
    currency?: string
  }
}

export interface WechatRefund {
  mchid?: string
  out_trade_no: string
  transaction_id: string
  out_refund_no: string
  refund_id: string
  status: 'SUCCESS' | 'CLOSED' | 'PROCESSING' | 'ABNORMAL'
  success_time?: string
  amount: { total: number; refund: number; currency?: string }
}

export interface WechatRefundNotification extends Omit<WechatRefund, 'status'> {
  mchid: string
  refund_status: WechatRefund['status']
}

interface NotificationEnvelope {
  id: string
  event_type: string
  resource: {
    algorithm: string
    original_type?: string
    ciphertext: string
    nonce: string
    associated_data?: string
  }
}

export interface DecryptedNotification {
  id: string
  eventType: string
  transaction: WechatTransaction
}

export interface DecryptedRefundNotification {
  id: string
  eventType: string
  refund: WechatRefundNotification
}

type FetchImplementation = typeof fetch

export class WechatPayClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: FetchImplementation = fetch,
  ) {}

  buildOAuthUrl(state = 'parking-payment'): string {
    const appId = this.requireValue(this.config.wechat.appId, 'WECHAT_APP_ID')
    const redirect = encodeURIComponent(this.config.wechat.oauthRedirectUri)
    return (
      `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(appId)}` +
      `&redirect_uri=${redirect}&response_type=code&scope=snsapi_base` +
      `&state=${encodeURIComponent(state)}#wechat_redirect`
    )
  }

  async exchangeOAuthCode(code: string): Promise<string> {
    const appId = this.requireValue(this.config.wechat.appId, 'WECHAT_APP_ID')
    const secret = this.requireValue(this.config.wechat.appSecret, 'WECHAT_APP_SECRET')
    const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
    url.searchParams.set('appid', appId)
    url.searchParams.set('secret', secret)
    url.searchParams.set('code', code)
    url.searchParams.set('grant_type', 'authorization_code')
    let response: Response
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) })
    } catch {
      throw new AppError(502, 'WECHAT_OAUTH_NETWORK_ERROR', '暂时无法连接微信身份服务')
    }
    let body: { openid?: string; errcode?: number; errmsg?: string }
    try {
      body = (await response.json()) as typeof body
    } catch {
      throw new AppError(502, 'WECHAT_OAUTH_FAILED', '微信身份服务返回了无法识别的数据')
    }
    if (!response.ok || !body.openid) {
      throw new AppError(
        502,
        'WECHAT_OAUTH_FAILED',
        `微信身份验证失败${body.errmsg ? `：${body.errmsg}` : ''}`,
      )
    }
    return body.openid
  }

  async createJsapiOrder(order: OrderRecord): Promise<{
    prepayId: string
    paymentParams: JsapiPaymentParams
  }> {
    const appId = this.requireValue(this.config.wechat.appId, 'WECHAT_APP_ID')
    const mchId = this.requireValue(this.config.wechat.mchId, 'WECHAT_MCH_ID')
    const payload = {
      appid: appId,
      mchid: mchId,
      description: `停车费-${order.plateNumber}-${order.durationMonths}个月`,
      out_trade_no: order.orderNo,
      notify_url: this.config.wechat.notifyUrl,
      // 与本地 expires_at 使用同一个绝对时间，避免两边对“待支付”状态理解不一致。
      time_expire: order.expiresAt,
      amount: { total: order.amount, currency: 'CNY' },
      payer: { openid: order.openid },
    }
    const result = await this.request<{ prepay_id?: string }>(
      'POST',
      '/v3/pay/transactions/jsapi',
      payload,
    )
    if (!result.prepay_id) {
      throw new AppError(502, 'WECHAT_PREPAY_FAILED', '微信支付下单未返回预支付标识')
    }
    const paymentParams = this.buildJsapiPaymentParams(result.prepay_id)
    return { prepayId: result.prepay_id, paymentParams }
  }

  buildJsapiPaymentParams(prepayId: string): JsapiPaymentParams {
    const appId = this.requireValue(this.config.wechat.appId, 'WECHAT_APP_ID')
    const timeStamp = Math.floor(Date.now() / 1000).toString()
    const nonceStr = randomBytes(16).toString('hex')
    const packageValue = `prepay_id=${prepayId}`
    const message = `${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`
    return {
      appId,
      timeStamp,
      nonceStr,
      package: packageValue,
      signType: 'RSA',
      paySign: this.sign(message),
    }
  }

  async queryOrder(orderNo: string): Promise<WechatTransaction> {
    const mchId = this.requireValue(this.config.wechat.mchId, 'WECHAT_MCH_ID')
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(mchId)}`
    return this.request<WechatTransaction>('GET', path)
  }

  async closeOrder(orderNo: string): Promise<void> {
    const mchId = this.requireValue(this.config.wechat.mchId, 'WECHAT_MCH_ID')
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}/close`
    await this.request<unknown>('POST', path, { mchid: mchId })
  }

  async requestRefund(order: OrderRecord, refund: RefundIntent): Promise<WechatRefund> {
    if (!order.transactionId || refund.amount !== order.amount) {
      throw new AppError(409, 'ORDER_NOT_REFUNDABLE', '订单支付信息不完整，无法退款')
    }
    return this.request<WechatRefund>('POST', '/v3/refund/domestic/refunds', {
      transaction_id: order.transactionId,
      out_refund_no: refund.outRefundNo,
      ...(refund.reason ? { reason: refund.reason } : {}),
      notify_url: `${this.config.publicBaseUrl}/api/wechat/refund/notify`,
      amount: { refund: refund.amount, total: order.amount, currency: 'CNY' },
    })
  }

  async queryRefund(outRefundNo: string): Promise<WechatRefund> {
    return this.request<WechatRefund>(
      'GET',
      `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`,
    )
  }

  verifyAndDecryptNotification(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): DecryptedNotification {
    this.verifyWechatSignature(rawBody, (name) => this.header(headers, name), '回调')

    let envelope: NotificationEnvelope
    try {
      envelope = JSON.parse(rawBody) as NotificationEnvelope
    } catch {
      throw new AppError(400, 'WECHAT_NOTIFICATION_INVALID', '微信支付回调格式无效')
    }
    if (!envelope.id || !envelope.resource) {
      throw new AppError(400, 'WECHAT_NOTIFICATION_INVALID', '微信支付回调缺少必要字段')
    }
    const transaction = this.decryptResource<WechatTransaction>(envelope.resource)
    return { id: envelope.id, eventType: envelope.event_type, transaction }
  }

  verifyAndDecryptRefundNotification(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): DecryptedRefundNotification {
    this.verifyWechatSignature(rawBody, (name) => this.header(headers, name), '回调')
    let envelope: NotificationEnvelope
    try {
      envelope = JSON.parse(rawBody) as NotificationEnvelope
    } catch {
      throw new AppError(400, 'WECHAT_NOTIFICATION_INVALID', '微信退款回调格式无效')
    }
    if (
      !envelope.id || !envelope.resource ||
      !['REFUND.SUCCESS', 'REFUND.CLOSED', 'REFUND.ABNORMAL'].includes(envelope.event_type) ||
      envelope.resource.original_type !== 'refund'
    ) {
      throw new AppError(400, 'WECHAT_NOTIFICATION_INVALID', '微信退款回调缺少必要字段')
    }
    const refund = this.decryptResource<WechatRefundNotification>(envelope.resource)
    return { id: envelope.id, eventType: envelope.event_type, refund }
  }

  private decryptResource<T>(resource: NotificationEnvelope['resource']): T {
    if (resource.algorithm !== 'AEAD_AES_256_GCM') {
      throw new AppError(400, 'WECHAT_NOTIFICATION_INVALID', '不支持的微信支付加密算法')
    }
    const keyText = this.requireValue(this.config.wechat.apiV3Key, 'WECHAT_API_V3_KEY')
    const key = Buffer.from(keyText, 'utf8')
    if (key.length !== 32) {
      throw new AppError(500, 'WECHAT_CONFIG_INVALID', '微信支付 APIv3 密钥必须为32字节')
    }
    try {
      const encrypted = Buffer.from(resource.ciphertext, 'base64')
      const authTag = encrypted.subarray(encrypted.length - 16)
      const ciphertext = encrypted.subarray(0, encrypted.length - 16)
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce))
      decipher.setAuthTag(authTag)
      decipher.setAAD(Buffer.from(resource.associated_data ?? ''))
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        'utf8',
      )
      return JSON.parse(plaintext) as T
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(400, 'WECHAT_DECRYPT_FAILED', '微信支付回调解密失败')
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    const body = payload === undefined ? '' : JSON.stringify(payload)
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const nonce = randomBytes(16).toString('hex')
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`
    const mchId = this.requireValue(this.config.wechat.mchId, 'WECHAT_MCH_ID')
    const serialNo = this.requireValue(this.config.wechat.mchSerialNo, 'WECHAT_MCH_SERIAL_NO')
    const authorization =
      'WECHATPAY2-SHA256-RSA2048 ' +
      `mchid="${mchId}",nonce_str="${nonce}",signature="${this.sign(message)}",` +
      `timestamp="${timestamp}",serial_no="${serialNo}"`
    let response: Response
    try {
      response = await this.fetchImpl(`https://api.mch.weixin.qq.com${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'zh-CN',
          'Content-Type': 'application/json',
          Authorization: authorization,
          ...(path.startsWith('/v3/refund/') && this.config.wechat.platformPublicKeyId
            ? { 'Wechatpay-Serial': this.config.wechat.platformPublicKeyId }
            : {}),
          'User-Agent': 'park-fee/1.0',
        },
        body: method === 'POST' ? body : undefined,
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new AppError(502, 'WECHAT_NETWORK_ERROR', '暂时无法连接微信支付，请稍后重试')
    }
    const text = await response.text()
    this.verifyWechatSignature(
      text,
      (name) => response.headers.get(name) ?? undefined,
      '应答',
    )
    let result: unknown = {}
    if (text) {
      try {
        result = JSON.parse(text)
      } catch {
        throw new AppError(502, 'WECHAT_RESPONSE_INVALID', '微信支付返回了无法识别的数据')
      }
    }
    if (!response.ok) {
      const error = result as { code?: string; message?: string }
      throw new AppError(
        502,
        error.code ? `WECHAT_${error.code}` : 'WECHAT_API_ERROR',
        error.message ?? '微信支付请求失败',
      )
    }
    return result as T
  }

  private sign(message: string): string {
    const privateKey = readSecretOrFile(
      this.config.wechat.mchPrivateKey,
      'WECHAT_MCH_PRIVATE_KEY',
    )
    const signer = createSign('RSA-SHA256')
    signer.update(message)
    signer.end()
    return signer.sign(privateKey, 'base64')
  }

  private verifyWechatSignature(
    rawBody: string,
    getHeader: (name: string) => string | undefined,
    source: '回调' | '应答',
  ): void {
    const timestamp = getHeader('wechatpay-timestamp')
    const nonce = getHeader('wechatpay-nonce')
    const signature = getHeader('wechatpay-signature')
    const serial = getHeader('wechatpay-serial')
    if (!timestamp || !nonce || !signature || !serial) {
      throw new AppError(401, 'WECHAT_SIGNATURE_MISSING', `微信支付${source}缺少签名`)
    }
    const timestampSeconds = Number(timestamp)
    if (
      !Number.isInteger(timestampSeconds) ||
      Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 300
    ) {
      throw new AppError(401, 'WECHAT_TIMESTAMP_INVALID', `微信支付${source}时间戳已失效`)
    }
    const configuredKeyId = this.config.wechat.platformPublicKeyId
    if (configuredKeyId && serial !== configuredKeyId) {
      throw new AppError(401, 'WECHAT_SIGNATURE_INVALID', '微信支付签名密钥标识不匹配')
    }
    const publicKey = readSecretOrFile(
      this.config.wechat.platformPublicKey,
      'WECHAT_PLATFORM_PUBLIC_KEY',
    )
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`)
    verifier.end()
    if (!verifier.verify(publicKey, signature, 'base64')) {
      throw new AppError(401, 'WECHAT_SIGNATURE_INVALID', `微信支付${source}签名无效`)
    }
  }

  private header(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string {
    const value = headers[name]
    const normalized = Array.isArray(value) ? value[0] : value
    return normalized ?? ''
  }

  private requireValue(value: string | undefined, name: string): string {
    if (!value) throw new AppError(503, 'WECHAT_NOT_CONFIGURED', `缺少微信支付配置：${name}`)
    return value
  }
}
