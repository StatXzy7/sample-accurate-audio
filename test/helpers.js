/**
 * 测试辅助：构造与解析字节。
 */

import assert from 'node:assert/strict';
import { encodeWav, parseWav } from '../src/core/wav.js';

/** 生成 sample[i] = (i*step) 落在 [-32768, 32767] 内的斜坡样本 */
export function rampSamples(count, step = 1000) {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = ((i * step) % 60000) - 30000;
  }
  return samples;
}

/** 直接按公式生成确定性样本，便于断言精确值 */
export function knownSamples(count, fn) {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = fn(i);
  return samples;
}

/** 构造合法 WAV 字节 */
export function makeWav(samples, sampleRate = 8000) {
  return encodeWav(samples, sampleRate);
}

/** 把 WAV 字节包成 DataView 以便改写 */
export function toView(bytes) {
  const copy = new Uint8Array(bytes);
  return { bytes: copy, view: new DataView(copy.buffer) };
}

/** 改写后重新解析 */
export function parseBytes(bytes) {
  return parseWav(bytes);
}

/** 断言 Int16Array 与数字数组逐采样相等 */
export function assertSamplesEqual(actual, expected, message = '') {
  const actualArr = Array.from(actual);
  const expectedArr = expected instanceof Int16Array ? Array.from(expected) : expected;
  assert.strictEqual(actualArr.length, expectedArr.length,
    `${message} 长度不符：实际 ${actualArr.length}，期望 ${expectedArr.length}`);
  for (let i = 0; i < expectedArr.length; i += 1) {
    assert.strictEqual(actualArr[i], expectedArr[i],
      `${message} 第 ${i} 个采样不符：实际 ${actualArr[i]}，期望 ${expectedArr[i]}`);
  }
}
