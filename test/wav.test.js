/**
 * WAV 编解码测试：往返一致性与非法格式拒绝。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decodeWav, encodeWav } from '../src/wav.js';
import { generateSyntheticSource } from '../src/model.js';
import { EditError, ErrorCode } from '../src/errors.js';

/** 手工拼装最小 WAV（便于注入各种非法字段）。 */
function buildWav({
  sampleRate = 8000,
  channels = 1,
  bitsPerSample = 16,
  formatTag = 1,
  samples = new Int16Array([1, -2, 32767, -32768, 0]),
  includeFmt = true,
  includeData = true,
} = {}) {
  const dataBytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const parts = [];
  const u32 = (v) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return b;
  };
  const u16 = (v) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    return b;
  };
  const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  const cat = (...arrays) => {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) {
      out.set(a, off);
      off += a.length;
    }
    return out;
  };

  const fmtBody = cat(
    u16(formatTag),
    u16(channels),
    u32(sampleRate),
    u32(sampleRate * channels * (bitsPerSample / 8)),
    u16(channels * (bitsPerSample / 8)),
    u16(bitsPerSample),
  );
  if (includeFmt) {
    parts.push(ascii('fmt '), u32(fmtBody.length), fmtBody);
  }
  if (includeData) {
    parts.push(ascii('data'), u32(dataBytes.length), dataBytes);
  }
  const riffBody = cat(...parts);
  return cat(ascii('RIFF'), u32(riffBody.length + 4), ascii('WAVE'), riffBody);
}

describe('WAV 往返', () => {
  test('encode → decode 采样逐点一致，头部字段正确', () => {
    const g = generateSyntheticSource();
    const wav = encodeWav(g.samples, g.sampleRate);
    const d = decodeWav(wav);
    assert.equal(d.sampleRate, 8000);
    assert.equal(d.samples.length, 8000);
    for (let i = 0; i < 8000; i += 1) assert.equal(d.samples[i], g.samples[i]);
    // 极值可正确往返
    const extrema = new Int16Array([32767, -32768, 0, 1, -1]);
    const d2 = decodeWav(encodeWav(extrema, 44100));
    assert.deepEqual(Array.from(d2.samples), [32767, -32768, 0, 1, -1]);
    assert.equal(d2.sampleRate, 44100);
  });

  test('空 WAV（0 采样）可往返', () => {
    const empty = new Int16Array(0);
    const d = decodeWav(encodeWav(empty, 16000));
    assert.equal(d.samples.length, 0);
    assert.equal(d.sampleRate, 16000);
  });

  test('标准 44 字节头布局', () => {
    const wav = encodeWav(new Int16Array([1]), 8000);
    const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(wav.length, 46);
    assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
    assert.equal(v.getUint32(4, true), 36 + 2);
    assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
    assert.equal(v.getUint16(20, true), 1); // PCM
    assert.equal(v.getUint16(22, true), 1); // mono
    assert.equal(v.getUint32(24, true), 8000);
    assert.equal(v.getUint16(34, true), 16);
  });

  test('接受带额外区块（LIST）且 data 在其后的 WAV', () => {
    const samples = new Int16Array([10, 20, 30]);
    const base = buildWav({ samples });
    // 在 data 前插入一个 LIST 区块
    const listChunk = new Uint8Array(12); // 'LIST' + size(4) + 4 字节体
    listChunk.set([76, 73, 83, 84], 0);
    new DataView(listChunk.buffer).setUint32(4, 4, true);
    const afterFmt = 12 + 8 + 16; // RIFF/WAVE 头 + fmt chunk
    const out = new Uint8Array(base.length + listChunk.length);
    out.set(base.subarray(0, afterFmt), 0);
    out.set(listChunk, afterFmt);
    out.set(base.subarray(afterFmt), afterFmt + listChunk.length);
    // 修正 RIFF size
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    const d = decodeWav(out);
    assert.deepEqual(Array.from(d.samples), [10, 20, 30]);
  });
});

describe('非法格式拒绝', () => {
  const cases = [
    ['非 WAV 魔数', () => {
      const b = buildWav({});
      b[0] = 88; // 破坏 R
      return b;
    }],
    ['立体声被拒绝', () => buildWav({ channels: 2 })],
    ['8 位被拒绝', () => buildWav({ bitsPerSample: 8 })],
    ['24 位被拒绝', () => buildWav({ bitsPerSample: 24 })],
    ['压缩格式(format=3)被拒绝', () => buildWav({ formatTag: 3 })],
    ['缺 fmt', () => buildWav({ includeFmt: false })],
    ['缺 data', () => buildWav({ includeData: false })],
    ['截断文件', () => buildWav({}).subarray(0, 20)],
    ['空缓冲', () => new Uint8Array(0)],
  ];

  for (const [name, make] of cases) {
    test(name, () => {
      assert.throws(
        () => decodeWav(make()),
        (err) => err instanceof EditError && err.code === ErrorCode.UNSUPPORTED_FORMAT,
      );
    });
  }

  test('data 声明长度超出文件被拒绝', () => {
    const wav = buildWav({});
    new DataView(wav.buffer, wav.byteOffset, wav.byteLength).setUint32(40, 9_999_999, true);
    assert.throws(() => decodeWav(wav), (err) => err instanceof EditError);
  });

  test('奇数 data 长度（与 16 位不符）被拒绝', () => {
    const wav = buildWav({});
    new DataView(wav.buffer, wav.byteOffset, wav.byteLength).setUint32(40, 3, true);
    assert.throws(() => decodeWav(wav), (err) => err instanceof EditError);
  });

  test('随机垃圾字节被拒绝', () => {
    const junk = Uint8Array.from({ length: 100 }, (_, i) => (i * 37) % 256);
    assert.throws(() => decodeWav(junk), (err) => err instanceof EditError);
  });
});
