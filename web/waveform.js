/**
 * 波形绘制与拖选：仅用 Canvas 2D 原生能力。
 * 采样坐标映射全文件统一：sampleToX / xToSample 互为逆运算的取整版本。
 */

const PALETTE = [
  '#f5a524', // 琥珀
  '#4cc9f0', // 青
  '#b8f259', // 黄绿
  '#f72585', // 品红
  '#bdb2ff', // 淡紫
  '#80ed99', // 薄荷
  '#ffb4a2', // 珊瑚
  '#ffd166', // 金黄
];

export function clipColor(index) {
  return PALETTE[index % PALETTE.length];
}

/**
 * 预计算每列的 min/max 峰值，避免每次重绘遍历全部采样。
 * @returns {{mins: Int32Array, maxes: Int32Array, columns: number}}
 */
export function buildPeaks(samples, columns) {
  const cols = Math.max(1, Math.floor(columns));
  const mins = new Int32Array(cols);
  const maxes = new Int32Array(cols);
  const n = samples.length;
  if (n === 0) return { mins, maxes, columns: cols };
  const bucket = n / cols;
  for (let c = 0; c < cols; c += 1) {
    const from = Math.floor(c * bucket);
    const to = Math.max(from + 1, Math.floor((c + 1) * bucket));
    let lo = 32767;
    let hi = -32768;
    for (let i = from; i < to && i < n; i += 1) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mins[c] = lo;
    maxes[c] = hi;
  }
  return { mins, maxes, columns: cols };
}

export function sampleToX(sample, sampleCount, width) {
  return (sample / sampleCount) * width;
}

/** 像素 x → 采样编号（区间左闭右开，端点可为 sampleCount）。 */
export function xToSample(x, sampleCount, width) {
  const ratio = Math.min(1, Math.max(0, x / width));
  return Math.round(ratio * sampleCount);
}

function setupHiDpi(canvas, cssHeight) {
  const dpr = globalThis.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: cssWidth, height: cssHeight };
}

function drawGrid(ctx, width, height, sampleCount, sampleRate) {
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.lineWidth = 1;
  // 每 0.5 秒一条刻度线
  const stepSamples = Math.max(1, Math.round(sampleRate * 0.5));
  for (let s = 0; s <= sampleCount; s += stepSamples) {
    const x = sampleToX(s, sampleCount, width);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
    ctx.stroke();
    if (s % (stepSamples * 2) === 0) {
      ctx.fillText(`${(s / sampleRate).toFixed(1)}s`, x + 3, height - 4);
    }
  }
}

/**
 * 绘制波形。
 * @param {HTMLCanvasElement} canvas
 * @param {Int16Array} samples
 * @param {number} sampleRate
 * @param {{regions?: Array<{start:number,end:number,color:string,active?:boolean,dim?:boolean}>,
 *          selection?: {start:number,end:number}|null,
 *          height?: number}} [opts]
 */
export function drawWaveform(canvas, samples, sampleRate, opts = {}) {
  const height = opts.height ?? 180;
  const { ctx, width } = setupHiDpi(canvas, height);
  const n = samples.length;
  ctx.clearRect(0, 0, width, height);

  // 背景
  ctx.fillStyle = '#16161c';
  ctx.fillRect(0, 0, width, height);
  const mid = height / 2;
  drawGrid(ctx, width, height, n, sampleRate);

  if (n > 0) {
    const { mins, maxes } = buildPeaks(samples, width);
    // 中轴
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(width, Math.round(mid) + 0.5);
    ctx.stroke();

    for (let c = 0; c < mins.length; c += 1) {
      const x = c + 0.5;
      const yHi = mid - (maxes[c] / 32768) * (mid - 8);
      const yLo = mid - (mins[c] / 32768) * (mid - 8);
      ctx.strokeStyle = 'rgba(230,228,222,0.82)';
      ctx.beginPath();
      ctx.moveTo(x, yHi);
      ctx.lineTo(x, Math.max(yHi + 1, yLo));
      ctx.stroke();
    }
  }

  // 已建立片段的区间
  for (const region of opts.regions ?? []) {
    const x1 = sampleToX(region.start, n, width);
    const x2 = sampleToX(region.end, n, width);
    ctx.fillStyle = region.color + (region.dim ? '14' : '26');
    ctx.fillRect(x1, 0, Math.max(1, x2 - x1), height);
    ctx.strokeStyle = region.color;
    ctx.globalAlpha = region.active ? 1 : 0.7;
    ctx.lineWidth = region.active ? 2 : 1;
    ctx.strokeRect(x1 + 0.5, 1.5, Math.max(1, x2 - x1) - 1, height - 3);
    ctx.globalAlpha = 1;
  }

  // 正在拖选的区间
  if (opts.selection) {
    const x1 = sampleToX(opts.selection.start, n, width);
    const x2 = sampleToX(opts.selection.end, n, width);
    ctx.fillStyle = 'rgba(245,165,36,0.18)';
    ctx.fillRect(x1, 0, x2 - x1, height);
    ctx.strokeStyle = '#f5a524';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x1 + 0.5, 1.5, (x2 - x1) - 1, height - 3);
    ctx.setLineDash([]);
  }

  if (n === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('尚未加载素材', 12, mid + 4);
  }
}
