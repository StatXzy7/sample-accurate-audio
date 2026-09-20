/**
 * app.js — 浏览器端页面逻辑（仅使用浏览器原生 API）。
 *
 * 状态约定：
 *   - source.samples 为 Int16Array，全程只读，任何编辑都不会修改原始素材。
 *   - clips 边界以采样点为准（start/end 为整数），淡入淡出以毫秒录入、
 *     渲染时由核心模块按 half up 换算。
 *   - 每次合法编辑后调用 rebuildOutput() 重算；非法操作抛出错误时，
 *     保留上一次成功的渲染结果（lastGood），不覆盖当前有效编辑。
 */

import { parseWav, encodeWav } from '/core/wav.js';
import {
  renderClips,
  msToSamples,
  samplesToMs,
  generateToneSource,
  manifestToJson,
  ClipError,
  ERROR_CODES,
} from '/core/clips.js';

// ───────────────────────── DOM 句柄 ─────────────────────────
const $ = (id) => document.getElementById(id);

const els = {
  sourceMeta: $('sourceMeta'),
  sourceMetaText: $('sourceMetaText'),
  fileInput: $('fileInput'),
  genToneBtn: $('genToneBtn'),
  playSourceBtn: $('playSourceBtn'),
  waveframe: $('waveframe'),
  waveCanvas: $('waveCanvas'),
  waveHint: $('waveHint'),
  ruler: $('ruler'),
  selStartSample: $('selStartSample'),
  selEndSample: $('selEndSample'),
  selLenSample: $('selLenSample'),
  addForm: $('addForm'),
  startMs: $('startMs'),
  startSample: $('startSample'),
  endMs: $('endMs'),
  endSample: $('endSample'),
  addClipBtn: $('addClipBtn'),
  clipList: $('clipList'),
  clipCount: $('clipCount'),
  emptyClips: $('emptyClips'),
  resetBtn: $('resetBtn'),
  gapMs: $('gapMs'),
  gapSamples: $('gapSamples'),
  outSamples: $('outSamples'),
  outDuration: $('outDuration'),
  outCanvas: $('outCanvas'),
  playOutputBtn: $('playOutputBtn'),
  exportBtn: $('exportBtn'),
  statusbar: $('statusbar'),
  statusText: $('statusText'),
};

// ───────────────────────── 应用状态 ─────────────────────────
/** @type {{name:string, sampleRate:number, samples:Int16Array}|null} */
let source = null;
let clips = []; // {id, start, end, fadeInMs, fadeOutMs}
let gapMs = 0;
let selection = null; // {start, end} 采样编号（end 可等于素材长度）
let lastGood = null; // {samples, manifest} 最近一次成功渲染
let clipSeq = 0;

const DEFAULT_GAP_MS = 0;

// ───────────────────────── 状态栏 ───────────────────────────
let statusTimer = null;
function setStatus(kind, message, sticky = false) {
  els.statusbar.className = kind === 'info' ? '' : kind;
  els.statusText.textContent = message;
  if (statusTimer) clearTimeout(statusTimer);
  if (!sticky && kind === 'ok') {
    statusTimer = setTimeout(() => {
      els.statusbar.className = '';
      els.statusText.textContent = '就绪。';
    }, 3200);
  }
}

// ───────────────────────── 工具 ─────────────────────────────
function formatMs(samples, sampleRate) {
  // 最多 6 位小数并去掉尾随 0，避免显示 12.500000
  const ms = samplesToMs(samples, sampleRate);
  return `${Number(ms.toFixed(6))}`;
}

