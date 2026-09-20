/**
 * clips.js — 采样精确的片段校验、拼接渲染与来源说明生成。
 *
 * 纯逻辑模块，Node.js（测试）与浏览器（页面）共用，不依赖任何编解码外部程序。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 舍入与淡化端点规则（测试与界面均以此为准）
 * ─────────────────────────────────────────────────────────────────────────
 * 1. 毫秒 → 采样点：samples = Math.round(ms / 1000 * sampleRate)
 *    即“四舍五入到最近整数，0.5 一律向上”（half up）。
 *    负毫秒非法（NEGATIVE_LENGTH）。
 *
 * 2. 片段区间一律为左闭右开 [start, end)，编号从 0 开始：
 *    实际复制 source[start], …, source[end-1]，共 end-start 个采样。
 *
 * 3. 线性淡入（长度 F 个采样）：
 *      输出第 k 个采样（0 ≤ k < F）增益为 (k + 1) / F，
 *      即起点为 1/F（不为 0），第 F-1 个采样增益为 1，第 F 个采样不受影响。
 *    线性淡出（长度 F 个采样）：
 *      片段末尾第 k 个采样（k = 0 表示最后一个采样，向前数）增益为 (k + 1) / F，
 *      即最后一个采样增益为 1/F（不为 0），倒数第 F 个采样增益为 1，
 *      再往前的采样不受影响。
 *    淡入淡出对称；F = 0 表示不淡化。淡化只乘增益，绝不插入、删除或移动采样，
 *    因此片段长度恒等于 end - start。
 *
 * 4. 淡入与淡出范围不得重叠或侵占同一采样：
 *      fadeInSamples + fadeOutSamples ≤ 片段长度，
 *    否则拒绝（FADE_OVERLAP）。两端点均不互相触碰是允许的（相等时）。
 *
 * 5. 16-bit 量化：最终每个采样先截断到 [-32768, 32767] 再取整；
 *    取整采用 half away from zero（±x.5 都向远离 0 的方向），与正负数对称。
 */

/** 单次渲染允许的最大输出采样数（约 10^9，防止超大参数触发原生 RangeError）。 */
const MAX_OUTPUT_SAMPLES = 1_000_000_000;

/** 片段或参数非法时抛出；code 为机器可读的错误类别。 */
export class ClipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClipError';
    this.code = code;
  }
}

export const ERROR_CODES = Object.freeze({
  NEGATIVE_LENGTH: 'NEGATIVE_LENGTH',
  NON_INTEGER: 'NON_INTEGER',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  EMPTY_RANGE: 'EMPTY_RANGE',
  REVERSED_RANGE: 'REVERSED_RANGE',
  FADE_OVERLAP: 'FADE_OVERLAP',
  NO_CLIPS: 'NO_CLIPS',
  BAD_SAMPLE_RATE: 'BAD_SAMPLE_RATE',
  OUTPUT_TOO_LONG: 'OUTPUT_TOO_LONG',
});

function isInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * 毫秒换算采样点（half up 四舍五入）。
 * @param {number} ms 非负有限毫秒数
 * @param {number} sampleRate 正整数采样率
 * @returns {number} 非负整数采样数
 */
export function msToSamples(ms, sampleRate) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new ClipError(ERROR_CODES.NON_INTEGER, `毫秒数必须为有限数字，收到 ${String(ms)}`);
  }
  if (ms < 0) {
    throw new ClipError(ERROR_CODES.NEGATIVE_LENGTH, `长度不能为负（收到 ${ms} ms）`);
  }
  if (!isInt(sampleRate) || sampleRate <= 0) {
    throw new ClipError(ERROR_CODES.BAD_SAMPLE_RATE, `采样率必须为正整数，收到 ${String(sampleRate)}`);
  }
  return Math.round((ms / 1000) * sampleRate);
}

/** 采样点换算毫秒（浮点，仅用于界面展示与说明）。 */
export function samplesToMs(samples, sampleRate) {
  if (!isInt(sampleRate) || sampleRate <= 0) {
    throw new ClipError(ERROR_CODES.BAD_SAMPLE_RATE, `采样率必须为正整数，收到 ${String(sampleRate)}`);
  }
  return (samples / sampleRate) * 1000;
}

function requireNonNegInt(value, label) {
  if (!isInt(value)) {
    throw new ClipError(ERROR_CODES.NON_INTEGER, `${label} 必须为非负整数，收到 ${String(value)}`);
  }
  if (value < 0) {
    throw new ClipError(ERROR_CODES.NEGATIVE_LENGTH, `${label} 不能为负，收到 ${value}`);
  }
  return value;
}

