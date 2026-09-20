/**
 * 页面主逻辑：所有编辑都走 src/model.js 的纯函数；
 * 非法操作抛错时仅提示，state 引用不更换，当前有效编辑绝不被覆盖。
 */
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
  generateSyntheticSource,
  hashBytes,
  quantizeToInt16,
} from '../src/model.js';
import { decodeWav, encodeWav } from '../src/wav.js';
import { EditError } from '../src/errors.js';
import { drawWaveform, xToSample, clipColor } from './waveform.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  fileInput: $('#file-input'),
  loadSynthetic: $('#load-synthetic'),
  sourceMeta: $('#source-meta'),
  sourceCanvas: $('#source-canvas'),
  selectionInfo: $('#selection-info'),
  form: $('#clip-form'),
  startSample: $('#start-sample'),
  endSample: $('#end-sample'),
  startTime: $('#start-time'),
  endTime: $('#end-time'),
  fadeInMs: $('#fade-in-ms'),
  fadeOutMs: $('#fade-out-ms'),
  formError: $('#form-error'),
  useSelection: $('#use-selection'),
  clipList: $('#clip-list'),
  silenceSamples: $('#silence-samples'),
  silenceMs: $('#silence-ms'),
  outputMeta: $('#output-meta'),
  outputCanvas: $('#output-canvas'),
  exportBtn: $('#export-btn'),
  resetBtn: $('#reset-btn'),
  exportError: $('#export-error'),
  manifestBox: $('#manifest-box'),
  audio: $('#preview-audio'),
  toast: $('#toast'),
};

let state = createInitialState();
/** 当前拖选（未提交） */
let draft = null;
/** 最近一次成功导出的 blob URL（用于预览试听） */
let previewUrl = null;
let activeClipId = null;

/* ── 小工具 ─────────────────────────────────────────────── */

function showToast(message, isError = true) {
  els.toast.textContent = message;
  els.toast.className = isError ? 'toast error show' : 'toast ok show';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toast.className = 'toast';
  }, 3200);
}

function fmtMs(ms) {
  return `${ms.toFixed(3)} ms`;
}

function fmtTime(samples, sr) {
  return `${(samples / sr).toFixed(6)} s`;
}

/** 尝试执行编辑函数；成功则替换 state 并重绘，失败保留原 state。 */
function commit(mutator, { announce } = {}) {
  try {
    const next = mutator(state);
    if (next !== state) {
      state = next;
      renderAll();
    }
    if (announce) showToast(announce, false);
    return true;
  } catch (err) {
    if (err instanceof EditError) {
      showToast(err.message);
      return false;
    }
    throw err;
  }
}

function downloadBytes(bytes, fileName, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ── 素材加载 ───────────────────────────────────────────── */

async function adoptSource(decoded, name) {
  const hash = await hashBytes(decoded.bytes);
  state = loadSource(createInitialState(), {
    name: name ?? '未命名.wav',
    samples: decoded.samples,
    sampleRate: decoded.sampleRate,
    bytes: decoded.bytes,
    hash,
  });
  draft = null;
  renderAll();
  showToast(`已加载 ${name}：${decoded.samples.length} 采样 @ ${decoded.sampleRate}Hz`, false);
}

els.fileInput.addEventListener('change', async () => {
  const file = els.fileInput.files?.[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const decoded = decodeWav(new Uint8Array(buf));
    await adoptSource(decoded, file.name);
  } catch (err) {
    if (err instanceof EditError) showToast(`拒绝加载：${err.message}`);
    else {
      showToast(`读取失败：${err.message}`);
    }
  } finally {
    els.fileInput.value = '';
  }
});

els.loadSynthetic.addEventListener('click', async () => {
  const g = generateSyntheticSource();
  const bytes = encodeWav(g.samples, g.sampleRate);
  const decoded = decodeWav(bytes);
  await adoptSource(decoded, 'synthetic-8000Hz-1s.wav');
});

/* ── 源波形拖选 ─────────────────────────────────────────── */

function eventSample(ev) {
  const rect = els.sourceCanvas.getBoundingClientRect();
  const x = Math.min(rect.width, Math.max(0, ev.clientX - rect.left));
  return xToSample(x, state.source.sampleCount, rect.width);
}

els.sourceCanvas.addEventListener('pointerdown', (ev) => {
  if (!state.source) return;
  els.sourceCanvas.setPointerCapture(ev.pointerId);
  const s = eventSample(ev);
  draft = { start: s, end: s, anchor: s };
  redrawSource();
});

els.sourceCanvas.addEventListener('pointermove', (ev) => {
  if (!draft || !state.source) return;
  const s = eventSample(ev);
  draft.start = Math.min(draft.anchor, s);
  draft.end = Math.max(draft.anchor, s);
  redrawSource();
  updateSelectionInfo();
});

function endDrag() {
  if (!draft) return;
  // 单击（零长度）不填充，仅保留拖选提示
  if (draft.end > draft.start) {
    els.startSample.value = String(draft.start);
    els.endSample.value = String(draft.end);
    syncTimeFromSamples();
  }
  updateSelectionInfo();
}

els.sourceCanvas.addEventListener('pointerup', endDrag);
els.sourceCanvas.addEventListener('pointercancel', () => {
  draft = null;
  redrawSource();
  updateSelectionInfo();
});

/* ── 新建片段表单（时间 ↔ 采样编号双向同步） ────────────── */

function parseSampleField(input) {
  const raw = input.value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new EditError('BAD_RANGE', `“${input.dataset.label}”必须是非负整数采样编号（当前：${raw || '空'}）`);
  }
  return Number(raw);
}