function downloadBytes(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给浏览器一点时间发起下载后再回收
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ───────────────────────── 素材载入 ─────────────────────────
function loadSource(next) {
  source = next;
  clips = [];
  gapMs = DEFAULT_GAP_MS;
  selection = null;
  lastGood = null;
  els.gapMs.value = '0';

  els.sourceMeta.classList.add('loaded');
  els.sourceMetaText.textContent =
    `${next.name} · ${next.sampleRate} Hz · ${next.samples.length} samples · ${formatMs(next.samples.length, next.sampleRate)} ms`;
  els.waveframe.classList.add('has-audio');
  els.playSourceBtn.disabled = false;
  els.addClipBtn.disabled = false;
  els.exportBtn.disabled = true;
  els.resetBtn.disabled = true;

  els.startMs.value = '';
  els.startSample.value = '';
  els.endMs.value = '';
  els.endSample.value = '';
  [els.startMs, els.startSample, els.endMs, els.endSample].forEach((i) => i.classList.remove('invalid'));

  buildRuler();
  drawWaveform();
  renderClipList();
  rebuildOutput();
  updateSelectionReadout();
}

async function handleFile(file) {
  try {
    const buffer = await file.arrayBuffer();
    const parsed = parseWav(buffer);
    loadSource({ name: file.name, sampleRate: parsed.sampleRate, samples: parsed.samples });
    setStatus('ok', `已导入 ${file.name}（${parsed.sampleRate} Hz，${parsed.samples.length} samples）`);
  } catch (err) {
    if (err instanceof ClipError || err.name === 'WavFormatError') {
      setStatus('err', `导入被拒绝：${err.message}`, true);
    } else {
      setStatus('err', `读取文件失败：${err.message}`, true);
    }
  }
}

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (file) handleFile(file);
  els.fileInput.value = '';
});

els.genToneBtn.addEventListener('click', () => {
  const sampleRate = 8000;
  const samples = generateToneSource(sampleRate, 1);
  loadSource({ name: 'generated-tone-440hz.wav', sampleRate, samples });
  setStatus('ok', '已载入程序生成音频：440 Hz 正弦包络，8000 Hz × 1 秒（8000 samples）');
});

// ───────────────────────── 时间标尺 ─────────────────────────
function buildRuler() {
  if (!source) return;
  const totalMs = samplesToMs(source.samples.length, source.sampleRate);
  const points = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const t = totalMs * p;
    return `${Number(t.toFixed(3))} ms`;
  });
  els.ruler.replaceChildren(...points.map((text) => {
    const span = document.createElement('span');
    span.textContent = text;
    return span;
  }));
}

// ───────────────────────── 波形绘制 ─────────────────────────
function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const targetW = Math.max(1, Math.round(width * dpr));
  const targetH = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  return { ctx: canvas.getContext('2d'), w: targetW, h: targetH, dpr };
}

function computePeaks(samples, buckets) {
  const peaks = new Float32Array(buckets * 2); // 每桶 min/max
  const per = samples.length / buckets;
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * per);
    const end = Math.max(start + 1, Math.floor((b + 1) * per));
    let min = 0;
    let max = 0;
    for (let i = start; i < end && i < samples.length; i += 1) {
      const v = samples[i] / 32768;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

function xToSample(xCss) {
  const rect = els.waveCanvas.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (xCss - rect.left) / rect.width));
  return Math.min(source.samples.length, Math.floor(ratio * source.samples.length));
}

