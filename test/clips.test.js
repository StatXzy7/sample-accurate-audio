/**
 * clips.test.js — 片段校验、拼接、静音、淡化的采样级断言。
 *
 * 运行：node --test test/clips.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderClips,
  validateClip,
  msToSamples,
  samplesToMs,
  generateToneSource,
  ClipError,
  ERROR_CODES,
} from '../src/core/clips.js';
import { knownSamples, assertSamplesEqual } from './helpers.js';

const SR = 1000; // 1 ms = 1 sample，毫秒/采样换算极简，另有用 8000 的专门用例

// ───────────────────── 毫秒换算 ─────────────────────

test('msToSamples：四舍五入 half up（0.5 向上）', () => {
  assert.equal(msToSamples(0, 8000), 0);
  assert.equal(msToSamples(1, 8000), 8);
  assert.equal(msToSamples(0.5, 8000), 4);
  // 125001.5 / 1000 * 8000 = 1000012.0？另选能产生 .5 的值
  // 8000 采样率下：x/1000*8000 = 8x，恒整数；用 1001 采样率制造 .5
  assert.equal(msToSamples(500, 1001), 501); // 500/1000*1001 = 500.5 → 501
  assert.equal(msToSamples(1, 1001), 1);    // 1.001 → 1
  assert.equal(msToSamples(499.5, 1001), 500); // 499.5/1000*1001 = 500.0 → 500（检查非 tie 情形）
  assert.equal(msToSamples(100, 3), 0);     // 0.3 → 0
  assert.equal(msToSamples(200, 3), 1);     // 0.6 → 1
  // 半奇整数点：200ms/3... 0.6 非 tie；用 166.667 附近制造 tie：
  assert.equal(msToSamples(500, 3), 2);     // 1.5 → 2（half up）
  assert.equal(msToSamples(123.456789, 44100), Math.round(123.456789 / 1000 * 44100));
});

test('msToSamples：负数与非有限值被拒绝', () => {
  assert.throws(() => msToSamples(-1, 8000), (e) => e.code === ERROR_CODES.NEGATIVE_LENGTH);
  assert.throws(() => msToSamples(Number.NaN, 8000), (e) => e.code === ERROR_CODES.NON_INTEGER);
  assert.throws(() => msToSamples(Number.POSITIVE_INFINITY, 8000), (e) => e.code === ERROR_CODES.NON_INTEGER);
  assert.throws(() => msToSamples(1, 0), (e) => e.code === ERROR_CODES.BAD_SAMPLE_RATE);
  assert.throws(() => msToSamples(1, -8), (e) => e.code === ERROR_CODES.BAD_SAMPLE_RATE);
});

test('samplesToMs：与换算互逆（展示用）', () => {
  assert.equal(samplesToMs(8, 8000), 1);
  assert.equal(samplesToMs(441, 44100), 10);
});

// ───────────────────── 区间校验 ─────────────────────

test('validateClip：接受 [0,n) 全段与内部区间', () => {
  const src = knownSamples(10, (i) => i * 100);
  const ok = validateClip({ start: 0, end: 10 }, 10, SR);
  assert.equal(ok.start, 0);
  assert.equal(ok.end, 10);
  assert.equal(ok.fadeIn, 0);
  assert.equal(ok.fadeOut, 0);
  assert.doesNotThrow(() => validateClip({ start: 9, end: 10 }, 10, SR));
  assert.doesNotThrow(() => validateClip({ start: 0, end: 1 }, 10, SR));
});

test('零长度区间被拒绝（EMPTY_RANGE）', () => {
  assert.throws(
    () => validateClip({ start: 5, end: 5 }, 10, SR),
    (e) => e instanceof ClipError && e.code === ERROR_CODES.EMPTY_RANGE
  );
});

test('结束早于开始被拒绝（REVERSED_RANGE）', () => {
  assert.throws(
    () => validateClip({ start: 6, end: 2 }, 10, SR),
    (e) => e.code === ERROR_CODES.REVERSED_RANGE
  );
});

test('越界区间被拒绝（OUT_OF_RANGE）：start/end 等于素材长度也算越界（除 end==length 合法）', () => {
  // end === sourceLength 合法（最后一个可取索引为 length-1，区间不含 end）
  assert.doesNotThrow(() => validateClip({ start: 0, end: 10 }, 10, SR));
  assert.throws(() => validateClip({ start: 0, end: 11 }, 10, SR),
    (e) => e.code === ERROR_CODES.OUT_OF_RANGE);
  assert.throws(() => validateClip({ start: 10, end: 11 }, 10, SR),
    (e) => e.code === ERROR_CODES.OUT_OF_RANGE);
  assert.throws(() => validateClip({ start: -1, end: 5 }, 10, SR),
    (e) => e.code === ERROR_CODES.NEGATIVE_LENGTH);
});

test('非整数 / 非数字边界被拒绝', () => {
  assert.throws(() => validateClip({ start: 1.5, end: 3 }, 10, SR),
    (e) => e.code === ERROR_CODES.NON_INTEGER);
  assert.throws(() => validateClip({ start: '2', end: 3 }, 10, SR),
    (e) => e.code === ERROR_CODES.NON_INTEGER);
  assert.throws(() => validateClip(null, 10, SR),
    (e) => e.code === ERROR_CODES.NON_INTEGER);
});

// ───────────────────── 淡化规则 ─────────────────────

test('线性淡入：增益 (k+1)/F，起点 1/F 非零，长度不变', () => {
  // 源全为 1000；长度 4，F=4 → 250,500,750,1000
  const src = knownSamples(4, () => 1000);
  const { samples } = renderClips({
    source: src, sampleRate: SR,
    clips: [{ start: 0, end: 4, fadeInSamples: 4 }],
  });
  assertSamplesEqual(samples, [250, 500, 750, 1000]);
  assert.equal(samples.length, 4, '淡化不得改变片段长度');
});

test('线性淡出：末尾 1/F 非零、对称，长度不变', () => {
  const src = knownSamples(4, () => 1000);
  const { samples } = renderClips({
    source: src, sampleRate: SR,
    clips: [{ start: 0, end: 4, fadeOutSamples: 4 }],
  });
  // 1000,750,500,250
  assertSamplesEqual(samples, [1000, 750, 500, 250]);
  assert.equal(samples.length, 4);
});

test('淡入淡出同时存在且不重叠：中间保留原幅，端点规则正确', () => {
  // 长度 6，F_in=2，F_out=2
  // k=0: 1000*1/2=500
  // k=1: 1000*2/2=1000
  // k=2,3: 1000
  // k=4: 距末 1 → 1000*2/2=1000
  // k=5: 距末 0 → 1000*1/2=500
  const src = knownSamples(6, () => 1000);
  const { samples } = renderClips({
    source: src, sampleRate: SR,
    clips: [{ start: 0, end: 6, fadeInSamples: 2, fadeOutSamples: 2 }],
  });
  assertSamplesEqual(samples, [500, 1000, 1000, 1000, 1000, 500]);
});

test('淡化短于片段：仅改变两端，区间外采样原封不动', () => {
  // 长度 5，全 1000，F_in=1 → [1000(k0=1/1),1000...]（F=1 增益恒 1）
  // 改用 F_in=2：500,1000,1000,1000,1000
  const src = knownSamples(5, () => 1000);
  const { samples } = renderClips({
    source: src, sampleRate: SR,
    clips: [{ start: 0, end: 5, fadeInSamples: 2, fadeOutSamples: 1 }],
  });
  // fadeOut F=1：最后一个采样增益 1/1=1，故不变
  assertSamplesEqual(samples, [500, 1000, 1000, 1000, 1000]);
});

test('淡化范围重叠被拒绝（FADE_OVERLAP）', () => {
  const src = knownSamples(4, () => 1000);
  assert.throws(
    () => renderClips({
      source: src, sampleRate: SR,
      clips: [{ start: 0, end: 4, fadeInSamples: 3, fadeOutSamples: 2 }], // 5 > 4
    }),
    (e) => e.code === ERROR_CODES.FADE_OVERLAP
  );
  // 恰好相等允许（端点不相触，3+3=6 不行；2+2=4 允许）
  assert.doesNotThrow(() => renderClips({
    source: src, sampleRate: SR,
    clips: [{ start: 0, end: 4, fadeInSamples: 2, fadeOutSamples: 2 }],
  }));
});

test('淡入/淡出为负被拒绝（NEGATIVE_LENGTH）', () => {
  const src = knownSamples(4, () => 1000);
  assert.throws(
    () => renderClips({
      source: src, sampleRate: SR,
      clips: [{ start: 0, end: 4, fadeInSamples: -1 }],
    }),
    (e) => e.code === ERROR_CODES.NEGATIVE_LENGTH
  );
  assert.throws(
    () => renderClips({
      source: src, sampleRate: SR,
      clips: [{ start: 0, end: 4, fadeOutMs: -2 }],
    }),
    (e) => e.code === ERROR_CODES.NEGATIVE_LENGTH
  );
});

test('毫秒淡化按 half up 换算并生效', () => {
  // 采样率 1001：2ms → round(2.002)=2 samples
  const src = knownSamples(4, () => 1000);
  const { manifest } = renderClips({
    source: src, sampleRate: 1001,
    clips: [{ start: 0, end: 4, fadeInMs: 2 }],
  });
  assert.equal(manifest.clips[0].fadeInSamples, 2);
  assert.equal(manifest.clips[0].fadeInMs, samplesToMs(2, 1001));
});

test('淡化负值源：乘法对称，不产生偏移', () => {
  const src = knownSamples(4, () => -1000);
  const { samples } = renderClips({
    source: src, sampleRate: SR,
    clips: [{ start: 0, end: 4, fadeInSamples: 4 }],
  });
  assertSamplesEqual(samples, [-250, -500, -750, -1000]);
});

// ───────────────────── 拼接 / 静音 / 重排 / 重复 ─────────────────────

test('基础拼接：多片段按顺序首尾相接，左闭右开', () => {
  const src = knownSamples(10, (i) => i * 10); // 0,10,...,90
  const { samples, manifest } = renderClips({
    source: src, sampleRate: SR,
    clips: [
      { start: 0, end: 3 },   // 0,10,20
      { start: 5, end: 8 },   // 50,60,70
    ],
    gapSamples: 0,
  });
  assertSamplesEqual(samples, [0, 10, 20, 50, 60, 70]);
  assert.equal(manifest.outputTotalSamples, 6);
  assert.deepEqual(
    manifest.clips.map((c) => [c.outputStart, c.outputEnd]),
    [[0, 3], [3, 6]]
  );
  assert.deepEqual(
    manifest.clips.map((c) => [c.sourceStart, c.sourceEnd]),
    [[0, 3], [5, 8]]
  );
});

test('静音间隔：插入精确采样数的 0，输出位置正确', () => {
  const src = knownSamples(10, (i) => i * 10);
  const { samples, manifest } = renderClips({
    source: src, sampleRate: SR,
    clips: [
      { start: 0, end: 2 },   // 0,10
      { start: 8, end: 10 },  // 80,90
    ],
    gapSamples: 3,
  });
  assertSamplesEqual(samples, [0, 10, 0, 0, 0, 80, 90]);
  assert.equal(manifest.gapSamples, 3);
  assert.equal(manifest.outputTotalSamples, 7);
  const [a, b] = manifest.clips;
  assert.deepEqual([a.outputStart, a.outputEnd], [0, 2]);
  assert.deepEqual([b.outputStart, b.outputEnd], [5, 7]); // 2 + 3
});

test('三段 + 两个静音：每段输出位置连续可推', () => {
  const src = knownSamples(20, (i) => i + 1);
  const { samples, manifest } = renderClips({
    source: src, sampleRate: SR,
    clips: [
      { start: 0, end: 2 },   // 1,2
      { start: 10, end: 12 }, // 11,12
      { start: 18, end: 20 }, // 19,20
    ],
    gapSamples: 2,
  });
  // [1,2] 0,0 [11,12] 0,0 [19,20]
  assertSamplesEqual(samples, [1, 2, 0, 0, 11, 12, 0, 0, 19, 20]);
  assert.deepEqual(
    manifest.clips.map((c) => [c.outputStart, c.outputEnd]),
    [[0, 2], [4, 6], [8, 10]]
  );
});

test('gapMs 与 gapSamples 一致（half up）', () => {
  const src = knownSamples(20, (i) => i);
  const a = renderClips({
    source: src, sampleRate: 8000,
    clips: [{ start: 0, end: 2 }, { start: 5, end: 7 }],
    gapMs: 1, // 8 samples
  });
  const b = renderClips({
    source: src, sampleRate: 8000,
    clips: [{ start: 0, end: 2 }, { start: 5, end: 7 }],
    gapSamples: 8,
  });
  assertSamplesEqual(a.samples, b.samples);
  assert.equal(a.manifest.gapSamples, 8);
});

test('重复引用同一来源区间：输出出现两份相同采样，manifest 记录相同来源', () => {
  const src = knownSamples(6, (i) => (i + 1) * 100); // 100..600
  const { samples, manifest } = renderClips({
    source: src, sampleRate: SR,
    clips: [
      { start: 1, end: 4 }, // 200,300,400
      { start: 1, end: 4 }, // 200,300,400
    ],
  });
  assertSamplesEqual(samples, [200, 300, 400, 200, 300, 400]);
  assert.deepEqual(
    manifest.clips.map((c) => [c.sourceStart, c.sourceEnd]),
    [[1, 4], [1, 4]]
  );
  assert.deepEqual(
    manifest.clips.map((c) => [c.outputStart, c.outputEnd]),
    [[0, 3], [3, 6]]
  );
});

test('重排：交换片段顺序后输出顺序与位置同步变化', () => {
  const src = knownSamples(10, (i) => i + 1);
  const orderA = [
    { start: 0, end: 2 },  // 1,2
    { start: 8, end: 10 }, // 9,10
    { start: 4, end: 6 },  // 5,6
  ];
  const orderB = [orderA[2], orderA[0], orderA[1]];
  const rA = renderClips({ source: src, sampleRate: SR, clips: orderA, gapSamples: 1 });
  const rB = renderClips({ source: src, sampleRate: SR, clips: orderB, gapSamples: 1 });
  // A: 1,2,0,9,10,0,5,6
  assertSamplesEqual(rA.samples, [1, 2, 0, 9, 10, 0, 5, 6]);
  // B: 5,6,0,1,2,0,9,10
  assertSamplesEqual(rB.samples, [5, 6, 0, 1, 2, 0, 9, 10]);
  assert.deepEqual(
    rB.manifest.clips.map((c) => [c.sourceStart, c.sourceEnd, c.outputStart, c.outputEnd]),
    [[4, 6, 0, 2], [0, 2, 3, 5], [8, 10, 6, 8]]
  );
});

test('无片段导出被拒绝（NO_CLIPS），不产生输出数组', () => {
  const src = knownSamples(4, () => 1);
  assert.throws(
    () => renderClips({ source: src, sampleRate: SR, clips: [] }),
    (e) => e.code === ERROR_CODES.NO_CLIPS
  );
  assert.throws(
    () => renderClips({ source: src, sampleRate: SR }),
    (e) => e.code === ERROR_CODES.NO_CLIPS
  );
});

test('任一片段非法时整体拒绝，不产生部分结果', () => {
  const src = knownSamples(10, (i) => i);
  assert.throws(
    () => renderClips({
      source: src, sampleRate: SR,
      clips: [
        { start: 0, end: 2 },
        { start: 9, end: 9 }, // 零长度
      ],
    }),
    (e) => e.code === ERROR_CODES.EMPTY_RANGE
  );
  assert.throws(
    () => renderClips({
      source: src, sampleRate: SR,
      clips: [
        { start: 0, end: 2 },
        { start: 5, end: 4 }, // 反向
      ],
    }),
    (e) => e.code === ERROR_CODES.REVERSED_RANGE
  );
});

test('渲染不修改原始素材与输入片段对象', () => {
  const src = knownSamples(6, (i) => (i + 1) * 100);
  const srcCopy = src.slice();
  const clip = { start: 1, end: 5, fadeInSamples: 2, fadeOutSamples: 1 };
  const clipSnapshot = { ...clip };
  renderClips({ source: src, sampleRate: SR, clips: [clip], gapSamples: 4 });
  assertSamplesEqual(src, Array.from(srcCopy), '原始素材保持不变');
  assert.deepEqual(clip, clipSnapshot, '输入片段对象不被修改');
});

test('量化：增益产生非整数时 half up 取整到 Int16', () => {
  // 源 1001，F=4：1001*1/4=250.25→250；*2/4=500.5→501；*3/4=750.75→751；*4/4=1001
  const src = knownSamples(4, () => 1001);
  const { samples } = renderClips({
    source: src, sampleRate: SR,
    clips: [{ start: 0, end: 4, fadeInSamples: 4 }],
  });
  assertSamplesEqual(samples, [250, 501, 751, 1001]);
});

test('量化 tie 点正负对称：half away from zero（±x.5 均远离 0）', () => {
  // 正 tie：1001 * 1/2 = 500.5 → 501
  const pos = knownSamples(2, () => 1001);
  const rPos = renderClips({
    source: pos, sampleRate: SR,
    clips: [{ start: 0, end: 2, fadeInSamples: 2 }],
  });
  assertSamplesEqual(rPos.samples, [501, 1001]);

  // 负 tie：-1001 * 1/2 = -500.5 → -501（不是朝零的 -500）
  const neg = knownSamples(2, () => -1001);
  const rNeg = renderClips({
    source: neg, sampleRate: SR,
    clips: [{ start: 0, end: 2, fadeInSamples: 2 }],
  });
  assertSamplesEqual(rNeg.samples, [-501, -1001]);
});

test('超大静音导致输出超上限：抛 ClipError(OUTPUT_TOO_LONG) 而非原生 RangeError', () => {
  const src = knownSamples(2, () => 1);
  // sr=1000，gap 2e9 ms → 2e9 samples，两段总长 > 1e9 上限
  assert.throws(
    () => renderClips({
      source: src, sampleRate: SR,
      clips: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
      gapMs: 2_000_000_000,
    }),
    (e) => e instanceof ClipError && e.code === ERROR_CODES.OUTPUT_TOO_LONG
  );
});

test('上限内的正常输出不受影响', () => {
  const src = knownSamples(4, () => 1);
  const { samples } = renderClips({
    source: src, sampleRate: SR,
    clips: [{ start: 0, end: 2 }, { start: 2, end: 4 }],
    gapSamples: 2,
  });
  assertSamplesEqual(samples, [1, 1, 0, 0, 1, 1]);
});

test('程序生成素材可用且长度精确', () => {
  const tone = generateToneSource(8000, 1);
  assert.equal(tone.length, 8000);
  assert.ok(tone instanceof Int16Array);
  assert.equal(tone[0], 0); // sin(0)
});

test('输出长度恒等于各片段长度之和 + (n-1)*gap，淡化不改变长度', () => {
  const src = knownSamples(100, (i) => i);
  const { manifest, samples } = renderClips({
    source: src, sampleRate: SR,
    clips: [
      { start: 0, end: 10, fadeInSamples: 3, fadeOutSamples: 2 },
      { start: 50, end: 60, fadeInSamples: 5 },
      { start: 90, end: 100, fadeOutSamples: 1 },
    ],
    gapSamples: 7,
  });
  assert.equal(samples.length, 10 + 10 + 10 + 7 * 2);
  assert.equal(manifest.outputTotalSamples, samples.length);
});
