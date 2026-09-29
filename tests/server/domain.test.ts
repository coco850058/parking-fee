import { describe, expect, it } from 'vitest'
import { plateNumberSchema, platePrefixSchema } from '../../src/server/domain.js'

describe('车牌默认前缀校验', () => {
  it.each([
    ['新A', '新A'],
    ['粤 b', '粤B'],
    ['沪D', '沪D'],
  ])('接受有效省份与发牌字母 %s', (input, normalized) => {
    expect(platePrefixSchema.parse(input)).toBe(normalized)
  })

  it.each(['', '新I', '新O', '新1', '假A', 'AA', '新AB'])('拒绝无效前缀 %s', (input) => {
    expect(platePrefixSchema.safeParse(input).success).toBe(false)
  })
})

describe('车牌号校验', () => {
  it.each([
    ['新A40D85', '新A40D85'],
    ['新 a·12345', '新A12345'],
    ['粤B12345', '粤B12345'],
    ['新AD12345', '新AD12345'],
    ['新AFG1234', '新AFG1234'],
    ['新A12345D', '新A12345D'],
  ])('接受普通与新能源车牌并归一化 %s', (input, normalized) => {
    expect(plateNumberSchema.parse(input)).toBe(normalized)
  })

  it.each([
    '新A1234', // 普通车牌不足 7 位
    '新A123456', // 8 位但不是新能源编排
    '新AD12A45', // 小型新能源末 4 位须为数字
    '新A12A45D', // 大型新能源 D/F 前 5 位须为数字
    '新AI12345', // 序号不使用 I/O
    '新O12345', // 发牌机关代号不使用 I/O
    '假A12345', // 非省份简称
    '新A1234567', // 长于 8 位
  ])('拒绝无效或非标准车牌 %s', (plate) => {
    expect(plateNumberSchema.safeParse(plate).success).toBe(false)
  })
})