function drawWaveform() {
  if (!source) return;
  const { ctx, w, h } = resizeCanvas(els.waveCanvas);
  ctx.clearRect(0, 0, w, h);

  const mid = h / 2;
  const buckets = Math.max(1, w);
  const peaks = computePeaks(source.samples, buckets);
  const per = source.samples.length / buckets;

  // 中轴
  ctx.strokeStyle = 'rgba(154,167,182,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();

  const sampleToX = (s) => (s / source.samples.length) * w;

  // 已建立的片段（琥珀色底）
  clips.forEach((clip, idx) => {
    const x0 = sampleToX(clip.start);
    const x1 = sampleToX(clip.end);
    ctx.fillStyle = 'rgba(240,166,56,0.13)';
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    ctx.strokeStyle = 'rgba(240,166,56,0.45)';
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, 0);
    ctx.lineTo(x0 + 0.5, h);
    ctx.stroke();
    if (idx === clips.length - 1) {
      ctx.strokeStyle = 'rgba(240,166,56,0.45)';
      ctx.beginPath();
      ctx.moveTo(x1 + 0.5, 0);
      ctx.lineTo(x1 + 0.5, h);
      ctx.stroke();
    }
    // 序号
    ctx.fillStyle = 'rgba(255,190,92,0.9)';
    ctx.font = `${11 * (window.devicePixelRatio || 1)}px Cascadia Mono, Consolas, monospace`;
    ctx.fillText(`#${idx + 1}`, x0 + 6 * (window.devicePixelRatio || 1), 14 * (window.devicePixelRatio || 1));
  });

  // 波形主体（青色）
  ctx.strokeStyle = '#5fd0d6';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let b = 0; b < buckets; b += 1) {
    const x = b + 0.5;
    const yMin = mid + peaks[b * 2] * (h / 2 - 2);
    const yMax = mid + peaks[b * 2 + 1] * (h / 2 - 2);
    ctx.moveTo(x, yMin);
    ctx.lineTo(x, yMax);
  }
  ctx.stroke();

  // 当前拖选（青色高亮 + 起止手柄）
  if (selection) {
    const sx0 = sampleToX(selection.start);
    const sx1 = sampleToX(selection.end);
    ctx.fillStyle = 'rgba(95,208,214,0.16)';
    ctx.fillRect(sx0, 0, Math.max(1, sx1 - sx0), h);
    ctx.strokeStyle = '#5fd0d6';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx0 + 0.75, 1, Math.max(2, sx1 - sx0 - 1.5), h - 2);
  }
}

// 波形拖选
let dragging = false;
els.waveCanvas.addEventListener('pointerdown', (ev) => {
  if (!source) return;
  dragging = true;
  els.waveCanvas.setPointerCapture(ev.pointerId);
  const s = xToSample(ev.clientX);
  selection = { start: s, end: s };
  updateSelectionReadout();
  drawWaveform();
});
els.waveCanvas.addEventListener('pointermove', (ev) => {
  if (!dragging || !source) return;
  const s = xToSample(ev.clientX);
  const anchor = selection.start;
  selection = {
    start: Math.min(anchor, s),
    end: Math.max(anchor, s),
  };
  syncBoundInputs(selection.start, selection.end);
  updateSelectionReadout();
  drawWaveform();
});
function endDrag() {
  if (!dragging) return;
  dragging = false;
  if (selection && selection.start === selection.end) {
    // 零长度拖选不保留，但允许用户随后手动输入
    selection = null;
    updateSelectionReadout();
  }
  drawWaveform();
}
els.waveCanvas.addEventListener('pointerup', endDrag);
els.waveCanvas.addEventListener('pointercancel', endDrag);

function updateSelectionReadout() {
  if (!source || !selection) {
    els.selStartSample.textContent = '—';
    els.selEndSample.textContent = '—';
    els.selLenSample.textContent = '—';
    return;
  }
  els.selStartSample.textContent = selection.start;
  els.selEndSample.textContent = selection.end;
  els.selLenSample.textContent = selection.end - selection.start;
}

// ───────────────────────── 边界输入联动 ─────────────────────
function syncBoundInputs(startSample, endSample) {
  if (!source) return;
  els.startSample.value = String(startSample);
  els.endSample.value = String(endSample);
  els.startMs.value = formatMs(startSample, source.sampleRate);
  els.endMs.value = formatMs(endSample, source.sampleRate);
  [els.startMs, els.startSample, els.endMs, els.endSample].forEach((i) => i.classList.remove('invalid'));
}

function sampleFromMsInput(input) {
  const ms = Number(input.value);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return msToSamples(ms, source.sampleRate);
}

els.startMs.addEventListener('input', () => {
  if (!source) return;
  const s = sampleFromMsInput(els.startMs);
  if (s === null) { els.startSample.value = ''; return; }
  els.startSample.value = String(s);
});
els.endMs.addEventListener('input', () => {
  if (!source) return;
  const s = sampleFromMsInput(els.endMs);
  if (s === null) { els.endSample.value = ''; return; }
  els.endSample.value = String(s);
});
els.startSample.addEventListener('input', () => {
  if (!source) return;
  const s = Number(els.startSample.value);
  els.startMs.value = Number.isInteger(s) && s >= 0 ? formatMs(s, source.sampleRate) : '';
});
els.endSample.addEventListener('input', () => {
  if (!source) return;
  const e = Number(els.endSample.value);
  els.endMs.value = Number.isInteger(e) && e >= 0 ? formatMs(e, source.sampleRate) : '';
});

