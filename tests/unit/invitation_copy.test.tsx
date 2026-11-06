// @vitest-environment happy-dom
import {afterEach, expect, it, vi} from 'vitest';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {Delivery} from '../../apps/web/src/platform/shared';
import {promiseStub} from '../helpers/promise_stub';

let root: Root | undefined;
afterEach(async () => {
  const current = root;
  if (current) {
    await act(promiseStub(() => current.unmount()));
  }
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(invitation: string | null) {
  if (!root) {
    Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  const current = root;
  await act(
    promiseStub(() =>
      current.render(
        createElement(Delivery, {
          value: invitation === null ? null : {invitation},
        }),
      ),
    ),
  );
}

function button(): HTMLButtonElement {
  const element = document.querySelector('button');
  if (!element) {
    throw new Error('Invitation copy button is missing');
  }
  return element;
}

it('reports invitation copy success only after writing the exact claim link', async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();
  writeText.mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {clipboard: {writeText}});
  await render('invitation-one');
  expect(document.querySelector<Element>('[role="status"]')).toBeNull();
  await act(promiseStub(() => button().click()));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(
    `${location.origin}/claim#invitation-one`,
  );
  expect(
    document.querySelector<Element>('[role="status"]')?.textContent,
  ).toContain('已复制');
  expect(button().disabled).toBe(false);
});

it('keeps the claim link selectable and explains a denied clipboard request', async () => {
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: promiseStub(() => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    },
  });
  await render('invitation-denied');
  await act(promiseStub(() => button().click()));
  expect(
    document.querySelector<Element>('[role="status"]')?.textContent,
  ).toContain('手动复制');
  expect(document.querySelector('code')?.textContent).toBe(
    `${location.origin}/claim#invitation-denied`,
  );
  expect(button().disabled).toBe(false);
});

it('handles browsers without the clipboard API through the same manual copy feedback', async () => {
  vi.stubGlobal('navigator', {});
  await render('invitation-no-api');
  await act(promiseStub(() => button().click()));
  expect(
    document.querySelector<Element>('[role="status"]')?.textContent,
  ).toContain('手动复制');
  expect(button().disabled).toBe(false);
});

it('isolates feedback and pending state when the delivered invitation changes', async () => {
  let completeCopy: (() => void) | undefined;
  const pending = new Promise<void>(resolve => {
    completeCopy = resolve;
  });
  const writeText = vi.fn<(text: string) => Promise<void>>();
  writeText.mockReturnValueOnce(pending).mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {clipboard: {writeText}});
  await render('old-invitation');
  await act(promiseStub(() => button().click()));
  expect(button().disabled).toBe(true);
  await render('new-invitation');
  expect(button().disabled).toBe(false);
  if (!completeCopy) {
    throw new Error('Deferred clipboard resolver is missing');
  }
  await act(promiseStub(completeCopy));
  expect(document.querySelector<Element>('[role="status"]')).toBeNull();
  expect(document.querySelector('code')?.textContent).toBe(
    `${location.origin}/claim#new-invitation`,
  );
  await act(promiseStub(() => button().click()));
  expect(
    document.querySelector<Element>('[role="status"]')?.textContent,
  ).toContain('已复制');
  await render(null);
  expect(document.querySelector('code')).toBeNull();
});
