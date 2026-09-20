/**
 * 端到端集成测试：按页面真实使用顺序串起完整流程，
 * 并在中途插入非法操作，验证当前有效编辑不被覆盖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialState,
  loadSource,
  addClip,
  updateClip,
  moveClip,
  duplicateClip,
  setSilence,
  exportProject,
  generateSyntheticSource,
  msToSamples,
  quantizeToInt16,
} from '../src/model.js';
import { encodeWav, decodeWav } from '../src/wav.js';
import { ErrorCode } from '../src/errors.js';

function throwsCode(fn, code) {
  assert.throws(fn, (e) => e.code === code);
}

describe('端到端：从加载到导出（含非法操作不覆盖）', () => {
  test('完整用户旅程，最终逐采样核对输出与清单位置', () => {
    // 1) 页面“加载生成素材”：先生成 → 编码 WAV → 再解码（与按钮路径一致）
    const g = generateSyntheticSource();
    const wav = encodeWav(g.samples, g.sampleRate);
    const decoded = decodeWav(wav);
    assert.equal(decoded.samples.length, 8000);

    let state = loadSource(createInitialState(), {
      name: 'synthetic-8000Hz-1s.wav',
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
      bytes: decoded.bytes,
      hash: 'testhash',
    });

    // 2) 建立两个片段
    state = addClip(state, { start: 0, end: 4000, fadeInMs: 2, fadeOutMs: 1 }); // 低音节
    state = addClip(state, { start: 4000, end: 8000, fadeInMs: 1, fadeOutMs: 2 }); // 高音节
    assert.equal(state.clips.length, 2);

    // 3) 一连串非法操作：均不得改变当前有效编辑
    const snapshot = JSON.stringify(state.clips);
    throwsCode(() => addClip(state, { start: 5000, end: 5000 }), ErrorCode.BAD_RANGE); // 零长度
    throwsCode(() => addClip(state, { start: 7000, end: 9000 }), ErrorCode.BAD_RANGE); // 越界
    throwsCode(() => addClip(state, { start: 100, end: 90 }), ErrorCode.BAD_RANGE); // 结束早
    throwsCode(
      () => addClip(state, { start: 0, end: 10, fadeInMs: 1, fadeOutMs: 1 }),
      ErrorCode.FADE_OVERLAP,
    ); // 8+8>10
    throwsCode(() => setSilence(state, -3), ErrorCode.NEGATIVE_SILENCE);
    assert.equal(JSON.stringify(state.clips), snapshot, '非法操作后片段状态必须保持不变');
    assert.equal(state.silenceSamples, 0);

    // 4) 重排：把第二片段前移
    const [a, b] = state.clips.map((c) => c.id);
    state = moveClip(state, b, -1);
    assert.deepEqual(state.clips.map((c) => c.id), [b, a]);

    // 5) 重复引用高音节（现排第一），得到三段
    state = duplicateClip(state, b);
    assert.equal(state.clips.length, 3);
    assert.deepEqual(state.clips.map((c) => [c.start, c.end]), [[4000, 8000], [4000, 8000], [0, 4000]]);

    // 6) 设置相邻静音 80 采样（10ms @8000Hz）
    state = setSilence(state, 80);

    // 7) 导出
    const { wavBytes, samples, manifest, plan } = exportProject(state, 'journey.wav');

    // 8) 输出长度：4000*3 + 80*2
    assert.equal(plan.totalSamples, 12160);
    assert.equal(samples.length, 12160);
    assert.equal(manifest.output.totalSamples, 12160);

    // 9) 重新解码导出的 WAV，逐采样核对
    const reparsed = decodeWav(wavBytes);
    assert.equal(reparsed.sampleRate, 8000);
    assert.equal(reparsed.samples.length, 12160);
    for (let i = 0; i < 12160; i += 1) {
      assert.equal(reparsed.samples[i], samples[i], `输出采样 ${i} 不一致`);
    }

    // 10) 手工核对关键位置：
    // 布局：[高音 4000][静音 80][高音 4000][静音 80][低音 4000]
    // 第一片段淡入 F=8：输出 0 处为 0；位置 7 = 源4007 * 7/8
    assert.equal(samples[0], 0);
    assert.equal(samples[7], quantizeToInt16(decoded.samples[4007] * (7 / 8)));
    // 第一片段淡出 F=16（2ms）：最后一个采样 3999 = 源7999 * 1/16
    assert.equal(samples[3999], quantizeToInt16(decoded.samples[7999] * (1 / 16)));
    // 静音区 4000..4079 与 8080..8159 全零
    for (let i = 4000; i < 4080; i += 1) assert.equal(samples[i], 0);
    // 第二段（重复引用）输出起点 4080 仍是源 4000 起的淡入
    assert.equal(samples[4080], 0);
    assert.equal(samples[4087], quantizeToInt16(decoded.samples[4007] * (7 / 8)));
    // 第三片段（低音，淡入 F=16）输出起点 8160
    assert.equal(samples[8160], 0);
    assert.equal(samples[8160 + 15], quantizeToInt16(decoded.samples[15] * (15 / 16)));
    // 最末采样：低音节淡出 F=8 → 源3999 * 1/8
    assert.equal(samples[12159], quantizeToInt16(decoded.samples[3999] * (1 / 8)));

    // 11) 清单时间线位置
    const clips = manifest.timeline.filter((e) => e.type === 'clip');
    assert.deepEqual(clips.map((e) => [e.outputStartSample, e.outputEndSample]), [
      [0, 4000],
      [4080, 8080],
      [8160, 12160],
    ]);
    assert.deepEqual(clips.map((e) => [e.sourceStartSample, e.sourceEndSample]), [
      [4000, 8000],
      [4000, 8000],
      [0, 4000],
    ]);
    const silences = manifest.timeline.filter((e) => e.type === 'silence');
    assert.deepEqual(silences.map((e) => [e.outputStartSample, e.outputEndSample, e.lengthSamples]), [
      [4000, 4080, 80],
      [8080, 8160, 80],
    ]);

    // 12) 原始素材未被修改
    assert.equal(g.samples[4007], decoded.samples[4007]);
    assert.equal(g.samples.length, 8000);

    // 13) 毫秒换算记录正确（2ms @8000 = 16，1ms = 8）
    assert.equal(msToSamples(2, 8000), 16);
    assert.equal(msToSamples(1, 8000), 8);
  });

  test('无片段状态导出被拒绝且不产生任何字节', () => {
    let state = loadSource(
      createInitialState(),
      { samples: new Int16Array([1, 2, 3]), sampleRate: 8000, name: 'x.wav' },
    );
    throwsCode(() => exportProject(state, 'x.wav'), ErrorCode.EMPTY_PLAN);
    // 空状态下 updateClip 也应报找不到片段而非崩溃
    throwsCode(() => updateClip(state, 'missing', { end: 2 }), ErrorCode.CLIP_NOT_FOUND);
  });
});
