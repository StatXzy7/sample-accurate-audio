/**
 * 核心模型测试：片段 → 淡化 → 拼接 → 导出的完整流程，
 * 断言实际采样值、输出长度与来源位置。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialState,
  loadSource,
  addClip,
  updateClip,
  removeClip,
  moveClip,
  duplicateClip,
  setSilence,
  resetEdits,
  buildPlan,
  renderSamples,
  exportProject,
  msToSamples,
  samplesToMs,
  roundHalfAwayFromZero,
  validateRange,
  fadeGain,
  quantizeToInt16,
  resolveClip,
  generateSyntheticSource,
} from '../src/model.js';
import { decodeWav } from '../src/wav.js';
import { EditError, ErrorCode } from '../src/errors.js';

const SR = 8000;

/** 构造值等于下标的确定性素材：samples[i] = (i % 60000) - 30000，便于定位来源 */
function rampSource() {
  const samples = new Int16Array(10000);
  for (let i = 0; i < 10000; i += 1) samples[i] = i;
  return { samples, sampleRate: SR, name: 'ramp.wav' };
}

function loadedState(source = rampSource()) {
  return loadSource(createInitialState(), source);
}

function expectEditError(fn, code) {
  assert.throws(
    () => fn(),
    (err) => {
      assert.ok(err instanceof EditError, `应为 EditError，实际 ${err.constructor.name}: ${err.message}`);
      if (code) assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}（${err.message}）`);
      return true;
    },
  );
}

async function expectEditErrorAsync(promise, code) {
  await assert.rejects(
    promise,
    (err) => {
      assert.ok(err instanceof EditError);
      if (code) assert.equal(err.code, code);
      return true;
    },
  );
}

describe('毫秒换算与舍入', () => {
  test('roundHalfAwayFromZero：0.5 向上、-0.5 向下', () => {
    assert.equal(roundHalfAwayFromZero(0.5), 1);
    assert.equal(roundHalfAwayFromZero(1.5), 2);
    assert.equal(roundHalfAwayFromZero(2.4), 2);
    assert.equal(roundHalfAwayFromZero(-0.5), -1);
    assert.equal(roundHalfAwayFromZero(-1.5), -2);
  });

  test('8000Hz 下 msToSamples 的精确边界值', () => {
    assert.equal(msToSamples(0, SR), 0);
    assert.equal(msToSamples(1, SR), 8); // 0.001*8000
    assert.equal(msToSamples(0.0625, SR), 1); // 0.5 采样 → 向上 1
    assert.equal(msToSamples(0.06, SR), 0); // 0.48 采样 → 0
    assert.equal(msToSamples(2.5, SR), 20);
    assert.equal(msToSamples(125, SR), 1000);
  });

  test('负时长被拒绝', () => {
    expectEditError(() => msToSamples(-1, SR), ErrorCode.BAD_DURATION);
    expectEditError(() => msToSamples(NaN, SR), ErrorCode.BAD_DURATION);
  });

  test('换算可逆显示', () => {
    assert.equal(samplesToMs(8, SR), 1);
    assert.equal(samplesToMs(1000, SR), 125);
  });
});

describe('区间校验（左闭右开）', () => {
  test('合法区间返回长度', () => {
    assert.equal(validateRange(0, 1, 10), 1);
    assert.equal(validateRange(9999, 10000, 10000), 1); // 最后一个采样
    assert.equal(validateRange(0, 10000, 10000), 10000); // 整段
  });

  test('零长度被拒绝', () => {
    expectEditError(() => validateRange(100, 100, 10000), ErrorCode.BAD_RANGE);
    expectEditError(() => validateRange(0, 0, 10000), ErrorCode.BAD_RANGE);
  });

  test('结束早于开始被拒绝', () => {
    expectEditError(() => validateRange(500, 499, 10000), ErrorCode.BAD_RANGE);
  });

  test('越界被拒绝', () => {
    expectEditError(() => validateRange(-1, 10, 10000), ErrorCode.BAD_RANGE);
    expectEditError(() => validateRange(0, 10001, 10000), ErrorCode.BAD_RANGE);
    expectEditError(() => validateRange(10000, 10001, 10000), ErrorCode.BAD_RANGE);
    expectEditError(() => validateRange(10001, 10002, 10000), ErrorCode.BAD_RANGE);
  });

  test('非整数编号被拒绝', () => {
    expectEditError(() => validateRange(1.5, 2, 10000), ErrorCode.BAD_RANGE);
  });
});

describe('不可变编辑操作', () => {
  test('addClip 校验失败时原状态不变', () => {
    const s0 = loadedState();
    const before = s0.clips;
    expectEditError(() => addClip(s0, { start: 100, end: 100 }), ErrorCode.BAD_RANGE);
    assert.equal(s0.clips, before, '原 clips 引用应保持不变');
    assert.equal(s0.clips.length, 0);
  });

  test('updateClip 失败不覆盖当前有效编辑', () => {
    let s = loadedState();
    s = addClip(s, { start: 0, end: 100 });
    const id = s.clips[0].id;
    const goodClip = s.clips[0];
    expectEditError(() => updateClip(s, id, { start: 150 }), ErrorCode.BAD_RANGE); // 150 > end 100
    assert.deepEqual(s.clips[0], goodClip);
  });

  test('removeClip / moveClip / duplicateClip', () => {
    let s = loadedState();
    s = addClip(s, { start: 0, end: 10 });
    s = addClip(s, { start: 100, end: 110 });
    s = addClip(s, { start: 200, end: 210 });
    const [a, b, c] = s.clips.map((x) => x.id);

    // 后移 a：顺序变 b,a,c
    s = moveClip(s, a, 1);
    assert.deepEqual(s.clips.map((x) => x.id), [b, a, c]);
    // 继续后移越过末尾：保持原位
    const same = moveClip(s, c, 1);
    assert.equal(same, s);

    // 前移 b（现为第一个之后？b 在首位）→ 越过开头不变
    assert.equal(moveClip(s, b, -1), s);

    // 重复引用 a：同一来源区间，新 id，插在紧邻其后
    s = duplicateClip(s, a);
    const ids = s.clips.map((x) => x.id);
    assert.equal(ids.length, 4);
    assert.deepEqual([ids[0], ids[1], ids[3]], [b, a, c]);
    assert.notEqual(ids[2], a);
    assert.equal(s.clips[2].start, 0);
    assert.equal(s.clips[2].end, 10);
    assert.notEqual(s.clips[2].id, a);
    assert.equal(s.clips.length, 4);

    // 删除原始 a 后，重复引用仍在
    s = removeClip(s, a);
    assert.equal(s.clips.some((x) => x.id === a), false);
    assert.equal(s.clips.some((x) => x.start === 0 && x.end === 10), true);

    expectEditError(() => removeClip(s, 'nope'), ErrorCode.CLIP_NOT_FOUND);
  });

  test('setSilence 拒绝负数和非整数', () => {
    const s = loadedState();
    expectEditError(() => setSilence(s, -1), ErrorCode.NEGATIVE_SILENCE);
    expectEditError(() => setSilence(s, 1.5), ErrorCode.NEGATIVE_SILENCE);
    assert.equal(setSilence(s, 200).silenceSamples, 200);
  });
});

describe('淡化规则', () => {
  test('淡入端点：i=0 增益 0，i=F-1 为 (F-1)/F，i=F 在区外为 1', () => {
    const F = 8;
    assert.equal(fadeGain(0, 100, F, 0), 0);
    assert.equal(fadeGain(F - 1, 100, F, 0), (F - 1) / F);
    assert.equal(fadeGain(F, 100, F, 0), 1);
  });

  test('淡出端点：i=L-F 增益 1，i=L-1 为 1/F，右端点 i=L 不属片段', () => {
    const L = 100;
    const F = 8;
    assert.equal(fadeGain(L - F, L, 0, F), 1);
    assert.equal(fadeGain(L - 1, L, 0, F), 1 / F);
  });

  test('中间采样增益为 1，两端淡化相乘', () => {
    assert.equal(fadeGain(50, 100, 8, 8), 1);
    assert.equal(fadeGain(0, 100, 8, 8), 0); // 淡入 0 主导
    // 恰好相邻 F_in + F_out === L 允许：i=4 是淡入区外、淡出区首点，两式在此均为 1
    assert.equal(fadeGain(3, 8, 4, 4), 0.75); // 淡入区末点
    assert.equal(fadeGain(4, 8, 4, 4), 1); // 相邻交接点
    assert.equal(fadeGain(7, 8, 4, 4), 0.25); // 淡出区末点
  });

  test('淡化范围重叠被拒绝，恰好相邻允许', () => {
    const src = { sampleRate: SR, sampleCount: 1000 };
    expectEditError(
      () => resolveClip({ id: 'x', start: 0, end: 10, fadeInMs: 1, fadeOutMs: 1 }, src),
      ErrorCode.FADE_OVERLAP,
    ); // 8+8 > 10
    const ok = resolveClip({ id: 'x', start: 0, end: 16, fadeInMs: 1, fadeOutMs: 1 }, src);
    assert.equal(ok.fadeInSamples + ok.fadeOutSamples, 16);
  });

  test('淡化只改变幅度不改变长度：渲染长度恒等于片段长度', () => {
    let s = loadedState();
    s = addClip(s, { start: 0, end: 100, fadeInMs: 5, fadeOutMs: 5 }); // 40 + 40
    const plan = buildPlan(s);
    assert.equal(plan.totalSamples, 100);
    const out = renderSamples(s, plan);
    assert.equal(out.length, 100);
  });
});

describe('片段 → 导出完整流程（断言实际采样值）', () => {
  test('单片段无淡化：采样逐点等于来源', () => {
    let s = loadedState();
    s = addClip(s, { start: 100, end: 110 });
    const { samples, plan, manifest } = exportProject(s, 'out.wav');
    assert.equal(samples.length, 10);
    for (let i = 0; i < 10; i += 1) assert.equal(samples[i], 100 + i);
    assert.equal(plan.totalSamples, 10);
    const clipEntry = manifest.timeline.find((e) => e.type === 'clip');
    assert.deepEqual(
      [clipEntry.sourceStartSample, clipEntry.sourceEndSample, clipEntry.outputStartSample, clipEntry.outputEndSample],
      [100, 110, 0, 10],
    );
  });

  test('淡入首个采样为 0，第二个采样为源值/F（整数源下精确）', () => {
    let s = loadedState();
    s = addClip(s, { start: 0, end: 16, fadeInMs: 1 }); // F=8
    const { samples } = exportProject(s, 'out.wav');
    assert.equal(samples[0], 0);
    // 源 samples[i]=i，乘淡入增益 i/8 后为 i²/8，再 half-away 量化
    assert.equal(samples[1], quantizeToInt16((1 * 1) / 8)); // 0
    assert.equal(samples[2], quantizeToInt16((2 * 2) / 8)); // 0.5 → 1
    assert.equal(samples[6], quantizeToInt16((6 * 6) / 8)); // 4.5 → 5
    assert.equal(samples[7], quantizeToInt16((7 * 7) / 8)); // 6.125 → 6
    assert.equal(samples[8], 8); // 淡化区外，原值
    assert.equal(samples[15], 15);
  });

  test('淡出最后一个采样：源值 * 1/F，倒数第二 *(2/F)，淡化区后恢复', () => {
    let s = loadedState();
    s = addClip(s, { start: 0, end: 16, fadeOutMs: 1 }); // F=8
    const { samples } = exportProject(s, 'out.wav');
    assert.equal(samples[15], quantizeToInt16(15 / 8));
    assert.equal(samples[14], quantizeToInt16(14 * 2 / 8));
    assert.equal(samples[8], 8); // L-F = 8，增益 1
    assert.equal(samples[7], 7);
  });

  test('两片段 + 静音：长度、静音零值、第二段输出位置正确', () => {
    let s = loadedState();
    s = addClip(s, { start: 0, end: 10 });
    s = addClip(s, { start: 100, end: 105 });
    s = setSilence(s, 4);
    const { samples, plan, manifest } = exportProject(s, 'out.wav');

    assert.equal(plan.totalSamples, 10 + 4 + 5);
    assert.equal(samples.length, 19);
    // 第一段 0..9
    for (let i = 0; i < 10; i += 1) assert.equal(samples[i], i);
    // 静音 10..13 全零
    for (let i = 10; i < 14; i += 1) assert.equal(samples[i], 0, `位置 ${i} 应为静音`);
    // 第二段 14..18 来自源 100..104
    for (let i = 0; i < 5; i += 1) assert.equal(samples[14 + i], 100 + i);

    const clips = manifest.timeline.filter((e) => e.type === 'clip');
    const silence = manifest.timeline.find((e) => e.type === 'silence');
    assert.deepEqual([clips[0].outputStartSample, clips[0].outputEndSample], [0, 10]);
    assert.deepEqual([silence.outputStartSample, silence.outputEndSample, silence.lengthSamples], [10, 14, 4]);
    assert.deepEqual([clips[1].outputStartSample, clips[1].outputEndSample], [14, 19]);
    assert.deepEqual([clips[1].sourceStartSample, clips[1].sourceEndSample], [100, 105]);
  });

  test('重排后输出顺序与来源位置同步变化', () => {
    let s = loadedState();
    s = addClip(s, { start: 0, end: 10 }); // A 值 0..9
    s = addClip(s, { start: 100, end: 110 }); // B 值 100..109
    const [a, b] = s.clips.map((c) => c.id);
    s = moveClip(s, a, 1); // B, A
    const { samples } = exportProject(s, 'out.wav');
    assert.equal(samples.length, 20);
    for (let i = 0; i < 10; i += 1) assert.equal(samples[i], 100 + i);
    for (let i = 0; i < 10; i += 1) assert.equal(samples[10 + i], i);
    assert.equal(s.clips[0].id, b);
    assert.equal(s.clips[1].id, a);
  });

  test('重复引用同一来源区间两次：输出出现两遍相同采样', () => {
    let s = loadedState();
    s = addClip(s, { start: 500, end: 503 });
    const id = s.clips[0].id;
    s = duplicateClip(s, id);
    const { samples, manifest } = exportProject(s, 'out.wav');
    assert.equal(samples.length, 6);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(samples[i], 500 + i);
      assert.equal(samples[3 + i], 500 + i);
    }
    const clips = manifest.timeline.filter((e) => e.type === 'clip');
    assert.deepEqual([clips[0].sourceStartSample, clips[0].sourceEndSample], [500, 503]);
    assert.deepEqual([clips[1].sourceStartSample, clips[1].sourceEndSample], [500, 503]);
    assert.deepEqual([clips[0].outputStartSample, clips[1].outputStartSample], [0, 3]);
  });

  test('导出的 WAV 可被重新解码且采样一致（编解码往返）', () => {
    let s = loadedState();
    s = addClip(s, { start: 0, end: 20, fadeInMs: 1, fadeOutMs: 1 });
    const { wavBytes, samples } = exportProject(s, 'out.wav');
    const decoded = decodeWav(wavBytes);
    assert.equal(decoded.sampleRate, SR);
    assert.equal(decoded.samples.length, samples.length);
    for (let i = 0; i < samples.length; i += 1) assert.equal(decoded.samples[i], samples[i]);
  });

  test('无片段不能导出（不会伪装成功）', () => {
    const s = loadedState();
    expectEditError(() => exportProject(s, 'out.wav'), ErrorCode.EMPTY_PLAN);
    expectEditError(() => buildPlan(s), ErrorCode.EMPTY_PLAN);
  });
});

describe('原始素材保持不变', () => {
  test('渲染含淡化与静音后，源 samples 不被修改', () => {
    const source = rampSource();
    const snapshot = source.samples.slice();
    let s = loadSource(createInitialState(), source);
    s = addClip(s, { start: 0, end: 100, fadeInMs: 5, fadeOutMs: 5 });
    s = setSilence(s, 10);
    s = addClip(s, { start: 9000, end: 10000 });
    exportProject(s, 'out.wav');
    assert.equal(source.samples.length, snapshot.length);
    for (let i = 0; i < snapshot.length; i += 1) {
      assert.equal(source.samples[i], snapshot[i], `源采样 ${i} 被修改`);
    }
  });
});

describe('恢复原始编辑状态', () => {
  test('resetEdits 清空片段与静音，素材保留', () => {
    let s = loadedState();
    s = addClip(s, { start: 0, end: 10 });
    s = setSilence(s, 99);
    s = resetEdits(s);
    assert.equal(s.clips.length, 0);
    assert.equal(s.silenceSamples, 0);
    assert.ok(s.source);
    expectEditError(() => buildPlan(s), ErrorCode.EMPTY_PLAN);
  });

  test('非法操作后再 reset 仍可得到干净可用状态', () => {
    let s = loadedState();
    s = addClip(s, { start: 0, end: 10 });
    expectEditError(() => setSilence(s, -5), ErrorCode.NEGATIVE_SILENCE);
    s = resetEdits(s);
    s = addClip(s, { start: 1, end: 3 });
    const plan = buildPlan(s);
    assert.equal(plan.totalSamples, 2);
  });
});

describe('生成素材', () => {
  test('合成素材为 8000 个 16 位采样、8000Hz，采样 0 为 0', () => {
    const g = generateSyntheticSource();
    assert.equal(g.sampleRate, 8000);
    assert.equal(g.samples.length, 8000);
    assert.equal(g.samples[0], 0);
    assert.ok(Math.abs(g.samples[100]) <= 10000);
  });
});
