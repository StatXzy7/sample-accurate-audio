/**
 * 片段编辑核心模型（纯函数，浏览器与 Node 共用，不依赖任何外部库）。
 *
 * ── 全局约定 ────────────────────────────────────────────────────────
 * 1. 所有片段区间为左闭右开 [start, end)：包含采样 start，不包含采样 end；
 *    片段长度 length = end - start；源合法采样编号为 0 .. sampleCount-1。
 * 2. 毫秒 → 采样数：roundHalfAwayFromZero(ms / 1000 * sampleRate)，
 *    即四舍五入，小数点恰为 0.5 时向远离 0 的方向进位（毫秒输入不允许负数，
 *    因此实际表现为“0.5 向上取整”）。
 * 3. 线性淡化端点（只乘幅度，绝不改变片段长度）：
 *    - 淡入 F 个采样占据片段下标 0 .. F-1，增益 gain(i) = i / F（i=0 为 0，
 *      i=F 时为 1，而 i=F 已在淡化区之外）。
 *    - 淡出 F 个采样占据下标 L-F .. L-1，增益 gain(i) = (L - i) / F
 *      （i=L-F 时为 1；i=L 时为 0，而 i=L 是不包含在片段内的右端点）。
 *    - F=0 表示不淡化；两段淡化重叠（F_in + F_out > L）将被拒绝；
 *      恰好相邻（F_in + F_out === L）允许。
 * 4. 淡化总增益 = 淡入增益 × 淡出增益，逐采样相乘。
 * 5. 浮点幅度量化为 16 位：先夹到 [-32768, 32767]，再做 half-away-from-zero。
 * ───────────────────────────────────────────────────────────────────
 */
import { EditError, ErrorCode } from './errors.js';
import { encodeWav } from './wav.js';

let idCounter = 0;
function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  idCounter += 1;
  return `clip-${Date.now().toString(36)}-${idCounter}`;
}

/** 四舍五入，0.5 向远离 0 方向进位（正数即向上）。 */
export function roundHalfAwayFromZero(x) {
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

/**
 * 毫秒 → 采样数（四舍五入，0.5 向上）。
 * @param {number} ms 非负毫秒数（允许小数）
 */
export function msToSamples(ms, sampleRate) {
  if (!Number.isFinite(ms)) {
    throw new EditError(ErrorCode.BAD_DURATION, '时长必须是有限数字');
  }
  if (ms < 0) {
    throw new EditError(ErrorCode.BAD_DURATION, `时长不能为负数（收到 ${ms} ms）`);
  }
  return roundHalfAwayFromZero((ms / 1000) * sampleRate);
}

/** 采样数 → 毫秒（仅用于显示，保留浮点，不做舍入）。 */
export function samplesToMs(samples, sampleRate) {
  return (samples / sampleRate) * 1000;
}

/** 采样数 → 秒（显示用）。 */
export function samplesToSeconds(samples, sampleRate) {
  return samples / sampleRate;
}

function assertInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new EditError(ErrorCode.BAD_RANGE, `${label}必须是整数采样编号（收到 ${value}）`);
  }
}

/**
 * 校验左闭右开区间 [start,end)：拒绝零长度、越界、结束早于开始。
 * @returns {number} 区间长度
 */
export function validateRange(start, end, sampleCount) {
  assertInteger(start, '起点');
  assertInteger(end, '终点');
  if (start < 0 || start > sampleCount) {
    throw new EditError(ErrorCode.BAD_RANGE, `起点 ${start} 越界（源共 ${sampleCount} 个采样，编号 0..${sampleCount - 1}）`);
  }
  if (end < 0 || end > sampleCount) {
    throw new EditError(ErrorCode.BAD_RANGE, `终点 ${end} 越界（源共 ${sampleCount} 个采样，区间右端点最大为 ${sampleCount}）`);
  }
  if (end < start) {
    throw new EditError(ErrorCode.BAD_RANGE, `结束（${end}）早于开始（${start}）`);
  }
  if (end === start) {
    throw new EditError(ErrorCode.BAD_RANGE, `零长度区间 [${start}, ${start}) 无效`);
  }
  return end - start;
}

/** 量化到 16 位整数：先夹取再四舍五入。 */
export function quantizeToInt16(value) {
  if (value >= 32767) return 32767;
  if (value <= -32768) return -32768;
  return roundHalfAwayFromZero(value);
}

