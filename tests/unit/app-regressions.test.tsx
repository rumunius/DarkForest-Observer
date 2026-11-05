// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DataSource, Snapshot } from '@darkforest/contracts';
import { homeworldSubmission } from '../../packages/contracts/src/backend';
import { AppProvider, useApp } from '../../apps/web/src/state';
import { PlayerPages } from '../../apps/web/src/pages/player';
import { HttpSource } from '../../apps/web/src/data/http';
import { MockSource } from '../../apps/web/src/dev/mock-source';

let root: Root | undefined;
let latest: ReturnType<typeof useApp>;
function Probe() {
  latest = useApp();
  return null;
}
function VisiblePlayer() {
  return useApp().data.player ? createElement(PlayerPages) : null;
}
async function mount(source: DataSource, page = false) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(AppProvider, {
        source,
        children: [
          createElement(Probe, { key: 'probe' }),
          ...(page ? [createElement(VisiblePlayer, { key: 'page' })] : []),
        ],
      }),
    );
  });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  history.replaceState({}, '', '/player/homeworld');
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal('scrollTo', vi.fn());
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('actual React state and forms', () => {
  it('阅读本人消息后红点消失并跨页面保留，观战中他人私人事件不计入本人未读', async () => {
    const source = new MockSource(),
      fixture = await source.read('/player');
    const original = fixture.events.find((event) => event.audience === 'personal')!;
    fixture.events = [
      { ...original, id: 'mine', recipient: fixture.player!.id },
      { ...original, id: 'someone-else', recipient: 'C99' },
    ];
    vi.spyOn(source, 'read').mockImplementation(async () => structuredClone(fixture));
    history.replaceState({}, '', '/player');
    await mount(source, true);
    expect(latest.unread).toBe(1);
    await act(async () => latest.go('/player/messages'));
    expect(latest.unread).toBe(0);
    expect(document.body.textContent).not.toContain('someone-else');
    await act(async () => root!.unmount());
    root = undefined;
    await mount(source, true);
    expect(latest.unread).toBe(0);
    await act(async () => latest.go('/player/me'));
    await act(async () => latest.refresh());
    expect(latest.unread).toBe(0);
  });
  it('submits the real homeworld form through HttpSource using the shared strict wire schema', async () => {
    const initial = await new MockSource().read('/player');
    initial.player = {
      ...initial.player!,
      flight: 'unregistered',
      homeworld: null,
      homeVersion: 0,
      actions: ['homeworld-submit'],
    };
    const submitted: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith('/api/snapshot')) return Response.json(structuredClone(initial));
        if (url === '/api/action/homeworld-submit') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const parsed = homeworldSubmission(body);
          submitted.push(body);
          expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe(initial.session!.csrfToken);
          initial.player = {
            ...initial.player!,
            flight: 'pending',
            homeworld: parsed.code,
            homeVersion: 1,
          };
          return Response.json({
            requestId: parsed.request_id,
            status: 'complete',
            title: '母星登记已提交',
            message: '已保存',
          });
        }
        if (url.startsWith('/api/player/templates/'))
          return Response.json({ text: '已保存版本的登记消息' });
        throw new Error(`Unexpected HTTP request: ${url}`);
      }),
    );
    await mount(new HttpSource(), true);
    const input = document.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '001234',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('保存母星口令'),
    )!;
    expect(save).toBeDefined();
    await act(async () => save.click());
    expect(submitted).toHaveLength(1);
    expect(Object.keys(submitted[0]!).sort()).toEqual(['code', 'request_id']);
    expect(submitted[0]!.code).toBe('001234');
    expect(latest.data.player).toMatchObject({
      flight: 'pending',
      homeworld: '001234',
      homeVersion: 1,
    });
    expect(document.body.textContent).toContain('第1次提交');
  });

  it('continues adopting snapshots when every read takes longer than the polling interval', async () => {
    const source = new MockSource(),
      fixture = await source.read('/player');
    vi.useFakeTimers();
    let revision = fixture.match!.revision;
    const read = vi.spyOn(source, 'read').mockImplementation(
      () =>
        new Promise<Snapshot>((resolve) => {
          setTimeout(() => {
            const next = structuredClone(fixture);
            next.match!.revision = ++revision;
            resolve(next);
          }, 3500);
        }),
    );
    await mount(source);
    await act(async () => vi.advanceTimersByTimeAsync(3500));
    expect(latest.loading).toBe(false);
    expect(latest.data.match!.revision).toBe(revision);
    const first = latest.data.match!.revision;
    for (let i = 0; i < 3; i++) {
      await act(async () => vi.advanceTimersByTimeAsync(5500));
      expect(latest.data.match!.revision).toBeGreaterThan(first + i);
      expect(latest.data.match!.revision).toBe(revision);
    }
    expect(read).toHaveBeenCalledTimes(5); // two initial reads, then one per completed poll
  });

  it('discards a slow response from an old route after navigation', async () => {
    const source = new MockSource(),
      fixture = await source.read('/player');
    const pending: ((value: Snapshot) => void)[] = [];
    vi.spyOn(source, 'read').mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    await mount(source);
    await act(async () => latest.go('/player/messages'));
    const newest = structuredClone(fixture);
    newest.match!.revision = 20;
    await act(async () => pending.at(-1)!(newest));
    await act(async () => {
      for (const resolve of pending.slice(0, -1)) resolve(fixture);
    });
    expect(latest.route).toBe('/player/messages');
    expect(latest.data.match!.revision).toBe(20);
  });
});