/**
 * 将可能以毫秒给出的淡化长度归一化为采样点。
 * 内部约定：clip 字段 fadeInSamples/fadeOutSamples 为采样点；
 * 若提供 fadeInMs/fadeOutMs 则按 half up 换算。
 */
function resolveFade(clip, sampleRate) {
  let fadeIn;
  let fadeOut;
  if (clip.fadeInMs !== undefined) {
    fadeIn = msToSamples(clip.fadeInMs, sampleRate);
  } else {
    fadeIn = requireNonNegInt(clip.fadeInSamples ?? 0, '淡入长度');
  }
  if (clip.fadeOutMs !== undefined) {
    fadeOut = msToSamples(clip.fadeOutMs, sampleRate);
  } else {
    fadeOut = requireNonNegInt(clip.fadeOutSamples ?? 0, '淡出长度');
  }
  return { fadeIn, fadeOut };
}

/**
 * 校验单个片段（不修改输入）。
 * @param {{start:number,end:number,fadeInSamples?:number,fadeOutSamples?:number,
 *          fadeInMs?:number,fadeOutMs?:number,label?:string}} clip
 * @param {number} sourceLength 素材总采样数
 * @param {number} sampleRate
 * @returns {{start:number,end:number,fadeIn:number,fadeOut:number,label:string}}
 */
export function validateClip(clip, sourceLength, sampleRate) {
  if (!clip || typeof clip !== 'object') {
    throw new ClipError(ERROR_CODES.NON_INTEGER, '片段必须是对象');
  }
  const { start, end } = clip;
  if (!isInt(start) || !isInt(end)) {
    throw new ClipError(ERROR_CODES.NON_INTEGER, `片段边界必须为整数采样编号，收到 [${String(start)}, ${String(end)})`);
  }
  if (start < 0 || end < 0) {
    throw new ClipError(ERROR_CODES.NEGATIVE_LENGTH, `片段边界不能为负，收到 [${start}, ${end})`);
  }
  if (start > sourceLength || end > sourceLength) {
    throw new ClipError(
      ERROR_CODES.OUT_OF_RANGE,
      `片段 [${start}, ${end}) 超出素材范围 [0, ${sourceLength})`
    );
  }
  if (start > end) {
    throw new ClipError(ERROR_CODES.REVERSED_RANGE, `片段结束早于开始：[${start}, ${end})`);
  }
  if (start === end) {
    throw new ClipError(ERROR_CODES.EMPTY_RANGE, `零长度片段 [${start}, ${start}) 不允许`);
  }

  const { fadeIn, fadeOut } = resolveFade(clip, sampleRate);
  const length = end - start;
  if (fadeIn + fadeOut > length) {
    throw new ClipError(
      ERROR_CODES.FADE_OVERLAP,
      `淡入(${fadeIn}) + 淡出(${fadeOut}) 超过片段长度(${length})，淡化范围重叠`
    );
  }

  return { start, end, fadeIn, fadeOut, label: clip.label ?? `clip@${start}` };
}

/**
 * 按当前顺序渲染拼接结果。
 *
 * @param {object} params
 * @param {Int16Array|number[]} params.source 原始素材采样（保持不变）
 * @param {number} params.sampleRate
 * @param {Array} params.clips 有序片段数组；片段可重复引用同一来源区间
 * @param {number} [params.gapSamples=0] 相邻片段之间插入的静音采样数
 * @param {number} [params.gapMs] 相邻片段静音毫秒数（与 gapSamples 二选一）
 * @returns {{samples:Int16Array, manifest:object}}
 *   samples 为最终输出；manifest 记录每段来源区间、静音长度与最终输出位置
 */