/**
 * 解析并校验一个片段，返回以采样点表示的不可变解析结果。
 * @returns {{id:string,startSample:number,endSample:number,length:number,fadeInSamples:number,fadeOutSamples:number}}
 */
export function resolveClip(clip, source) {
  const length = validateRange(clip.start, clip.end, source.sampleCount);
  const fadeInSamples = msToSamples(clip.fadeInMs, source.sampleRate);
  const fadeOutSamples = msToSamples(clip.fadeOutMs, source.sampleRate);
  if (fadeInSamples + fadeOutSamples > length) {
    throw new EditError(
      ErrorCode.FADE_OVERLAP,
      `片段 [${clip.start}, ${clip.end}) 长 ${length} 采样，淡入 ${fadeInSamples} + 淡出 ${fadeOutSamples} 超出长度，淡化范围不得重叠`,
    );
  }
  return {
    id: clip.id,
    startSample: clip.start,
    endSample: clip.end,
    length,
    fadeInSamples,
    fadeOutSamples,
  };
}

/**
 * 创建空编辑状态。source 为 null 时尚未加载素材。
 * baseline 保存“素材刚加载时”的编辑状态，用于一键恢复原始编辑。
 */
export function createInitialState() {
  return {
    source: null,
    clips: [],
    silenceSamples: 0,
    baseline: { clips: [], silenceSamples: 0 },
  };
}

function requireSource(state) {
  if (!state.source) {
    throw new EditError(ErrorCode.BAD_RANGE, '尚未加载音频素材');
  }
  return state.source;
}

/**
 * 加载素材，进入全新的编辑会话（清空片段与静音设置，重置基线）。
 * 原始 samples/bytes 以只读方式引用，本模块从不修改它们。
 */
export function loadSource(state, source) {
  if (!source || !Number.isInteger(source.sampleRate) || source.sampleRate <= 0) {
    throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, '素材采样率无效');
  }
  if (!(source.samples instanceof Int16Array)) {
    throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, '素材样本必须是 Int16Array');
  }
  const nextSource = {
    name: source.name,
    sampleRate: source.sampleRate,
    sampleCount: source.samples.length,
    samples: source.samples,
    bytes: source.bytes ?? null,
    hash: source.hash ?? null,
  };
  return {
    source: nextSource,
    clips: [],
    silenceSamples: 0,
    baseline: { clips: [], silenceSamples: 0 },
  };
}

/** 追加片段；完整校验通过才提交，失败时原状态不变。 */
export function addClip(state, fields) {
  const source = requireSource(state);
  const clip = {
    id: newId(),
    start: fields.start,
    end: fields.end,
    fadeInMs: fields.fadeInMs ?? 0,
    fadeOutMs: fields.fadeOutMs ?? 0,
  };
  resolveClip(clip, source); // 校验（不通过则抛错，调用方保留原状态）
  return { ...state, clips: [...state.clips, clip] };
}

/** 修改片段（区间/淡化）；校验失败时原状态不变。 */
export function updateClip(state, id, patch) {
  requireSource(state);
  const index = state.clips.findIndex((c) => c.id === id);
  if (index < 0) {
    throw new EditError(ErrorCode.CLIP_NOT_FOUND, `找不到片段 ${id}`);
  }
  const merged = { ...state.clips[index], ...patch, id };
  resolveClip(merged, state.source);
  const clips = state.clips.slice();
  clips[index] = merged;
  return { ...state, clips };
}

/** 删除片段。 */
export function removeClip(state, id) {
  const index = state.clips.findIndex((c) => c.id === id);
  if (index < 0) {
    throw new EditError(ErrorCode.CLIP_NOT_FOUND, `找不到片段 ${id}`);
  }
  return { ...state, clips: state.clips.filter((c) => c.id !== id) };
}

/**
 * 调整片段顺序。delta < 0 前移，delta > 0 后移；越过两端则保持原位。
 */
export function moveClip(state, id, delta) {
  const from = state.clips.findIndex((c) => c.id === id);
  if (from < 0) {
    throw new EditError(ErrorCode.CLIP_NOT_FOUND, `找不到片段 ${id}`);
  }
  const to = from + Math.sign(delta);
  if (to < 0 || to >= state.clips.length) return state;
  const clips = state.clips.slice();
  const [item] = clips.splice(from, 1);
  clips.splice(to, 0, item);
  return { ...state, clips };
}

/**
 * 重复引用：在当前片段紧邻其后插入一份指向同一来源区间的新片段
 * （新 id，区间/淡化参数相同）。
 */
