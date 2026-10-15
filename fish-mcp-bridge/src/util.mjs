import {randomBytes, timingSafeEqual} from 'node:crypto';

export class BridgeError extends Error {
  constructor(message, status = 500, code = 'bridge_error') {
    super(message); this.status = status; this.code = code;
  }
}
export const randomSecret = () => randomBytes(32).toString('base64url');
export const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function getPath(object, path = '') {
  return path ? String(path).split('.').reduce((o, key) => o?.[key], object) : object;
}
export function setPath(object, path, value) {
  const parts = String(path).split('.');
  if (!parts.length || parts.some(p => !p || ['__proto__', 'prototype', 'constructor'].includes(p)))
    throw new BridgeError('参数映射路径无效。', 400, 'invalid_mapping');
  let node = object;
  for (const part of parts.slice(0, -1)) {
    if (node[part] === undefined) node[part] = {};
    if (!isObject(node[part])) throw new BridgeError('参数映射与固定参数发生冲突。', 400, 'invalid_mapping');
    node = node[part];
  }
  node[parts.at(-1)] = value;
}
export function publicError(error) {
  if (error instanceof BridgeError) return {status: error.status, code: error.code, message: error.message};
  if (['AbortError', 'TimeoutError'].includes(error?.name))
    return {status: 504, code: 'timeout', message: '请求超时或已取消。生成请求不会自动重发，以免重复扣费。'};
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.cause?.code || error?.code))
    return {status: 502, code: 'network_error', message: `网络连接失败（${error?.cause?.code || error.code}）。请检查运行适配器的机器，而不是手机的网络。`};
  return {status: 500, code: 'internal_error', message: '适配器处理失败。请运行 npm run doctor 检查连接；程序不会输出令牌。'};
}
export function assertString(value, name, max = 16000, required = false) {
  if (value === undefined || value === null) { if (!required) return ''; }
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new BridgeError(`${name} 必须是${required ? '非空的' : ''}字符串，最多 ${max} 字符。`, 400, 'invalid_input');
  return value;
}
export function intEnv(value, fallback, min, max, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