function syncSamplesFromTime() {
  if (!state.source) return;
  const sr = state.source.sampleRate;
  for (const [timeEl, sampleEl] of [
    [els.startTime, els.startSample],
    [els.endTime, els.endSample],
  ]) {
    const sec = Number(timeEl.value);
    if (timeEl.value !== '' && Number.isFinite(sec) && sec >= 0) {
      sampleEl.value = String(msToSamples(sec * 1000, sr));
    }
  }
}

function syncTimeFromSamples() {
  if (!state.source) return;
  const sr = state.source.sampleRate;
  for (const [sampleEl, timeEl] of [
    [els.startSample, els.startTime],
    [els.endSample, els.endTime],
  ]) {
    if (/^\d+$/.test(sampleEl.value.trim())) {
      timeEl.value = (Number(sampleEl.value) / sr).toString();
    }
  }
}

els.startTime.addEventListener('input', syncSamplesFromTime);
els.endTime.addEventListener('input', syncSamplesFromTime);
els.startSample.addEventListener('input', syncTimeFromSamples);
els.endSample.addEventListener('input', syncTimeFromSamples);

els.useSelection.addEventListener('click', () => {
  if (!draft || draft.end === draft.start) {
    showToast('请先在波形上拖选出一个区间');
    return;
  }
  els.startSample.value = String(draft.start);
  els.endSample.value = String(draft.end);
  syncTimeFromSamples();
});

els.form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!state.source) {
    showToast('请先导入 WAV 或加载生成素材');
    return;
  }
  try {
    const start = parseSampleField(els.startSample);
    const end = parseSampleField(els.endSample);
    const fadeInMs = Number(els.fadeInMs.value || 0);
    const fadeOutMs = Number(els.fadeOutMs.value || 0);
    if (!Number.isFinite(fadeInMs) || fadeInMs < 0 || !Number.isFinite(fadeOutMs) || fadeOutMs < 0) {
      throw new EditError('BAD_DURATION', '淡化时长必须是非负毫秒数');
    }
    els.formError.textContent = '';
    const ok = commit(
      (s) => addClip(s, { start, end, fadeInMs, fadeOutMs }),
      { announce: `已添加片段 [${start}, ${end})` },
    );
    if (ok) {
      els.fadeInMs.value = '0';
      els.fadeOutMs.value = '0';
      draft = null;
      redrawSource();
      updateSelectionInfo();
    }
  } catch (err) {
    if (err instanceof EditError) {
      els.formError.textContent = err.message;
      showToast(err.message);
    } else throw err;
  }
});

/* ── 全局静音 ───────────────────────────────────────────── */

els.silenceSamples.addEventListener('change', () => {
  const raw = els.silenceSamples.value.trim();
  if (!/^\d+$/.test(raw)) {
    showToast('静音长度必须是非负整数采样数');
    els.silenceSamples.value = String(state.silenceSamples);
    return;
  }
  commit((s) => setSilence(s, Number(raw)));
  els.silenceSamples.value = String(state.silenceSamples);
  els.silenceMs.textContent = state.source
    ? fmtMs(samplesToMs(state.silenceSamples, state.source.sampleRate))
    : '';
});

