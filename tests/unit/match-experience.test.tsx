// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MatchEntry, PlatformSession } from '@darkforest/contracts';
import { PlatformApp, MatchApp } from '../../apps/web/src/platform';
import { App } from '../../apps/web/src/app';
import { AppProvider } from '../../apps/web/src/state';
import { ManagementForm } from '../../apps/web/src/pages/judge';
import { MockSource } from '../../apps/web/src/dev/mock-source';
let root: Root | undefined;
const session: PlatformSession = {
  account: {
    id: 'account',
    kind: 'player',
    name: '玩家',
    status: 'active',
    version: 1,
    auth_epoch: 1,
    tags: '',
  },
  roles: [],
  csrfToken: 'csrf',
  recent: true,
  secondFactor: false,
};
const entry: MatchEntry = {
  id: 'match-a',
  name: '秋季比赛',
  kind: 'official',
  state: 'available',
  version: 1,
  created_utc: 1,
  summary: '{}',
  synced_utc: null,
  recommended: 0,
  retention_days: 44,
  audit_days: 365,
  phase: 'setup',
  membership: {
    account_id: 'account',
    kind: 'player',
    name: '玩家',
    local_id: null,
    state: 'invited',
    epoch: 1,
    assignment_id: null,
  },
};
async function mount(node: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState({}, '', '/matches');
  vi.stubGlobal('scrollTo', vi.fn());
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('登录、邀请与场内体验', () => {
  it('显式选择玩家账号优先于先前保存的工作人员类别', async () => {
    sessionStorage.setItem('df.portal.audience', 'staff');
    history.replaceState({}, '', '/matches?audience=player');
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-Darkforest-Audience')).toBe('player');
      return Response.json(null);
    });
    vi.stubGlobal('fetch', fetcher);
    await mount(<PlatformApp />);
    expect(document.querySelector('select')?.value).toBe('player');
  });
  it('访客不显示我的比赛与账号安全导航', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(null)),
    );
    await mount(<PlatformApp />);
    const nav = document.querySelector('[aria-label="赛事中心导航"]')!;
    expect(nav.textContent).not.toContain('我的比赛');
    expect(nav.textContent).not.toContain('账号与安全');
    expect(document.body.textContent).toContain('长期口令');
  });
  it('未接受邀请时无进入入口，接受完成后移除按钮并直接显示进入比赛', async () => {
    let bound = false;
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/auth/session') return Response.json(session);
      if (url === '/api/me/matches')
        return Response.json([
          {
            ...entry,
            membership: {
              ...entry.membership,
              ...(bound ? { state: 'bound', local_id: 'C01' } : {}),
            },
          },
        ]);
      if (url.endsWith('/members/accept'))
        return Response.json({ operationId: 'accept-operation' });
      if (url === '/api/me/operations/accept-operation') {
        bound = true;
        return Response.json({ status: 'succeeded' });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await mount(<PlatformApp />);
    expect(document.body.textContent).not.toContain('进入比赛');
    expect(document.body.textContent).not.toContain('确认本场文明');
    const accept = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '接受邀请',
    )!;
    await act(async () => accept.click());
    expect(
      [...document.querySelectorAll('button')].some((button) => button.textContent === '接受邀请'),
    ).toBe(false);
    expect(document.querySelector('a[href="/m/match-a/player"]')?.textContent).toBe('进入比赛');
    expect(document.body.textContent).toContain('已加入本场');
    expect(fetcher.mock.calls.some(([url]) => url.includes('/members/bind'))).toBe(false);
    expect(document.body.textContent).not.toContain('赛后资料与版本');
  });
  it('已接受邀请但尚未任职的工作人员只看到等待安排岗位', async () => {
    sessionStorage.setItem('df.portal.audience', 'staff');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        Response.json(
          url === '/api/auth/session'
            ? { ...session, account: { ...session.account, kind: 'staff' } }
            : [{ ...entry, membership: { ...entry.membership, kind: 'staff', state: 'accepted' } }],
        ),
      ),
    );
    await mount(<PlatformApp />);
    expect(document.body.textContent).toContain('已接受邀请，等待安排裁判岗位');
    expect(document.body.textContent).not.toContain('进入比赛');
    expect(document.body.textContent).not.toContain('确认本场文明');
  });
  it('旧比赛地址的访客返回统一登录页，不出现旧口令表单', async () => {
    history.replaceState({}, '', '/m/match-a/');
    const replace = vi.spyOn(location, 'replace').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(null)),
    );
    await mount(<MatchApp id="match-a" />);
    expect(replace).toHaveBeenCalledWith('/?audience=player');
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toContain('参赛口令');
  });
  it('比赛信息位于场内，账号操作放入我的页面，比赛中无赛后资料按钮', async () => {
    history.replaceState({}, '', '/player/me');
    const source = new MockSource(),
      snapshot = await source.read('/player/me');
    vi.spyOn(source, 'read').mockImplementation(async () => structuredClone(snapshot));
    await mount(<App source={source} matchContext={{ entry, audience: 'player' }} />);
    expect(document.querySelector('main .match-heading')?.textContent).toContain('秋季比赛');
    expect(document.querySelector('.match-context-banner')).toBeNull();
    expect(document.querySelector('main a[href="/matches?audience=player"]')?.textContent).toBe(
      '切换比赛',
    );
    expect(document.querySelector('a[href*="/history"]')).toBeNull();
  });
  it('裁判尚未填原因时保留禁用的预览按钮，填写后可预览', async () => {
    const source = new MockSource();
    source.reset('chief', 'active');
    await mount(
      <AppProvider source={source}>
        <ManagementForm title="测试管理操作" path="/judge/pause" />
      </AppProvider>,
    );
    const preview = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('预览操作影响'),
    )!;
    expect(preview.disabled).toBe(true);
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '核对现场情况',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(preview.disabled).toBe(false);
  });
});