// ───────────────────────── 添加片段 ─────────────────────────
els.addForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!source) return;

  const startRaw = els.startSample.value;
  const endRaw = els.endSample.value;
  const candidate = {
    start: startRaw === '' ? NaN : Number(startRaw),
    end: endRaw === '' ? NaN : Number(endRaw),
    fadeInMs: 0,
    fadeOutMs: 0,
  };

  try {
    // 仅试校验，不触碰现有 clips（错误操作不得覆盖当前有效编辑）
    validateCandidate(candidate);
  } catch (err) {
    markBoundInvalid(err);
    setStatus('err', `片段被拒绝：${err.message}`, true);
    return;
  }

  clips = [...clips, { id: `c${++clipSeq}`, ...candidate }];
  setStatus('ok', `已添加片段 [${candidate.start}, ${candidate.end})，长度 ${candidate.end - candidate.start} samples`);
  selection = null;
  updateSelectionReadout();
  afterClipsChanged();
});

// 用核心模块的校验逻辑（构造单片段试渲染，不修改状态）
function validateCandidate(candidate) {
  renderClips({
    source: source.samples,
    sampleRate: source.sampleRate,
    clips: [candidate],
    gapSamples: 0,
  });
}

function markBoundInvalid(err) {
  [els.startMs, els.startSample, els.endMs, els.endSample].forEach((i) => i.classList.remove('invalid'));
  switch (err.code) {
    case ERROR_CODES.EMPTY_RANGE:
    case ERROR_CODES.REVERSED_RANGE:
      els.startMs.classList.add('invalid');
      els.startSample.classList.add('invalid');
      els.endMs.classList.add('invalid');
      els.endSample.classList.add('invalid');
      break;
    case ERROR_CODES.OUT_OF_RANGE:
    case ERROR_CODES.NEGATIVE_LENGTH:
    case ERROR_CODES.NON_INTEGER:
    default:
      els.startSample.classList.add('invalid');
      els.endSample.classList.add('invalid');
      els.startMs.classList.add('invalid');
      els.endMs.classList.add('invalid');
  }
}

// ───────────────────────── 片段列表渲染 ─────────────────────
function renderClipList() {
  els.clipCount.textContent = String(clips.length);
  els.resetBtn.disabled = clips.length === 0 && gapMs === DEFAULT_GAP_MS;

  els.clipList.replaceChildren();
  if (clips.length === 0) {
    els.clipList.appendChild(els.emptyClips);
    els.emptyClips.style.display = '';
    return;
  }
  els.emptyClips.style.display = 'none';

  // 统计来源区间用于标记“重复引用”
  const keyCount = new Map();
  clips.forEach((c) => {
    const key = `${c.start}:${c.end}`;
    keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
  });

  clips.forEach((clip, idx) => {
    const duplicated = keyCount.get(`${clip.start}:${clip.end}`) > 1;
    const out = lastGood?.manifest.clips[idx];
    const row = document.createElement('div');
    row.className = `clip-row${duplicated ? ' dup' : ''}`;
    row.draggable = true;
    row.dataset.id = clip.id;

    const order = document.createElement('div');
    order.className = 'clip-order';
    order.textContent = `#${idx + 1}`;
    order.title = '拖拽以调整顺序';

    const range = document.createElement('div');
    range.className = 'clip-range';
    const fadeInS = msToSamples(clip.fadeInMs || 0, source.sampleRate);
    const fadeOutS = msToSamples(clip.fadeOutMs || 0, source.sampleRate);
    range.innerHTML =
      `<span class="r-sample">[${clip.start}, ${clip.end})</span><br>` +
      `<span class="r-time">${formatMs(clip.start, source.sampleRate)} ms → ${formatMs(clip.end, source.sampleRate)} ms</span><br>` +
      `<span class="r-len">长度 ${clip.end - clip.start} samples</span>` +
      (duplicated ? '<span class="r-time"> · 重复引用</span>' : '') +
      (out ? `<span class="r-out">输出位置 [${out.outputStart}, ${out.outputEnd}) · 淡入 ${fadeInS} / 淡出 ${fadeOutS} samples</span>` : '');

    const topBtns = document.createElement('div');
    topBtns.className = 'clip-top';
    topBtns.style.gridColumn = '3';
    topBtns.append(
      iconButton('↑', '上移', idx === 0, () => moveClip(idx, idx - 1)),
      iconButton('↓', '下移', idx === clips.length - 1, () => moveClip(idx, idx + 1)),
      iconButton('⧉', '重复引用此片段', false, () => duplicateClip(idx)),
      iconButton('✕', '删除', false, () => removeClip(idx), 'del'),
    );

    const controls = document.createElement('div');
    controls.className = 'clip-controls';
    const fadeIn = fadeInput('淡入 ms', clip.fadeInMs, (value) => updateFade(idx, 'fadeInMs', value, fadeIn.querySelector('input')));
    const fadeOut = fadeInput('淡出 ms', clip.fadeOutMs, (value) => updateFade(idx, 'fadeOutMs', value, fadeOut.querySelector('input')));
    controls.append(fadeIn, fadeOut);

    row.append(order, range, topBtns, controls);
    bindRowDrag(row, idx);
    els.clipList.appendChild(row);
  });
}

