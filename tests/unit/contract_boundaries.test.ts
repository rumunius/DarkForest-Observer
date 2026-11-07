import {expect, it, vi} from 'vitest';
import {
  ContractError,
  numericRecord,
  parseJson,
  scalarText,
  stringArray,
} from '../../packages/contracts/src/backend';
import {handleAsync} from '../../apps/web/src/data/async_event';
import {requireError} from '@darkforest/contracts';

it('retains caught error identity and rejects values that violate the throwing contract', () => {
  for (const error of [
    new Error('request failed'),
    new ContractError(),
    new DOMException('aborted', 'AbortError'),
  ]) {
    expect(requireError(error)).toBe(error);
  }
  for (const value of [undefined, null, 'failed', 1, {message: 'failed'}]) {
    expect(() => requireError(value)).toThrow(TypeError);
  }
});

it('keeps scalar conversion and leading zeroes while rejecting object coercion', () => {
  expect(scalarText('000001')).toBe('000001');
  expect(scalarText(12)).toBe('12');
  expect(scalarText(false)).toBe('false');
  expect(scalarText(null)).toBe('null');
  expect(scalarText(undefined)).toBe('undefined');
  for (const value of [{id: 'C01'}, ['C01'], new ArrayBuffer(1)]) {
    expect(() => scalarText(value)).toThrow(ContractError);
  }
});

it('validates permission and setting containers rather than trusting decoded JSON', () => {
  expect(stringArray(parseJson('["system","commands"]'))).toEqual([
    'system',
    'commands',
  ]);
  for (const text of ['null', '{}', '"system"', '["system",1]']) {
    expect(() => stringArray(parseJson(text))).toThrow(ContractError);
  }
  expect(numericRecord(parseJson('{"singerPercent":5}'))).toEqual({
    singerPercent: 5,
  });
  expect(() => numericRecord({singerPercent: '5'})).toThrow(ContractError);
  expect(() => numericRecord({singerPercent: Infinity})).toThrow(ContractError);
});

it('bridges a rejected async event to UI feedback without returning a promise to the DOM', async () => {
  const error = new Error('request failed');
  const report = vi.fn<(error: unknown) => void>();
  let submitted = '';
  const listener = handleAsync((id: string) => {
    submitted = id;
    return Promise.reject<never>(error);
  }, report);
  expect(listener('request-1')).toBeUndefined();
  expect(submitted).toBe('request-1');
  await Promise.resolve();
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
});

it('reports synchronous event failures through the same feedback channel', () => {
  const error = new Error('event failed');
  const report = vi.fn<(error: unknown) => void>();
  const listener = handleAsync(() => {
    throw error;
  }, report);
  expect(() => listener()).not.toThrow();
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
});