export function duplicateClip(state, id) {
  const index = state.clips.findIndex((c) => c.id === id);
  if (index < 0) {
    throw new EditError(ErrorCode.CLIP_NOT_FOUND, `找不到片段 ${id}`);
  }
  const original = state.clips[index];
  const copy = { ...original, id: newId() };
  const clips = [...state.clips.slice(0, index + 1), copy, ...state.clips.slice(index + 1)];
  return { ...state, clips };
}

/** 设置相邻片段间静音采样数（非负整数）。 */
export function setSilence(state, silenceSamples) {
  if (!Number.isInteger(silenceSamples)) {
    throw new EditError(ErrorCode.NEGATIVE_SILENCE, `静音长度必须是整数采样数（收到 ${silenceSamples}）`);
  }
  if (silenceSamples < 0) {
    throw new EditError(ErrorCode.NEGATIVE_SILENCE, `静音长度不能为负（收到 ${silenceSamples}）`);
  }
  return { ...state, silenceSamples };
}

/** 恢复到素材刚加载时的原始编辑状态（清空片段与静音设置）。 */
export function resetEdits(state) {
  if (!state.source) return createInitialState();
  return {
    ...state,
    clips: state.baseline.clips.map((c) => ({ ...c })),
    silenceSamples: state.baseline.silenceSamples,
  };
}

/**
 * 构建拼接计划：解析全部片段并计算总长度。
 * 无片段时拒绝（禁止导出伪装成功的空音频）。
 */
export function buildPlan(state) {
  const source = requireSource(state);
  if (state.clips.length === 0) {
    throw new EditError(ErrorCode.EMPTY_PLAN, '尚无片段，无法导出');
  }
  if (!Number.isInteger(state.silenceSamples) || state.silenceSamples < 0) {
    throw new EditError(ErrorCode.NEGATIVE_SILENCE, '静音长度无效');
  }
  const items = state.clips.map((clip) => resolveClip(clip, source));
  const clipsLength = items.reduce((sum, item) => sum + item.length, 0);
  const totalSamples = clipsLength + state.silenceSamples * (items.length - 1);
  return {
    sampleRate: source.sampleRate,
    totalSamples,
    silenceSamples: state.silenceSamples,
    items,
  };
}

/** 片段内某采样（相对片段起点）的淡化增益。 */
export function fadeGain(relativeIndex, length, fadeInSamples, fadeOutSamples) {
  let gain = 1;
  if (fadeInSamples > 0 && relativeIndex < fadeInSamples) {
    gain *= relativeIndex / fadeInSamples;
  }
  if (fadeOutSamples > 0 && relativeIndex >= length - fadeOutSamples) {
    gain *= (length - relativeIndex) / fadeOutSamples;
  }
  return gain;
}

/**
 * 按计划渲染最终 16 位波形。静音段天然为 0（新建 Int16Array）。
 * 淡化只乘幅度：每个片段写入采样数恒为 length，位置由计划决定。
 */
export function renderSamples(state, plan) {
  const source = requireSource(state);
  if (source.samples.length !== source.sampleCount || source.sampleRate !== plan.sampleRate) {
    throw new EditError(ErrorCode.SOURCE_MISMATCH, '计划与当前素材不一致（采样率或长度变化）');
  }
  const output = new Int16Array(plan.totalSamples);
  let cursor = 0;
  plan.items.forEach((item, itemIndex) => {
    for (let i = 0; i < item.length; i += 1) {
      const gain = fadeGain(i, item.length, item.fadeInSamples, item.fadeOutSamples);
      const original = source.samples[item.startSample + i];
      output[cursor + i] = quantizeToInt16(original * gain);
    }
    cursor += item.length;
    if (itemIndex < plan.items.length - 1) {
      cursor += plan.silenceSamples; // 该区间保持全 0
    }
  });
  return output;
}

/**
 * 构建时间线（来源说明的机器可读部分）：
 * 逐条记录每段在最终输出中的 [outputStart, outputEnd)，以及片段间静音。
 */
