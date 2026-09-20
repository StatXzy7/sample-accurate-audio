/**
 * WAV（PCM）编解码：仅支持单声道、16 位 PCM，与浏览器、Node 均无关的纯函数。
 *
 * 解码后保留：
 * - samples: Int16Array，样本值（-32768..32767），样本下标即采样编号
 * - sampleRate: 采样率
 * - bytes: 原始 RIFF 字节（用于来源指纹，原始素材永远不变）
 *
 * 区间约定（全项目一致）：[start, end) 左闭右开，
 * 长度 = end - start，源合法下标范围为 0 .. sampleCount-1。
 */
import { EditError, ErrorCode } from './errors.js';

const RIFF_HEADER_SIZE = 12; // "RIFF" + size + "WAVE"
const CHUNK_HEADER_SIZE = 8; // fourCC + size

/** @param {ArrayBuffer|Uint8Array} input */
function asUint8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new EditError(
    ErrorCode.UNSUPPORTED_FORMAT,
    '仅支持 ArrayBuffer / Uint8Array 形式的 WAV 数据',
  );
}

function readFourCC(view, offset) {
  let tag = '';
  for (let i = 0; i < 4; i += 1) {
    tag += String.fromCharCode(view.getUint8(offset + i));
  }
  return tag;
}

/**
 * 解析单声道 16-bit PCM WAV。任何不符合约束的输入均抛出 UNSUPPORTED_FORMAT。
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{samples: Int16Array, sampleRate: number, bytes: Uint8Array}}
 */
export function decodeWav(input) {
  const bytes = asUint8(input);
  if (bytes.byteLength < RIFF_HEADER_SIZE) {
    throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, '文件过短，不是有效的 WAV');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WAVE') {
    throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, '缺少 RIFF/WAVE 标识，不是 WAV 文件');
  }

  let offset = RIFF_HEADER_SIZE;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = -1;

  while (offset + CHUNK_HEADER_SIZE <= bytes.byteLength) {
    const id = readFourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const bodyOffset = offset + CHUNK_HEADER_SIZE;
    if (bodyOffset + size > bytes.byteLength) {
      throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, `区块 ${id} 声明长度超出文件范围（文件可能被截断）`);
    }
    if (id === 'fmt ') {
      if (size < 16) {
        throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, 'fmt 区块长度不足 16 字节');
      }
      fmt = {
        format: view.getUint16(bodyOffset, true),
        channels: view.getUint16(bodyOffset + 2, true),
        sampleRate: view.getUint32(bodyOffset + 4, true),
        bitsPerSample: view.getUint16(bodyOffset + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = bodyOffset;
      dataSize = size;
    }
    // chunk 体按偶数字节对齐
    offset = bodyOffset + size + (size % 2);
  }

  if (!fmt) {
    throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, '缺少 fmt 区块');
  }
  if (dataOffset < 0) {
    throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, '缺少 data 区块');
  }
  if (fmt.format !== 1) {
    throw new EditError(
      ErrorCode.UNSUPPORTED_FORMAT,
      `不支持压缩格式（format tag=${fmt.format}），仅接受 PCM(1)`,
    );
  }
  if (fmt.channels !== 1) {
    throw new EditError(
      ErrorCode.UNSUPPORTED_FORMAT,
      `仅支持单声道，当前为 ${fmt.channels} 声道`,
    );
  }
  if (fmt.bitsPerSample !== 16) {
    throw new EditError(
      ErrorCode.UNSUPPORTED_FORMAT,
      `仅支持 16 位 PCM，当前为 ${fmt.bitsPerSample} 位`,
    );
  }
  if (fmt.sampleRate === 0) {
    throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, '采样率为 0，无效');
  }
  if (dataSize % 2 !== 0) {
    throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, 'data 区块长度为奇数，与 16 位 PCM 不符');
  }

  const samples = new Int16Array(
    bytes.buffer,
    bytes.byteOffset + dataOffset,
    dataSize / 2,
  );
  // 复制一份，避免视图与源缓冲别名导致意外共享
  const samplesCopy = new Int16Array(samples.length);
  samplesCopy.set(samples);

  return { samples: samplesCopy, sampleRate: fmt.sampleRate, bytes };
}

/**
 * 将 16 位样本编码为单声道 PCM WAV（Uint8Array，独立缓冲）。
 * @param {Int16Array} samples
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWav(samples, sampleRate) {
  if (!(samples instanceof Int16Array)) {
    throw new EditError(ErrorCode.UNSUPPORTED_FORMAT, 'encodeWav 仅接受 Int16Array');
  }
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(RIFF_HEADER_SIZE + CHUNK_HEADER_SIZE + 16 + CHUNK_HEADER_SIZE + dataSize);
  const out = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const writeFourCC = (off, tag) => {
    for (let i = 0; i < 4; i += 1) view.setUint8(off + i, tag.charCodeAt(i));
  };

  writeFourCC(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeFourCC(8, 'WAVE');

  writeFourCC(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt 大小
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节/秒
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深

  writeFourCC(36, 'data');
  view.setUint32(40, dataSize, true);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, dataSize), 44);

  return out;
}
