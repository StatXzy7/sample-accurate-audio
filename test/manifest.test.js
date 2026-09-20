/**
 * 来源说明（manifest）与“按清单复现”测试。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialState,
  loadSource,
  addClip,
  setSilence,
  moveClip,
  duplicateClip,
  exportProject,
} from '../src/model.js';
import { decodeWav } from '../src/wav.js';

function rampSource(n = 5000) {
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i += 1) samples[i] = (i % 20000) - 10000;
  return { samples, sampleRate: 8000, name: 'speech.wav' };
}

describe('manifest 来源说明', () => {
  test('记录输出规格、素材信息、换算约定', () => {
    let s = loadSource(createInitialState(), rampSource());
    s = addClip(s, { start: 0, end: 10 });
    const { manifest } = exportProject(s, 'train.wav');
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.output.fileName, 'train.wav');
    assert.equal(manifest.output.sampleRate, 8000);
    assert.equal(manifest.output.bitsPerSample, 16);
    assert.equal(manifest.output.channels, 1);
    assert.equal(manifest.source.name, 'speech.wav');
    assert.equal(manifest.source.sampleCount, 5000);
    assert.match(manifest.conventions.interval, /左闭右开/);
    assert.match(manifest.conventions.msToSamples, /roundHalfAwayFromZero/);
    assert.equal(manifest.conventions.fadesOnlyScaleAmplitude, true);
  });

  test('时间线逐条覆盖片段与静音，时间值与采样编号一致', () => {
    let s = loadSource(createInitialState(), rampSource());
    s = addClip(s, { start: 100, end: 110, fadeInMs: 1, fadeOutMs: 0 }); // F_in=8
    s = addClip(s, { start: 200, end: 203 });
    s = setSilence(s, 16);
    const { manifest } = exportProject(s, 'train.wav');
    const tl = manifest.timeline;

    assert.equal(tl[0].type, 'clip');
    assert.deepEqual([tl[0].sourceStartSample, tl[0].sourceEndSample], [100, 110]);
    assert.equal(tl[0].fadeInSamples, 8);
    assert.deepEqual([tl[0].outputStartSample, tl[0].outputEndSample], [0, 10]);
    assert.equal(tl[0].sourceStartMs, 12.5);
    assert.equal(tl[0].order, 1);

    assert.equal(tl[1].type, 'silence');
    assert.equal(tl[1].lengthSamples, 16);
    assert.deepEqual([tl[1].outputStartSample, tl[1].outputEndSample], [10, 26]);

    assert.equal(tl[2].type, 'clip');
    assert.deepEqual([tl[2].sourceStartSample, tl[2].sourceEndSample], [200, 203]);
    assert.deepEqual([tl[2].outputStartSample, tl[2].outputEndSample], [26, 29]);
    assert.equal(tl[2].order, 2);

    assert.equal(manifest.output.totalSamples, 29);
  });

  test('静音为 0 时不产生 silence 条目，仅标记零间隙', () => {
    let s = loadSource(createInitialState(), rampSource());
    s = addClip(s, { start: 0, end: 5 });
    s = addClip(s, { start: 9, end: 12 });
    const { manifest } = exportProject(s, 't.wav');
    assert.equal(manifest.timeline.filter((e) => e.type === 'clip').length, 2);
    assert.equal(manifest.timeline.filter((e) => e.type === 'silence').length, 0);
    const gap = manifest.timeline.find((e) => e.type === 'gap');
    assert.ok(gap);
    assert.equal(gap.outputStartSample, 5);
  });
});

describe('按清单可复现（独立重渲染）', () => {
  test('仅依据 manifest.timeline + 原始素材即可重建逐点相同输出', () => {
    const source = rampSource();
    let s = loadSource(createInitialState(), source);
    s = addClip(s, { start: 0, end: 40, fadeInMs: 2, fadeOutMs: 1 }); // 16 / 8
    s = addClip(s, { start: 1000, end: 1020, fadeOutMs: 2 });
    s = setSilence(s, 7);
    s = duplicateClip(s, s.clips[1].id);
    s = moveClip(s, s.clips[0].id, 1);

    const { wavBytes, samples, manifest } = exportProject(s, 't.wav');
    const exported = decodeWav(wavBytes).samples;

    // 独立地按 manifest 重建（不调用 renderSamples），验证清单足以复现
    const rebuilt = new Int16Array(manifest.output.totalSamples);
    for (const e of manifest.timeline) {
      if (e.type !== 'clip') continue;
      const L = e.sourceEndSample - e.sourceStartSample;
      for (let i = 0; i < L; i += 1) {
        let gain = 1;
        if (i < e.fadeInSamples) gain *= i / e.fadeInSamples;
        if (i >= L - e.fadeOutSamples) gain *= (L - i) / e.fadeOutSamples;
        const v = source.samples[e.sourceStartSample + i] * gain;
        const q = v >= 32767 ? 32767 : v <= -32768 ? -32768
          : v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5);
        rebuilt[e.outputStartSample + i] = q;
      }
    }

    assert.equal(rebuilt.length, exported.length);
    assert.equal(rebuilt.length, samples.length);
    let mismatches = 0;
    for (let i = 0; i < rebuilt.length; i += 1) {
      if (rebuilt[i] !== exported[i]) mismatches += 1;
    }
    assert.equal(mismatches, 0);

    // 静音区严格为零
    const silenceEntry = manifest.timeline.find((e) => e.type === 'silence');
    for (let i = silenceEntry.outputStartSample; i < silenceEntry.outputEndSample; i += 1) {
      assert.equal(exported[i], 0);
    }
  });
});
