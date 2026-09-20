/**
 * 统一错误类型：所有可向用户展示的拒绝原因都通过本类抛出。
 * code 供界面与测试区分错误类别，message 为可读说明。
 */
export class EditError extends Error {
  /**
   * @param {string} code 稳定的错误码（见下方常量）
   * @param {string} message 可读错误信息
   */
  constructor(code, message) {
    super(message);
    this.name = 'EditError';
    this.code = code;
  }
}

export const ErrorCode = Object.freeze({
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  BAD_RANGE: 'BAD_RANGE',
  BAD_DURATION: 'BAD_DURATION',
  BAD_FADE: 'BAD_FADE',
  FADE_OVERLAP: 'FADE_OVERLAP',
  NEGATIVE_SILENCE: 'NEGATIVE_SILENCE',
  CLIP_NOT_FOUND: 'CLIP_NOT_FOUND',
  EMPTY_PLAN: 'EMPTY_PLAN',
  SOURCE_MISMATCH: 'SOURCE_MISMATCH',
});
