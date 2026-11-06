import {promiseStub} from '../helpers/promise_stub';
import {jsonObject, jsonString, parseJson} from '../helpers/json';
// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import type {DataSource, Snapshot} from '@darkforest/contracts';
import {homeworldSubmission} from '../../packages/contracts/src/backend';
import {AppProvider, useApp} from '../../apps/web/src/state';
import {PlayerPages} from '../../apps/web/src/pages/player';
import {HttpSource} from '../../apps/web/src/data/http';
import {MockSource} from '../../apps/web/src/dev/mock_source';

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
  await act(
    promiseStub(() => {
      root!.render(
        createElement(AppProvider, {
          source,
          children: [
            createElement(Probe, {key: 'probe'}),
            ...(page ? [createElement(VisiblePlayer, {key: 'page'})] : []),
          ],
        }),
      );
    }),
  );
}
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  history.replaceState({}, '', '/player/homeworld');
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal('scrollTo', vi.fn());
});
afterEach(async () => {
  if (root) {
    await act(promiseStub(() => root!.unmount()));
  }
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('actual React state and forms', () => {
  it('ignores structurally invalid read-message caches without breaking the page', async () => {
    const source = new MockSource();
    const fixture = await source.read('/player');
    const original = fixture.events.find(
      event => event.audience === 'personal',
    )!;
    fixture.events = [
      {...original, id: 'unread', recipient: fixture.player!.id},
    ];
    vi.spyOn(source, 'read').mockImplementation(
      promiseStub(() => structuredClone(fixture)),
    );
    const session = fixture.session!;
    const key = `.darkforest.read.${session.matchId}.${session.role}.${session.id}`;
    localStorage.setItem(key, JSON.stringify({includes: 'invalid cache'}));
    history.replaceState({}, '', '/player');
    await mount(source);
    expect(latest.unread).toBe(1);
    await act(promiseStub(() => latest.markRead('unread')));
    expect(latest.unread).toBe(0);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(['unread']);
  });

  it('discards a malformed pending record instead of blocking a new operation', async () => {
    const source = new MockSource();
    const fixture = await source.read('/player');
    vi.spyOn(source, 'read').mockImplementation(
      promiseStub(() => structuredClone(fixture)),
    );
    const submit = vi.spyOn(source, 'submit').mockImplementation(
      promiseStub(operation => ({
        requestId: operation.requestId,
        status: 'complete',
        title: '已保存',
        message: '',
      })),
    );
    history.replaceState({}, '', '/player');
    await mount(source);
    // A storage event, extension or another script can change the cache after mounting.
    sessionStorage.setItem(
      'darkforest.pending-operation',
      JSON.stringify({
        id: 42,
        account: fixture.session!.id,
        match: fixture.session!.matchId,
      }),
    );
    await act(async () =>
      latest.operate('/player/nickname', {nickname: '新昵称'}),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(latest.pending).toBeNull();
    expect(latest.error).toBe('');
  });

  it('阅读本人消息后红点消失并跨页面保留，观战中他人私人事件不计入本人未读', async () => {
    const source = new MockSource();
    const fixture = await source.read('/player');
    const original = fixture.events.find(
      event => event.audience === 'personal',
    )!;
    fixture.events = [
      {...original, id: 'mine', recipient: fixture.player!.id},
      {...original, id: 'someone-else', recipient: 'C99'},
    ];
    vi.spyOn(source, 'read').mockImplementation(
      promiseStub(() => structuredClone(fixture)),
    );
    history.replaceState({}, '', '/player');
    await mount(source, true);
    expect(latest.unread).toBe(1);
    await act(promiseStub(() => latest.go('/player/messages')));
    expect(latest.unread).toBe(0);
    expect(document.body.textContent).not.toContain('someone-else');
    await act(promiseStub(() => root!.unmount()));
    root = undefined;
    await mount(source, true);
    expect(latest.unread).toBe(0);
    await act(promiseStub(() => latest.go('/player/me')));
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
    const submitted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        promiseStub((url: string, init?: RequestInit) => {
          if (url.startsWith('/api/snapshot')) {
            return Response.json(structuredClone(initial));
          }
          if (url === '/api/action/homeworld-submit') {
            const body = jsonObject(parseJson(jsonString(init?.body)));
            const parsed = homeworldSubmission(body);
            submitted.push(body);
            expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe(
              initial.session!.csrfToken,
            );
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
          if (url.startsWith('/api/player/templates/')) {
            return Response.json({text: '已保存版本的登记消息'});
          }
          throw new Error(`Unexpected HTTP request: ${url}`);
        }),
      ),
    );
    await mount(new HttpSource(), true);
    const input = document.querySelector<HTMLInputElement>(
      'input[inputmode="numeric"]',
    )!;
    expect(input).not.toBeNull();
    await act(
      promiseStub(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, '001234');
        input.dispatchEvent(new Event('input', {bubbles: true}));
      }),
    );
    const save = [...document.querySelectorAll('button')].find(button =>
      button.textContent?.includes('保存母星口令'),
    )!;
    expect(save).toBeDefined();
    await act(promiseStub(() => save.click()));
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
    const source = new MockSource();
    const fixture = await source.read('/player');
    vi.useFakeTimers();
    let revision = fixture.match!.revision;
    const read = vi.spyOn(source, 'read').mockImplementation(
      () =>
        new Promise<Snapshot>(resolve => {
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
    const source = new MockSource();
    const fixture = await source.read('/player');
    const pending: Array<(value: Snapshot) => void> = [];
    vi.spyOn(source, 'read').mockImplementation(
      () => new Promise(resolve => pending.push(resolve)),
    );
    await mount(source);
    await act(promiseStub(() => latest.go('/player/messages')));
    const newest = structuredClone(fixture);
    newest.match!.revision = 20;
    await act(promiseStub(() => pending.at(-1)!(newest)));
    await act(
      promiseStub(() => {
        for (const resolve of pending.slice(0, -1)) {
          resolve(fixture);
        }
      }),
    );
    expect(latest.route).toBe('/player/messages');
    expect(latest.data.match!.revision).toBe(20);
  });

  it('discards history pages belonging to a route that is no longer active', async () => {
    const source = new MockSource();
    const fixture = await source.read('/player');
    const event = fixture.events[0]!;
    fixture.events = [{...event, id: 'current'}];
    fixture.eventCursor = 'older-page';
    vi.spyOn(source, 'read').mockImplementation(
      promiseStub(() => structuredClone(fixture)),
    );
    let finish!: (page: {
      items: Snapshot['events'];
      nextCursor: string | null;
    }) => void;
    const page = new Promise<{
      items: Snapshot['events'];
      nextCursor: string | null;
    }>(resolve => {
      finish = resolve;
    });
    Object.assign(source, {eventsPage: vi.fn(() => page)});
    await mount(source);
    let loading!: Promise<void>;
    await act(
      promiseStub(() => {
        loading = latest.loadEarlierEvents();
      }),
    );
    await act(promiseStub(() => latest.go('/player/messages')));
    await act(async () => {
      finish({items: [{...event, id: 'stale-history'}], nextCursor: null});
      await loading;
    });
    expect(latest.data.events.map(item => item.id)).toEqual(['current']);
    expect(latest.data.eventCursor).toBe('older-page');
  });

  it('preserves already loaded history and deduplicates it on snapshot refresh', async () => {
    const source = new MockSource();
    const fixture = await source.read('/player');
    const event = fixture.events[0]!;
    fixture.events = [{...event, id: 'current'}];
    fixture.eventCursor = 'first-page';
    vi.spyOn(source, 'read').mockImplementation(
      promiseStub(() => structuredClone(fixture)),
    );
    Object.assign(source, {
      eventsPage: vi.fn(
        promiseStub(() => ({
          items: [
            {...event, id: 'current'},
            {...event, id: 'older'},
          ],
          nextCursor: 'second-page',
        })),
      ),
    });
    await mount(source);
    await act(async () => latest.loadEarlierEvents());
    fixture.events = [
      {...event, id: 'newest'},
      {...event, id: 'current'},
    ];
    fixture.match!.revision++;
    await act(async () => latest.refresh());
    expect(latest.data.events.map(item => item.id)).toEqual([
      'newest',
      'current',
      'older',
    ]);
    expect(latest.data.eventCursor).toBe('second-page');
  });

  it('ignores an operation response after the provider authorization epoch changes', async () => {
    const source = new MockSource();
    const fixture = await source.read('/player');
    vi.spyOn(source, 'read').mockImplementation(
      promiseStub(() => structuredClone(fixture)),
    );
    let finish!: (result: Awaited<ReturnType<DataSource['submit']>>) => void;
    vi.spyOn(source, 'submit').mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    await mount(source);
    let operation!: ReturnType<typeof latest.operate>;
    await act(
      promiseStub(() => {
        operation = latest.operate('/player/nickname', {nickname: '原草稿'});
      }),
    );
    expect(latest.busy).toBe(true);
    await act(
      promiseStub(() =>
        root!.render(
          createElement(AppProvider, {
            source,
            epoch: 1,
            children: createElement(Probe),
          }),
        ),
      ),
    );
    await act(async () => {
      finish({
        requestId: 'old-request',
        status: 'complete',
        title: '旧操作',
        message: '',
      });
      await operation;
    });
    expect(latest.result).toBeNull();
    expect(latest.pending).toBeNull();
    expect(latest.busy).toBe(false);
    expect(sessionStorage.getItem('darkforest.pending-operation')).toBeNull();
  });
});