function iconButton(text, title, disabled, onClick, extraClass = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn ${extraClass}`;
  btn.textContent = text;
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function fadeInput(labelText, value, onCommit) {
  const label = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '0.5';
  input.value = String(value ?? 0);
  input.addEventListener('change', () => {
    const num = Number(input.value);
    onCommit(Number.isFinite(num) ? num : 0);
  });
  label.append(span, input);
  return label;
}

// ───────────────────────── 片段操作（不可变更新） ───────────
function afterClipsChanged() {
  rebuildOutput();
  renderClipList();
  drawWaveform();
}

function moveClip(from, to) {
  if (to < 0 || to >= clips.length) return;
  const next = clips.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  clips = next;
  afterClipsChanged();
  setStatus('ok', `片段顺序已调整`);
}

function duplicateClip(idx) {
  const original = clips[idx];
  const copy = { ...original, id: `c${++clipSeq}` };
  clips = [...clips.slice(0, idx + 1), copy, ...clips.slice(idx + 1)];
  afterClipsChanged();
  setStatus('ok', `已在位置 ${idx + 2} 插入同一来源区间 [${copy.start}, ${copy.end}) 的重复引用`);
}

function removeClip(idx) {
  clips = clips.filter((_, i) => i !== idx);
  afterClipsChanged();
  setStatus('ok', `已删除片段 #${idx + 1}`);
}

function updateFade(idx, field, msValue, inputEl) {
  const clip = clips[idx];
  const candidate = { ...clip, [field]: msValue };
  const trial = clips.map((c, i) => (i === idx ? candidate : c));
  try {
    renderClips({
      source: source.samples,
      sampleRate: source.sampleRate,
      clips: trial,
      gapMs,
    });
  } catch (err) {
    // 非法淡化：回滚输入框，保留当前有效编辑与上次成功输出
    inputEl.value = String(clip[field] ?? 0);
    inputEl.classList.add('invalid');
    setStatus('err', `淡化设置被拒绝：${err.message}`, true);
    setTimeout(() => inputEl.classList.remove('invalid'), 1600);
    return;
  }
  clips = trial;
  afterClipsChanged();
  setStatus('ok', `${field === 'fadeInMs' ? '淡入' : '淡出'}已设置为 ${msValue} ms`);
}