/* ── 恢复原始编辑 ───────────────────────────────────────── */

els.resetBtn.addEventListener('click', () => {
  commit(
    (s) => resetEdits(s),
    { announce: '已恢复原始编辑状态（片段与静音已清空，素材保留）' },
  );
});

/* ── 导出 ───────────────────────────────────────────────── */

els.exportBtn.addEventListener('click', () => {
  try {
    const baseName = state.source?.name?.replace(/\.wav$/i, '') ?? 'output';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const wavName = `${baseName}-training-${stamp}.wav`;
    const { wavBytes, manifest } = exportProject(state, wavName);

    downloadBytes(wavBytes, wavName, 'audio/wav');
    const manifestName = `${baseName}-training-${stamp}.manifest.json`;
    downloadBytes(JSON.stringify(manifest, null, 2), manifestName, 'application/json');

    els.manifestBox.textContent = JSON.stringify(manifest, null, 2);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([wavBytes], { type: 'audio/wav' }));
    els.audio.src = previewUrl;

    els.exportError.textContent = '';
    showToast(`已导出 ${wavName}（${manifest.output.totalSamples} 采样）与来源说明`, false);
  } catch (err) {
    if (err instanceof EditError) {
      els.exportError.textContent = err.message;
      showToast(`无法导出：${err.message}`);
    } else throw err;
  }
});

/* ── 片段列表交互（事件委托） ───────────────────────────── */

els.clipList.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const action = btn.dataset.action;
  if (action === 'up') commit((s) => moveClip(s, id, -1));
  else if (action === 'down') commit((s) => moveClip(s, id, 1));
  else if (action === 'duplicate') commit((s) => duplicateClip(s, id), { announce: '已重复引用同一来源区间' });
  else if (action === 'delete') commit((s) => removeClip(s, id), { announce: '已删除片段' });
  else if (action === 'locate') {
    activeClipId = activeClipId === id ? null : id;
    redrawSource();
    renderClipList();
  }
});

els.clipList.addEventListener('change', (ev) => {
  const input = ev.target.closest('input[data-fade]');
  if (!input) return;
  const id = input.closest('tr').dataset.id;
  const ms = Number(input.value);
  if (!Number.isFinite(ms) || ms < 0) {
    showToast('淡化时长必须是非负毫秒数');
    renderClipList(); // 还原为已提交值
    return;
  }
  const patch = input.dataset.fade === 'in' ? { fadeInMs: ms } : { fadeOutMs: ms };
  const ok = commit((s) => updateClip(s, id, patch));
  if (!ok) renderClipList(); // 还原输入框为当前有效值
});

/* ── 渲染 ───────────────────────────────────────────────── */

function redrawSource() {
  if (!state.source) {
    drawWaveform(els.sourceCanvas, new Int16Array(0), 8000, {});
    return;
  }
  const regions = state.clips.map((clip, i) => ({
    start: clip.start,
    end: clip.end,
    color: clipColor(i),
    active: clip.id === activeClipId,
  }));
  drawWaveform(els.sourceCanvas, state.source.samples, state.source.sampleRate, {
    regions,
    selection: draft,
  });
}

function updateSelectionInfo() {
  if (!state.source) {
    els.selectionInfo.textContent = '—';
    return;
  }
  if (draft && draft.end > draft.start) {
    const len = draft.end - draft.start;
    els.selectionInfo.textContent =
      `拖选 [${draft.start}, ${draft.end}) ｜ 长度 ${len} 采样 ｜ ${fmtTime(draft.start, state.source.sampleRate)} → ${fmtTime(draft.end, state.source.sampleRate)}`;
  } else {
    els.selectionInfo.textContent = '在波形上按住拖选；区间为左闭右开';
  }
}

function renderSourceMeta() {
  if (!state.source) {
    els.sourceMeta.textContent = '未加载素材';
    return;
  }
  const s = state.source;
  const hashShort = s.hash ? s.hash.slice(0, 12) : '—';
  els.sourceMeta.innerHTML =
    `<span class="kv">文件 <b>${s.name}</b></span>` +
    `<span class="kv">采样率 <b>${s.sampleRate} Hz</b></span>` +
    `<span class="kv">采样数 <b>${s.sampleCount}</b></span>` +
    `<span class="kv">时长 <b>${(s.sampleCount / s.sampleRate).toFixed(3)} s</b></span>` +
    `<span class="kv">SHA-256 <b>${hashShort}</b></span>`;
}

