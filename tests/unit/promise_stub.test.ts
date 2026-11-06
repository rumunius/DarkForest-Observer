import {expect, it} from 'vitest';
import {promiseStub} from '../helpers/promise_stub';

it('runs stub work immediately, forwards arguments and returns a promise', async () => {
  let observed = 0;
  const stub = promiseStub((a: number, b: number) => {
    observed = a + b;
    return observed;
  });
  const result = stub(2, 3);
  expect(observed).toBe(5);
  expect(result).toBeInstanceOf(Promise);
  await expect(result).resolves.toBe(5);
});

it('turns synchronous exceptions into rejections and adopts promised results', async () => {
  const error = new Error('stub failure');
  const reject = promiseStub(() => {
    throw error;
  });
  await expect(reject()).rejects.toBe(error);
  await expect(promiseStub(() => Promise.resolve('value'))()).resolves.toBe(
    'value',
  );
});