export function buildTimeline(state, plan) {
  const entries = [];
  let cursor = 0;
  plan.items.forEach((item, index) => {
    const clip = state.clips[index];
    entries.push({
      type: 'clip',
      clipId: clip.id,
      order: index + 1,
      sourceStartSample: item.startSample,
      sourceEndSample: item.endSample,
      sourceStartMs: samplesToMs(item.startSample, plan.sampleRate),
      sourceEndMs: samplesToMs(item.endSample, plan.sampleRate),
      fadeInSamples: item.fadeInSamples,
      fadeOutSamples: item.fadeOutSamples,
      fadeInMs: clip.fadeInMs,
      fadeOutMs: clip.fadeOutMs,
      lengthSamples: item.length,
      outputStartSample: cursor,
      outputEndSample: cursor + item.length,
      outputStartMs: samplesToMs(cursor, plan.sampleRate),
      outputEndMs: samplesToMs(cursor + item.length, plan.sampleRate),
    });
    cursor += item.length;
    if (index < plan.items.length - 1 && plan.silenceSamples > 0) {
      entries.push({
        type: 'silence',
        afterClipId: clip.id,
        lengthSamples: plan.silenceSamples,
        lengthMs: samplesToMs(plan.silenceSamples, plan.sampleRate),
        outputStartSample: cursor,
        outputEndSample: cursor + plan.silenceSamples,
      });
      cursor += plan.silenceSamples;
    } else if (index < plan.items.length - 1) {
      entries.push({
        type: 'gap',
        afterClipId: clip.id,
        lengthSamples: 0,
        outputStartSample: cursor,
        outputEndSample: cursor,
      });
    }
  });
  return entries;
}

/**
 * 汇总来源说明（manifest）。记录素材指纹、换算规则、每段来源区间、
 * 静音长度与最终输出位置，保证可复现。
 */
export function buildManifest(state, plan, exportedWavName) {
  const source = requireSource(state);
  return {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    output: {
      fileName: exportedWavName,
      sampleRate: plan.sampleRate,
      channels: 1,
      bitsPerSample: 16,
      encoding: 'PCM',
      totalSamples: plan.totalSamples,
      durationMs: samplesToMs(plan.totalSamples, plan.sampleRate),
    },
    source: {
      name: source.name,
      sampleRate: source.sampleRate,
      sampleCount: source.sampleCount,
      durationMs: samplesToMs(source.sampleCount, source.sampleRate),
      sha256: source.hash,
    },
    conventions: {
      interval: '左闭右开 [start, end)，长度 = end - start',
      msToSamples: 'roundHalfAwayFromZero(ms / 1000 * sampleRate)，0.5 向上进位',
      fadeIn: '相对片段下标 i ∈ [0, F-1] 时 gain = i / F；i = F 时为 1（在淡化区外）',
      fadeOut: '相对片段下标 i ∈ [L-F, L-1] 时 gain = (L - i) / F；右端点 i = L 增益为 0（不包含在片段内）',
      fadesOnlyScaleAmplitude: true,
      fadeOverlapRule: 'fadeInSamples + fadeOutSamples <= length（恰好相邻允许）',
      quantization: '先夹取到 [-32768, 32767]，再 half-away-from-zero 四舍五入',
      silence: '相邻片段之间插入指定数量的零值采样，片段长度不受影响',
    },
    silenceSamples: plan.silenceSamples,
    clipCount: plan.items.length,
    timeline: buildTimeline(state, plan),
  };
}

/**
 * 一次性导出：返回 WAV 字节与来源说明。
 * 无片段等非法情况在 buildPlan 阶段即被拒绝，不会产生任何输出。
 */
export function exportProject(state, wavName) {
  const plan = buildPlan(state);
  const samples = renderSamples(state, plan);
  const wavBytes = encodeWav(samples, plan.sampleRate);
  const manifest = buildManifest(state, plan, wavName);
  return { wavBytes, manifest, plan, samples };
}

/**
 * 程序生成的确定性测试素材：8000 Hz、1 秒、单声道 16-bit。
 * 前 0.5 秒为 330 Hz 正弦，后 0.5 秒为 660 Hz 正弦，幅度 10000。
 * @returns {{samples: Int16Array, sampleRate: number}}
 */
export function generateSyntheticSource() {
  const sampleRate = 8000;
  const sampleCount = 8000;
  const samples = new Int16Array(sampleCount);
  const amplitude = 10000;
  for (let i = 0; i < sampleCount; i += 1) {
    const freq = i < 4000 ? 330 : 660;
    samples[i] = quantizeToInt16(amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate));
  }
  return { samples, sampleRate };
}

/** 计算素材字节的 SHA-256 指纹（浏览器/Node 均使用 Web Crypto）。 */
export async function hashBytes(bytes) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