function renderClipList() {
  const sr = state.source?.sampleRate ?? 1;
  const rows = state.clips.map((clip, i) => {
    const length = clip.end - clip.start;
    const fadeIn = msToSamples(clip.fadeInMs, sr);
    const fadeOut = msToSamples(clip.fadeOutMs, sr);
    const color = clipColor(i);
    return `
      <tr data-id="${clip.id}" class="${clip.id === activeClipId ? 'active-row' : ''}">
        <td class="order"><span class="ord-dot" style="background:${color}"></span>${i + 1}</td>
        <td class="nums">
          <div class="range">[${clip.start}, ${clip.end})</div>
          <div class="sub">${samplesToMs(clip.start, sr).toFixed(3)} – ${samplesToMs(clip.end, sr).toFixed(3)} ms</div>
          <div class="sub">长 ${length} 采样</div>
        </td>
        <td>
          <label class="fade-cell">淡入
            <input type="number" min="0" step="0.0625" data-fade="in" value="${clip.fadeInMs}">
            <span class="sub">ms → ${fadeIn} 采样</span>
          </label>
        </td>
        <td>
          <label class="fade-cell">淡出
            <input type="number" min="0" step="0.0625" data-fade="out" value="${clip.fadeOutMs}">
            <span class="sub">ms → ${fadeOut} 采样</span>
          </label>
        </td>
        <td class="actions">
          <button type="button" data-action="up" title="前移" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-action="down" title="后移" ${i === state.clips.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-action="duplicate" title="重复引用同一区间">⧉</button>
          <button type="button" data-action="locate" title="在源波形高亮">◎</button>
          <button type="button" data-action="delete" class="danger" title="删除">✕</button>
        </td>
      </tr>`;
  });
  els.clipList.querySelector('tbody').innerHTML = rows.join('');
  els.clipList.dataset.empty = state.clips.length === 0 ? 'true' : 'false';
}

function renderOutput() {
  if (!state.source) {
    els.outputMeta.textContent = '—';
    drawWaveform(els.outputCanvas, new Int16Array(0), 8000, {});
    return;
  }
  let plan = null;
  try {
    plan = buildPlan(state);
  } catch (err) {
    if (err instanceof EditError && err.code === 'EMPTY_PLAN') {
      els.outputMeta.textContent = '尚无片段 —— 添加片段后才能导出';
      drawWaveform(els.outputCanvas, new Int16Array(0), state.source.sampleRate, {});
      els.exportError.textContent = '';
      return;
    }
    throw err;
  }

  const samples = renderSamples(state, plan);
  const regions = [];
  let cursor = 0;
  plan.items.forEach((item, i) => {
    regions.push({
      start: cursor,
      end: cursor + item.length,
      color: clipColor(i),
    });
    cursor += item.length + (i < plan.items.length - 1 ? plan.silenceSamples : 0);
  });
  drawWaveform(els.outputCanvas, samples, plan.sampleRate, { regions, height: 140 });

  const silenceTotal = plan.silenceSamples * (plan.items.length - 1);
  els.outputMeta.innerHTML =
    `<span class="kv">片段 <b>${plan.items.length}</b></span>` +
    `<span class="kv">输出采样 <b>${plan.totalSamples}</b></span>` +
    `<span class="kv">时长 <b>${(plan.totalSamples / plan.sampleRate).toFixed(6)} s</b></span>` +
    `<span class="kv">其中静音 <b>${silenceTotal}</b> 采样（${samplesToMs(silenceTotal, plan.sampleRate).toFixed(3)} ms）</span>`;
}

function renderAll() {
  renderSourceMeta();
  renderClipList();
  renderOutput();
  redrawSource();
  updateSelectionInfo();
  if (state.source) {
    els.silenceMs.textContent = fmtMs(samplesToMs(state.silenceSamples, state.source.sampleRate));
    els.silenceSamples.value = String(state.silenceSamples);
  }
}

/* 初始绘制 + 窗口缩放时重绘 */
function onResize() {
  if (state.source) {
    redrawSource();
    renderOutput();
  }
}
let resizeRaf = 0;
globalThis.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(onResize);
});

renderAll();

// 暴露给控制台手工核对（非业务依赖）
globalThis.__audioApp = {
  getState: () => state,
  quantizeToInt16,
};
