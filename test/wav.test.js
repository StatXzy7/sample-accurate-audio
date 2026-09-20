/**
 * wav.test.js — WAV 解析/编码往返、非法格式拒绝、完整导出流程采样断言。
 *
 * 运行：node --test test/wav.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWav, encodeWav, WavFormatError } from '../src/core/wav.js';
import { renderClips, generateToneSource } from '../src/core/clips.js';
import { knownSamples, makeWav, toView, assertSamplesEqual } from './helpers.js';

const TAG = (s) => {
  let n = 0;
  for (let i = 0; i < 4; i += 1) n = (n << 8) | s.charCodeAt(i);
  return n >>> 0;
};

// ───────────────────── 合法往返 ─────────────────────

test('encode→parse 往返：采样值与采样率完全一致（含 32767/-32768 边界）', () => {
  const src = knownSamples(8, (i) => [0, 1, -1, 32767, -32768, 12345, -23456, 100][i]);
  const bytes = makeWav(src, 16000);
  const { sampleRate, samples } = parseWav(bytes);
  assert.equal(sampleRate, 16000);
  assert.ok(samples instanceof Int16Array);
  assertSamplesEqual(samples, Array.from(src));
});

test('WAV 头字段正确：PCM=1、单声道、16-bit、字节速率与块对齐', () => {
  const src = knownSamples(5, (i) => i);
  const bytes = makeWav(src, 44100);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint32(4, true), 36 + 10); // RIFF size
  assert.equal(view.getUint16(20, true), 1);       // PCM
  assert.equal(view.getUint16(22, true), 1);       // mono
  assert.equal(view.getUint32(24, true), 44100);   // sample rate
  assert.equal(view.getUint32(28, true), 88200);   // bytes/sec = 44100*1*2
  assert.equal(view.getUint16(32, true), 2);       // block align
  assert.equal(view.getUint16(34, true), 16);      // bits
  assert.equal(view.getUint32(40, true), 10);      // data size
});

test('空素材（0 采样）可往返', () => {
  const bytes = makeWav(new Int16Array(0), 8000);
  const { samples } = parseWav(bytes);
  assert.equal(samples.length, 0);
});

// ───────────────────── 非法格式拒绝 ─────────────────────

test('非 RIFF/WAVE 文件被拒绝', () => {
  const { bytes, view } = toView(makeWav(knownSamples(4, () => 1), 8000));
  view.setUint32(0, TAG('XXXX'), false); // 大端写入 "XXXX"
  assert.throws(() => parseWav(bytes), WavFormatError);
});

test('缺少 WAVE 标识被拒绝', () => {
  const { bytes } = toView(makeWav(knownSamples(4, () => 1), 8000));
  for (let i = 0; i < 4; i += 1) bytes[8 + i] = 0x58;
  assert.throws(() => parseWav(bytes), (e) => e.code === 'UNSUPPORTED_FORMAT');
});

test('立体声（2 声道）被拒绝', () => {
  const { bytes, view } = toView(makeWav(knownSamples(4, () => 1), 8000));
  view.setUint16(22, 2, true);
  assert.throws(() => parseWav(bytes), /单声道/);
});

test('8-bit 与 24-bit 被拒绝', () => {
  const b8 = toView(makeWav(knownSamples(4, () => 1), 8000));
  b8.view.setUint16(34, 8, true);
  assert.throws(() => parseWav(b8.bytes), /16-bit/);

  const b24 = toView(makeWav(knownSamples(4, () => 1), 8000));
  b24.view.setUint16(34, 24, true);
  assert.throws(() => parseWav(b24.bytes), /16-bit/);
});

test('非 PCM（float，format tag 3）被拒绝', () => {
  const { bytes, view } = toView(makeWav(knownSamples(4, () => 1), 8000));
  view.setUint16(20, 3, true); // IEEE float
  assert.throws(() => parseWav(bytes), /PCM/);
});

test('过短文件被拒绝', () => {
  assert.throws(() => parseWav(new Uint8Array(10)), /过短/);
  assert.throws(() => parseWav(new Uint8Array(0)), /过短/);
});

test('data 块奇数字节被拒绝', () => {
  const { bytes, view } = toView(makeWav(knownSamples(4, () => 1), 8000));
  view.setUint32(40, 7, true); // 声称 7 字节
  // 让 RIFF 长度字段与文件一致（36+7），仅保留“奇数 data”这一损坏点
  view.setUint32(4, 36 + 7, true);
  const cut = bytes.slice(0, 44 + 7);
  assert.throws(() => parseWav(cut), /奇数/);
});

test('块声明超出文件末尾被拒绝（结构损坏）', () => {
  const { bytes, view } = toView(makeWav(knownSamples(4, () => 1), 8000));
  view.setUint32(40, 99999, true);
  // RIFF 字段未同步修改，会在容器一致性或块越界校验处被拒
  assert.throws(() => parseWav(bytes), /(RIFF 长度字段|超出文件末尾)/);
});

test('RIFF 长度字段与文件不一致被拒绝（声明过大 / 尾部追加垃圾）', () => {
  const base = makeWav(knownSamples(4, () => 1), 8000);

  const tooBig = toView(base);
  tooBig.view.setUint32(4, 12345, true); // 声明远大于实际
  assert.throws(() => parseWav(tooBig.bytes), /RIFF 长度字段/);

  const garbage = new Uint8Array(base.length + 4);
  garbage.set(base, 0); // 尾部追加 4 字节垃圾但不更新 RIFF size
  assert.throws(() => parseWav(garbage), /RIFF 长度字段/);
});

test('多个 data 块被拒绝（不静默截断第一个）', () => {
  // 手工构造：fmt(16) + data(6: [10,20,30]) + data(4: [40,50])
  const body = [];
  const u16 = (v) => [v & 0xff, (v >> 1) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  body.push(
    ...ascii('fmt '), ...u32(16),
    ...u16(1), ...u16(1), ...u32(8000), ...u32(16000), ...u16(2), ...u16(16),
    ...ascii('data'), ...u32(6), ...u16(10), ...u16(20), ...u16(30),
    ...ascii('data'), ...u32(4), ...u16(40), ...u16(50),
  );
  const fileBytes = new Uint8Array([
    ...ascii('RIFF'), ...u32(4 + body.length), ...ascii('WAVE'), ...body,
  ]);
  assert.throws(() => parseWav(fileBytes), /多个 data 块/);
});

test('非 WAV 内容（随机字节 / 文本）被拒绝', () => {
  const text = new TextEncoder().encode('this is definitely not a wav file, just some plain text content');
  assert.throws(() => parseWav(text), WavFormatError);
  const random = new Uint8Array(64);
  for (let i = 0; i < random.length; i += 1) random[i] = (i * 37) & 0xff;
  assert.throws(() => parseWav(random), WavFormatError);
});

test('encodeWav 拒绝非法采样率与非 Int16Array 输入', () => {
  assert.throws(() => encodeWav(knownSamples(2, () => 1), 0), WavFormatError);
  assert.throws(() => encodeWav([1, 2, 3], 8000), WavFormatError);
  assert.throws(() => encodeWav(knownSamples(2, () => 1), 4294967297), WavFormatError);
  assert.throws(() => encodeWav(knownSamples(2, () => 1), 1.5), WavFormatError);
});

test('parseWav 接受 DataView 输入', () => {
  const bytes = makeWav(knownSamples(3, (i) => [11, -22, 33][i]), 8000);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { samples } = parseWav(view);
  assertSamplesEqual(samples, [11, -22, 33]);
});

test('parseWav 拒绝完全不支持的输入类型（抛 WavFormatError 而非 TypeError）', () => {
  assert.throws(() => parseWav('not-bytes'), WavFormatError);
  assert.throws(() => parseWav(12345), WavFormatError);
});

// ───────────────────── 完整导出流程（片段 → WAV → 重新解析 → 逐采样断言） ──

test('完整流程：渲染结果编码为 WAV 后逐采样、长度、来源位置全部可复现', () => {
  const sourceRaw = knownSamples(20, (i) => (i + 1) * 100); // 100..2000
  const sourceWav = makeWav(sourceRaw, 8000);
  const source = parseWav(sourceWav); // 模拟页面导入

  // 三段：两个不同区间 + 对第一段的重复引用，静音 4 samples（0.5ms @8000）
  const { samples: out, manifest } = renderClips({
    source: source.samples,
    sampleRate: source.sampleRate,
    clips: [
      { start: 0, end: 4, fadeInSamples: 2 },     // 100,200,300,400 → 50,200,300,400
      { start: 0, end: 4, fadeInSamples: 2 },     // 重复引用
      { start: 16, end: 20, fadeOutSamples: 2 },  // 1700..2000 → 1700,1800,1900,1000
    ],
    gapSamples: 4,
  });

  // 4+4+4+4+4 = 20
  const expected = [
    50, 200, 300, 400,
    0, 0, 0, 0,
    50, 200, 300, 400,
    0, 0, 0, 0,
    1700, 1800, 1900, 1000,
  ];
  assertSamplesEqual(out, expected);
  assert.equal(manifest.outputTotalSamples, 20);
  assert.equal(manifest.gapSamples, 4);

  // 编码导出 → 重新解析，模拟“导出新的 WAV 后再打开核对”
  const exported = encodeWav(out, source.sampleRate);
  const reopened = parseWav(exported);
  assert.equal(reopened.sampleRate, 8000);
  assertSamplesEqual(reopened.samples, expected);
  assert.equal(reopened.samples.length, 20, '输出长度精确');

  // 来源位置：每段的 source 与 output 区间
  assert.deepEqual(
    manifest.clips.map((c) => [c.sourceStart, c.sourceEnd, c.outputStart, c.outputEnd]),
    [
      [0, 4, 0, 4],
      [0, 4, 8, 12],
      [16, 20, 16, 20],
    ]
  );
  // 静音恰在 [4,8) 与 [12,16)
  for (const i of [4, 5, 6, 7, 12, 13, 14, 15]) assert.equal(reopened.samples[i], 0);

  // 原始素材未被修改
  assertSamplesEqual(source.samples, Array.from(sourceRaw));
});

test('完整流程：程序生成素材同样可导出且来源说明含所有必需字段', () => {
  const source = generateToneSource(8000, 1);
  const { samples, manifest } = renderClips({
    source,
    sampleRate: 8000,
    clips: [
      { start: 100, end: 200, fadeInMs: 2, fadeOutMs: 1 }, // 16 + 8 = 24 ≤ 100
      { start: 100, end: 200 },                            // 重复引用
    ],
    gapMs: 5, // 40 samples
  });
  assert.equal(samples.length, 100 + 40 + 100);

  // 导出 WAV 可重新解析
  const reopened = parseWav(encodeWav(samples, 8000));
  assert.equal(reopened.samples.length, 240);

  // 来源说明字段完整
  assert.equal(manifest.sampleRate, 8000);
  assert.equal(manifest.sourceTotalSamples, 8000);
  assert.equal(manifest.intervalConvention.includes('左闭右开'), true);
  assert.equal(manifest.rounding.includes('Math.round'), true);
  assert.equal(manifest.fadeRule.includes('(k+1)/F'), true);
  assert.equal(manifest.clips[0].fadeInSamples, 16);
  assert.equal(manifest.clips[0].fadeOutSamples, 8);
  assert.equal(manifest.clips[1].sourceStart, 100);
  assert.equal(manifest.clips[1].outputStart, 140);
  assert.equal(manifest.clips[1].outputEnd, 240);

  // 说明可 JSON 序列化（导出文件的实际形态）
  const json = JSON.stringify(manifest);
  const reparsed = JSON.parse(json);
  assert.equal(reparsed.outputTotalSamples, 240);
});