// ───────────────────────── 行内拖拽排序 ─────────────────────
let dragIndex = null;
function bindRowDrag(row, idx) {
  row.addEventListener('dragstart', (ev) => {
    dragIndex = idx;
    row.classList.add('dragging');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(idx));
  });
  row.addEventListener('dragend', () => {
    dragIndex = null;
    document.querySelectorAll('.clip-row').forEach((r) => {
      r.classList.remove('dragging', 'drop-before', 'drop-after');
    });
  });
  row.addEventListener('dragover', (ev) => {
    if (dragIndex === null) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const before = ev.clientY < rect.top + rect.height / 2;
    row.classList.toggle('drop-before', before);
    row.classList.toggle('drop-after', !before);
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-before', 'drop-after');
  });
  row.addEventListener('drop', (ev) => {
    ev.preventDefault();
    if (dragIndex === null) return;
    const rect = row.getBoundingClientRect();
    const before = ev.clientY < rect.top + rect.height / 2;
    let target = idx + (before ? 0 : 1);
    const from = dragIndex;
    if (target === from || target === from + 1) return;
    const next = clips.slice();
    const [item] = next.splice(from, 1);
    if (target > from) target -= 1;
    next.splice(target, 0, item);
    clips = next;
    afterClipsChanged();
    setStatus('ok', '片段顺序已调整');
  });
}

// ───────────────────────── 静音参数 ─────────────────────────
els.gapMs.addEventListener('change', () => {
  if (!source) return;
  const num = Number(els.gapMs.value);
  if (!Number.isFinite(num) || num < 0) {
    els.gapMs.value = String(gapMs);
    setStatus('err', '静音长度无效：必须为非负数字（毫秒）', true);
    return;
  }

  // 先试算成功才提交；失败（如过大触发 OUTPUT_TOO_LONG）回滚输入框，
  // 不覆盖当前有效编辑与上次成功输出
  if (clips.length > 0) {
    try {
      renderClips({ source: source.samples, sampleRate: source.sampleRate, clips, gapMs: num });
    } catch (err) {
      els.gapMs.value = String(gapMs);
      els.gapMs.classList.add('invalid');
      setStatus('err', `静音设置被拒绝：${err.message}`, true);
      setTimeout(() => els.gapMs.classList.remove('invalid'), 1600);
      return;
    }
  }

  gapMs = num;
  els.gapSamples.textContent = String(msToSamples(gapMs, source.sampleRate));
  rebuildOutput();
  renderClipList();
  setStatus('ok', `相邻静音已设置为 ${num} ms`);
});

// ───────────────────────── 恢复原始编辑状态 ─────────────────
els.resetBtn.addEventListener('click', () => {
  clips = [];
  gapMs = DEFAULT_GAP_MS;
  selection = null;
  els.gapMs.value = '0';
  els.gapSamples.textContent = '0';
  rebuildOutput();
  renderClipList();
  drawWaveform();
  updateSelectionReadout();
  setStatus('ok', '已恢复原始编辑状态（清空全部片段、淡化与静音设置，素材未改动）');
});

// ───────────────────────── 输出渲染 ─────────────────────────
function rebuildOutput() {
  if (!source) {
    drawOutput(null);
    updateOutputStats(null);
    els.exportBtn.disabled = true;
    els.playOutputBtn.disabled = true;
    return;
  }
  if (clips.length === 0) {
    lastGood = null;
    drawOutput(null);
    updateOutputStats(null);
    els.exportBtn.disabled = true;
    els.playOutputBtn.disabled = true;
    els.gapSamples.textContent = String(msToSamples(gapMs, source.sampleRate));
    return;
  }
  try {
    const result = renderClips({
      source: source.samples,
      sampleRate: source.sampleRate,
      clips,
      gapMs,
    });
    lastGood = result;
    drawOutput(result);
    updateOutputStats(result);
    els.exportBtn.disabled = false;
    els.playOutputBtn.disabled = false;
    els.gapSamples.textContent = String(result.manifest.gapSamples);
  } catch (err) {
    // 当前参数无法生成输出：绝不导出与界面参数不符的旧结果 —— 禁用导出，
    // 仅保留上次成功波形作为视觉参考。语义错误正常提示，意外错误额外上报控制台。
    els.exportBtn.disabled = true;
    els.playOutputBtn.disabled = true;
    if (err instanceof ClipError) {
      setStatus('err', `无法生成输出：${err.message}`, true);
    } else {
      console.error('渲染输出时发生意外错误', err);
      setStatus('err', `渲染失败（内部错误），当前编辑已保留：${err.message}`, true);
    }
  }
}