export function renderClips(params) {
  const { source, sampleRate, clips } = params;
  if (!source || typeof source.length !== 'number') {
    throw new ClipError(ERROR_CODES.NON_INTEGER, '缺少来源素材采样数组');
  }
  if (!isInt(sampleRate) || sampleRate <= 0) {
    throw new ClipError(ERROR_CODES.BAD_SAMPLE_RATE, `采样率必须为正整数，收到 ${String(sampleRate)}`);
  }
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new ClipError(ERROR_CODES.NO_CLIPS, '尚无片段，无法导出');
  }

  const sourceLength = source.length;
  const gap = params.gapMs !== undefined
    ? msToSamples(params.gapMs, sampleRate)
    : requireNonNegInt(params.gapSamples ?? 0, '静音长度');

  // 先整体校验，任何一条非法都不产生部分结果
  const resolved = clips.map((clip) => validateClip(clip, sourceLength, sampleRate));

  const totalLength = resolved.reduce(
    (sum, clip) => sum + (clip.end - clip.start),
    gap * Math.max(0, resolved.length - 1)
  );

  if (totalLength > MAX_OUTPUT_SAMPLES) {
    throw new ClipError(
      ERROR_CODES.OUTPUT_TOO_LONG,
      `输出长度 ${totalLength} samples 超过上限 ${MAX_OUTPUT_SAMPLES}，请缩短片段或静音长度`
    );
  }

  const output = new Int16Array(totalLength);
  const entries = [];
  let cursor = 0;

  resolved.forEach((clip, index) => {
    const length = clip.end - clip.start;
    const clipOutputStart = cursor;

    for (let k = 0; k < length; k += 1) {
      const sourceIndex = clip.start + k;
      let gain = 1;
      if (clip.fadeIn > 0 && k < clip.fadeIn) {
        gain = (k + 1) / clip.fadeIn;
      }
      if (clip.fadeOut > 0 && k >= length - clip.fadeOut) {
        // k 从末尾数：最后一个采样 distance=0 → 1/F
        const distanceFromEnd = length - 1 - k;
        gain = (distanceFromEnd + 1) / clip.fadeOut;
      }

      const raw = source[sourceIndex];
      let scaled = raw * gain;
      // 先截断到 16-bit 范围，再 half away from zero 取整（±x.5 均远离 0，正负对称）
      if (scaled > 32767) scaled = 32767;
      if (scaled < -32768) scaled = -32768;
      output[cursor + k] = Math.sign(scaled) * Math.round(Math.abs(scaled));
    }

    entries.push({
      index,
      label: clip.label,
      sourceStart: clip.start,
      sourceEnd: clip.end,
      sourceLengthSamples: length,
      fadeInSamples: clip.fadeIn,
      fadeOutSamples: clip.fadeOut,
      fadeInMs: samplesToMs(clip.fadeIn, sampleRate),
      fadeOutMs: samplesToMs(clip.fadeOut, sampleRate),
      outputStart: clipOutputStart,
      outputEnd: clipOutputStart + length,
    });

    cursor += length;
    if (index < resolved.length - 1) {
      // 静音段保持 Int16Array 初值 0，只推进游标
      cursor += gap;
    }
  });

  const manifest = {
    formatVersion: 1,
    sampleRate,
    sourceTotalSamples: sourceLength,
    sourceDurationMs: samplesToMs(sourceLength, sampleRate),
    intervalConvention: '[start, end) 左闭右开，采样编号从 0 开始',
    rounding: '毫秒到采样点使用 Math.round（half up，0.5 向上）；16-bit 量化为 half away from zero（±x.5 均远离 0）',
    fadeRule: '淡入第 k 个采样增益 (k+1)/F；淡出末尾第 k 个采样增益 (k+1)/F；F=0 不淡化',
    gapSamples: gap,
    gapMs: samplesToMs(gap, sampleRate),
    clipCount: resolved.length,
    outputTotalSamples: totalLength,
    outputDurationMs: samplesToMs(totalLength, sampleRate),
    clips: entries,
  };

  return { samples: output, manifest };
}

/**
 * 序列化为稳定键序的 JSON 文本（来源说明文件内容）。
 */
export function manifestToJson(manifest) {
  return JSON.stringify(manifest, null, 2);
}

/**
 * 生成用于“程序生成短音频”的测试素材：带幅值包络的正弦波。
 * 公式：12000 * (0.35 + 0.65*t) * sin(2π·440·t)，t∈[0,1)
 * @param {number} sampleRate
 * @param {number} durationSeconds
 * @returns {Int16Array}
 */
export function generateToneSource(sampleRate = 8000, durationSeconds = 1) {
  if (!isInt(sampleRate) || sampleRate <= 0) {
    throw new ClipError(ERROR_CODES.BAD_SAMPLE_RATE, `采样率必须为正整数，收到 ${String(sampleRate)}`);
  }
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new ClipError(ERROR_CODES.NON_INTEGER, `时长必须为正数，收到 ${String(durationSeconds)}`);
  }
  const count = Math.floor(durationSeconds * sampleRate);
  const samples = new Int16Array(count);
  for (let n = 0; n < count; n += 1) {
    const t = n / sampleRate;
    const envelope = 0.35 + 0.65 * (n / Math.max(1, count - 1));
    samples[n] = Math.round(12000 * envelope * Math.sin(2 * Math.PI * 440 * t));
  }
  return samples;
}
