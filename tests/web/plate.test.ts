import { describe, expect, it } from 'vitest';
import { isValidPlate, normalizePlate } from '../../src/web/utils';

describe('车牌输入校验', () => {
  it.each([
    '新A40D85',
    '粤B12345',
    '新AD12345',
    '新AFG1234',
    '新A12345D',
  ])('接受普通和新能源车牌 %s', (value) => {
    expect(isValidPlate(value)).toBe(true);
  });

  it.each([
    '新A',
    '新A1234',
    '新A123456',
    '新AD12A45',
    '新A12A45D',
    '新AI12345',
    '新O12345',
  ])('拒绝无效车牌 %s', (value) => {
    expect(isValidPlate(value)).toBe(false);
  });

  it('去除空格、连接点和连字符后转为大写', () => {
    expect(normalizePlate(' 新 a·12-345 ')).toBe('新A12345');
  });
});
