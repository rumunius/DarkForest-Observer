// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandConsole } from '../../apps/web/src/pages/command-console';

vi.mock('../../apps/web/src/state', () => ({
  useApp: () => ({
    data: { civilizations: [{ id: 'C01', nickname: '星尘' }], match: { revision: 1 } },
    busy: false,
    operate: vi.fn(),
  }),
}));
let root: Root;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(0);
    return 1;
  });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(CommandConsole)));
  return document.querySelector('textarea')!;
}
async function type(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      value,
    );
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(input: HTMLTextAreaElement, value: string) {
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    ),
  );
}
it('completes prefixes with Tab, clicks a child and restores focus and caret', async () => {
  const input = await mount();
  expect(document.querySelector('[role=listbox]')).toBeNull();
  await type(input, '/pl');
  expect(document.querySelectorAll('[role=option]')).toHaveLength(2);
  await key(input, 'Tab');
  expect(input.value).toBe('/player ');
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role=option]')].find((x) =>
    x.textContent?.startsWith('eliminate'),
  )!;
  await act(async () => option.click());
  expect(input.value).toBe('/player eliminate ');
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(input.value.length);
  await key(input, 'ArrowDown');
  await key(input, 'Tab');
  expect(input.value).toBe('/player eliminate @alive ');
});
it('does not consume Tab during IME composition, and Escape dismisses the panel', async () => {
  const input = await mount();
  await type(input, '/pl');
  await act(async () => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  await key(input, 'Tab');
  expect(input.value).toBe('/pl');
  await act(async () =>
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })),
  );
  await key(input, 'Escape');
  expect(document.querySelector('[role=listbox]')).toBeNull();
});