function updateOutputStats(result) {
  if (!result) {
    els.outSamples.textContent = '0';
    els.outDuration.textContent = '0.000';
    return;
  }
  els.outSamples.textContent = String(result.manifest.outputTotalSamples);
  els.outDuration.textContent = result.manifest.outputDurationMs.toFixed(3);
}

function drawOutput(result) {
  const { ctx, w, h } = resizeCanvas(els.outCanvas);
  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  ctx.strokeStyle = 'rgba(154,167,182,0.22)';
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();
  if (!result || result.samples.length === 0) return;

  const buckets = Math.max(1, w);
  const peaks = computePeaks(result.samples, buckets);

  // 静音间隔（灰色底纹）
  const total = result.samples.length;
  const sx = (s) => (s / total) * w;
  for (let i = 0; i < result.manifest.clips.length - 1; i += 1) {
    const cur = result.manifest.clips[i];
    const next = result.manifest.clips[i + 1];
    if (next.outputStart > cur.outputEnd) {
      ctx.fillStyle = 'rgba(154,167,182,0.08)';
      ctx.fillRect(sx(cur.outputEnd), 0, sx(next.outputStart) - sx(cur.outputEnd), h);
    }
  }

  ctx.strokeStyle = '#f0a638';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let b = 0; b < buckets; b += 1) {
    const x = b + 0.5;
    ctx.moveTo(x, mid + peaks[b * 2] * (h / 2 - 2));
    ctx.lineTo(x, mid + peaks[b * 2 + 1] * (h / 2 - 2));
  }
  ctx.stroke();

  // 片段边界线
  ctx.strokeStyle = 'rgba(95,208,214,0.5)';
  result.manifest.clips.forEach((c) => {
    ctx.beginPath();
    ctx.moveTo(sx(c.outputStart) + 0.5, 0);
    ctx.lineTo(sx(c.outputStart) + 0.5, h);
    ctx.stroke();
  });
}

// ───────────────────────── 试听 ─────────────────────────────
let audioCtx = null;
function playInt16(samples, sampleRate) {
  audioCtx ??= new AudioContext();
  const buffer = audioCtx.createBuffer(1, samples.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) {
    channel[i] = samples[i] / 32768;
  }
  const node = audioCtx.createBufferSource();
  node.buffer = buffer;
  node.connect(audioCtx.destination);
  node.start();
}

els.playSourceBtn.addEventListener('click', () => {
  if (!source) return;
  const view = selection && selection.end > selection.start
    ? source.samples.subarray(selection.start, selection.end)
    : source.samples;
  playInt16(view, source.sampleRate);
});

els.playOutputBtn.addEventListener('click', () => {
  if (!lastGood) return;
  playInt16(lastGood.samples, source.sampleRate);
});

// ───────────────────────── 导出 ─────────────────────────────
els.exportBtn.addEventListener('click', () => {
  if (!source) return;
  if (!lastGood || clips.length === 0) {
    // 双保险：无片段绝不导出伪装成功的音频
    setStatus('err', '尚无片段，无法导出（不会生成空音频）', true);
    return;
  }

  const { samples, manifest } = lastGood;
  const wavBytes = encodeWav(samples, source.sampleRate);

  const stamped = {
    ...manifest,
    sourceName: source.name,
    exportedAt: new Date().toISOString(),
    outputFileName: 'voice-clip-output.wav',
  };
  const jsonBytes = new TextEncoder().encode(manifestToJson(stamped));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadBytes(wavBytes, `voice-clip-output-${stamp}.wav`, 'audio/wav');
  downloadBytes(jsonBytes, `voice-clip-sources-${stamp}.json`, 'application/json');
  setStatus('ok', `已导出 WAV（${samples.length} samples）与来源说明 JSON，共 ${manifest.clipCount} 段`);
});

// ───────────────────────── 尺寸变化重绘 ─────────────────────
let resizeRaf = null;
window.addEventListener('resize', () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    drawWaveform();
    drawOutput(lastGood);
  });
});

// 初始状态
els.gapSamples.textContent = '0';
drawOutput(null);
setStatus('info', '就绪。导入单声道 16-bit PCM WAV，或载入程序生成音频。');
