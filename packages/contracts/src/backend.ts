import type {HomeworldSubmission} from './index';

/** Public wire protocol. No storage types or secrets may be exported here. */
export const CONTRACT_VERSION = 1;
export type DomainPhase =
  | 'setup'
  | 'armed'
  | 'outfitting'
  | 'start_countdown'
  | 'forest'
  | 'apocalypse'
  | 'transfer'
  | 'hunt'
  | 'ended';
export interface ApiFailure {
  code: string;
  message: string;
  definitive: boolean;
}
export class ContractError extends Error {
  constructor(message = '输入内容有误，请检查后重试。') {
    super(message);
  }
}

/** Decode JSON as unknown; callers must validate input or cite a persisted schema. */
export function parseJson(value: string): unknown {
  return JSON.parse(value);
}

/** Convert scalar identifiers and legacy values without accepting object coercion. */
export function scalarText(value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return String(value);
  }
  throw new ContractError('此字段必须是文本或标量值。');
}

/** Read persisted permission lists, rejecting malformed entries before authorization. */
export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ContractError('列表格式不正确。');
  }
  const entries: unknown[] = value;
  return entries.map(entry => text(entry, Number.MAX_SAFE_INTEGER, 0));
}

/** Read numeric settings while retaining the caller's known parameter keys and defaults. */
export function numericRecord(value: unknown): Record<string, number> {
  const entries = Object.entries(object(value)).map(([key, entry]) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new ContractError('数值设置格式不正确。');
    }
    return [key, entry] as const;
  });
  return Object.fromEntries(entries);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError();
  }
  return value as Record<string, unknown>;
}
export function strict(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).some(key => !allowed.includes(key))) {
    throw new ContractError('提交内容有误，请刷新后重试。');
  }
  return result;
}
export function text(value: unknown, max = 500, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ContractError();
  }
  return value;
}
export function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new ContractError();
  }
  return value;
}
export function requestId(value: unknown): string {
  const id = text(value, 100);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ContractError('本次操作未能提交，请刷新后重试。');
  }
  return id;
}
export function coordinate(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{6}$/.test(value)) {
    throw new ContractError('请输入六位数字口令。');
  }
  return value;
}
export function homeworldSubmission(
  value: unknown,
): HomeworldSubmission & {request_id: string} {
  const body = strict(value, ['request_id', 'code']);
  return {request_id: requestId(body.request_id), code: coordinate(body.code)};
}
/** NFKC, trim, visible graphemes; case-sensitive uniqueness as confirmed by user. */
export function nickname(value: unknown): string {
  const normalized = text(value, 128).normalize('NFKC').trim();
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new ContractError('昵称中含有无法显示的内容，请换一个昵称。');
  }
  const length = [
    ...new Intl.Segmenter('zh', {granularity: 'grapheme'}).segment(normalized),
  ].length;
  if (length < 2 || length > 8 || !/\S/u.test(normalized)) {
    throw new ContractError('昵称长度应为2—8个字。');
  }
  return normalized;
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
