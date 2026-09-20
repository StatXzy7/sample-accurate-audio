/**
 * wav.js — 零依赖的单声道 16-bit PCM WAV 解析与编码。
 *
 * 同时可在 Node.js（自动化测试）与浏览器中运行：
 * 仅依赖全局 TextEncoder/TextDecoder、DataView 与 Int16Array。
 *
 * 支持的输入格式（其余一律拒绝）：
 *   - RIFF/WAVE 容器
 *   - PCM（format tag = 1）
 *   - 单声道（channels = 1）
 *   - 16-bit（bitsPerSample = 16）
 *   - data 块字节数必须为偶数（16-bit 样本的整数倍）
 */

/** 格式不被支持或文件结构损坏时抛出。 */
export class WavFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WavFormatError';
    this.code = 'UNSUPPORTED_FORMAT';
  }
}

const RIFF_TAG = 0x46464952; // "RIFF" 按小端 getUint32 读取的数值
const WAVE_TAG = 0x45564157; // "WAVE" 按小端 getUint32 读取的数值

function readAscii(view, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

/**
 * 解析单声道 16-bit PCM WAV。
 * @param {ArrayBuffer|Uint8Array|Buffer} input 完整文件字节
 * @returns {{sampleRate:number, samples:Int16Array}}
 * @throws {WavFormatError} 任何不支持或损坏的情况
 */
export function parseWav(input) {
  let bytes;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (input instanceof DataView) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else if (input && input.buffer instanceof ArrayBuffer && typeof input.byteLength === 'number') {
    // Node Buffer / 其它 TypedArray：复制以获得干净的 Uint8Array 视图
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new WavFormatError('输入不是有效的字节缓冲区（需要 ArrayBuffer/Uint8Array/Buffer）');
  }

  if (bytes.length < 44) {
    throw new WavFormatError(`文件过短（${bytes.length} 字节），不可能是合法 WAV（至少 44 字节）`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(0, true) !== RIFF_TAG) {
    throw new WavFormatError('缺少 RIFF 标识，不是 WAV 文件');
  }
  if (view.getUint32(8, true) !== WAVE_TAG) {
    throw new WavFormatError('缺少 WAVE 标识，不是 WAV 文件');
  }
  // RIFF size = 其后内容字节数（文件总长 − 8）；空 data 的最小合法值为 36。
  // 文件实际长度只能等于 8+riffSize，或因尾块对齐多一个 pad 字节。
  const riffSize = view.getUint32(4, true);
  const declaredTotal = 8 + riffSize;
  if (riffSize < 36 || bytes.length < declaredTotal || bytes.length > declaredTotal + 1) {
    throw new WavFormatError(
      `RIFF 长度字段（${riffSize}）与文件实际长度（${bytes.length - 8}）不一致，结构损坏`
    );
  }

  // 顺序扫描顶层块，记录 fmt 与第一个 data 块
  let offset = 12;
  let fmt = null;
  let dataBytes = null;
  let sawSecondData = false;

  while (offset + 8 <= bytes.length) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (bodyOffset + size > bytes.length) {
      throw new WavFormatError(`块 "${id}" 声明长度 ${size} 超出文件末尾（结构损坏）`);
    }

    if (id === 'fmt ') {
      if (size < 16) {
        throw new WavFormatError(`fmt 块过短（${size} 字节），至少需要 16 字节`);
      }
      fmt = {
        formatTag: view.getUint16(bodyOffset, true),
        channels: view.getUint16(bodyOffset + 2, true),
        sampleRate: view.getUint32(bodyOffset + 4, true),
        bitsPerSample: view.getUint16(bodyOffset + 14, true),
      };
    } else if (id === 'data') {
      if (dataBytes !== null) {
        // 多个 data 块属于不支持的拼接结构：拒绝而非静默截断第一个
        sawSecondData = true;
      } else {
        dataBytes = { offset: bodyOffset, size };
      }
    }

    // 块按偶数字节对齐（pad 字节不计入 size）
    offset = bodyOffset + size + (size % 2);
  }

  if (fmt === null) {
    throw new WavFormatError('未找到 fmt 块');
  }
  if (dataBytes === null) {
    throw new WavFormatError('未找到 data 块（无音频数据）');
  }
  if (sawSecondData) {
    throw new WavFormatError('检测到多个 data 块，不支持这种拼接结构');
  }
  if (fmt.formatTag !== 1) {
    throw new WavFormatError(`仅支持 PCM（format tag 1），当前为 ${fmt.formatTag}`);
  }
  if (fmt.channels !== 1) {
    throw new WavFormatError(`仅支持单声道，当前为 ${fmt.channels} 声道`);
  }
  if (fmt.bitsPerSample !== 16) {
    throw new WavFormatError(`仅支持 16-bit PCM，当前为 ${fmt.bitsPerSample}-bit`);
  }
  if (fmt.sampleRate === 0) {
    throw new WavFormatError('采样率为 0，文件不合法');
  }
  if (dataBytes.size % 2 !== 0) {
    throw new WavFormatError(`data 块长度 ${dataBytes.size} 为奇数，不是完整的 16-bit 样本序列`);
  }

  const sampleCount = dataBytes.size >> 1;
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = view.getInt16(dataBytes.offset + i * 2, true);
  }

  return { sampleRate: fmt.sampleRate, samples };
}

/**
 * 将 16-bit 样本编码为单声道 PCM WAV 字节。
 * @param {Int16Array|number[]} samples
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWav(samples, sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 0xffffffff) {
    throw new WavFormatError('采样率必须为 1..4294967295 范围内的整数');
  }
  if (!(samples instanceof Int16Array)) {
    throw new WavFormatError('encodeWav 仅接受 Int16Array');
  }

  const dataSize = samples.length * 2;
  if (36 + dataSize > 0xffffffff) {
    throw new WavFormatError(`数据过大（${dataSize} 字节），超出 WAV 32 位长度上限`);
  }
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  const writeAscii = (str, pos) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(pos + i, str.charCodeAt(i));
    }
  };

  writeAscii('RIFF', 0);
  view.setUint32(4, 36 + dataSize, true);
  writeAscii('WAVE', 8);
  writeAscii('fmt ', 12);
  view.setUint32(16, 16, true); // PCM fmt 块大小
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节/秒 = 采样率 × 声道 × 位深/8
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true);
  writeAscii('data', 36);
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, samples[i], true);
  }

  return out;
}
