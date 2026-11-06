// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MatchEntry, PlatformSession } from '@darkforest/contracts';
import { MatchApp, PlatformApp } from '../../apps/web/src/platform';
import { App } from '../../apps/web/src/app';
import { MockSource } from '../../apps/web/src/dev/mock-source';
import { PlatformClient } from '../../apps/web/src/data/platform';

const session: PlatformSession = {
  account: {
    id: 'manager',
    kind: 'staff',
    name: '管理员',
    status: 'active',
    version: 1,
    auth_epoch: 1,
    tags: '',
  },
  roles: ['owner'],
  csrfToken: 'csrf',
  secondFactor: false,
};
const entry: MatchEntry = {
  id: 'feedback-match',
  name: '反馈测试比赛',
  kind: 'official',
  state: 'draft',
  version: 1,
  created_utc: 1,
  summary: '{}',
  synced_utc: null,
  recommended: 0,
  retention_days: 44,
  audit_days: 365,
};
let root: Root | undefined;
async function mount(node: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}
function button(text: string) {
  return [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;
}
function managementFetch(handle: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/session') return Response.json(session);
    if (url === '/api/me/matches' || url === '/api/platform/matches') return Response.json([entry]);
    if (url === `/api/matches/${entry.id}/manage`)
      return Response.json({
        match: entry,
        current: { members: [], assignments: [], phase: 'setup', players: 0 },
      });
    if (url === '/api/platform/accounts') return Response.json([]);
    return handle(url, init);
  });
}
const routes = ['/manage/matches/feedback-match', '/m/feedback-match/manage'];
async function mountManagement(route: string) {
  history.replaceState({}, '', route);
  await mount(route.startsWith('/m/') ? <MatchApp id={entry.id} /> : <PlatformApp />);
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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

describe('操作在当前页面反馈实际结果', () => {
  it.each(routes)('%s 确认交接后立即收起预览，完成或失败后均不能复用旧确认', async (route) => {
    let finish!: (value: Response) => void;
    let outcome: Promise<Response>;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/session') return Response.json(session);
      if (url === '/api/me/matches' || url === '/api/platform/matches')
        return Response.json([entry]);
      if (url === '/api/platform/accounts')
        return Response.json([{ ...session.account, id: 'next-judge', name: '接班裁判' }]);
      if (url === `/api/matches/${entry.id}/manage`)
        return Response.json({
          match: entry,
          current: {
            members: [{ account_id: 'next-judge', state: 'accepted' }],
            assignments: [],
            phase: 'setup',
            players: 0,
          },
        });
      if (url === '/api/platform/preview')
        return Response.json({ previewToken: 'handover-preview' });
      if (url.endsWith('/staff/assign')) {
        expect(JSON.parse(init!.body as string).preview_token).toBe('handover-preview');
        return Response.json({ operationId: 'handover-task', status: 'pending' });
      }
      if (url === '/api/me/operations/handover-task') return outcome;
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await mountManagement(route);
    const section = [...document.querySelectorAll('h2')].find(
      (heading) => heading.textContent === '裁判设置',
    )!.parentElement!;
    const judge = section.querySelector('select')!;
    const reason = section.querySelector('input')!;
    const setReason = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      judge.value = 'next-judge';
      judge.dispatchEvent(new Event('change', { bubbles: true }));
      setReason.call(reason, '现场换班');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (const status of ['succeeded', 'failed']) {
      outcome = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      await act(async () => button('预览影响').click());
      const confirm = button(`确认交接 ${entry.name}，J01`);
      expect(confirm).toBeDefined();
      await act(async () => {
        confirm.click();
        confirm.click();
      });
      expect(section.textContent).not.toContain('确认后旧任职结束');
      expect(button(`确认交接 ${entry.name}，J01`)).toBeUndefined();
      expect(button('预览影响').closest('fieldset')?.disabled).toBe(true);
      await act(async () =>
        finish(Response.json({ status, error: status === 'failed' ? '本场总裁判已变化。' : '' })),
      );
      expect(button(`确认交接 ${entry.name}，J01`)).toBeUndefined();
      expect(button('预览影响').closest('fieldset')?.disabled).toBe(false);
      expect(document.querySelector('.feedback-stack')?.textContent).toContain(
        status === 'succeeded' ? '操作已完成。' : '本场总裁判已变化。',
      );
    }
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/staff/assign'))).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/platform/preview')).toHaveLength(2);
  });

  it.each([
    ['failed', '本场总裁判已变化。', '本场总裁判已变化。'],
    ['partial', '还有一场比赛未处理。', '操作仅部分完成。还有一场比赛未处理。'],
    ['cancelled', '', '操作已取消，请核对后重试。'],
  ])('已有 %s 收据不能显示为已完成，也不重复查询或提交', async (status, error, message) => {
    const client = new PlatformClient('staff');
    client.session = session;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      client.completeOperation({ id: 'finished-task', status, error }, vi.fn()),
    ).rejects.toThrow(message);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('等待超时保留原任务并阻止新提交，恢复查询继续查询原任务', async () => {
    vi.useFakeTimers();
    const client = new PlatformClient('staff');
    client.session = session;
    const fetcher = vi.fn(async () => Response.json({ id: 'slow-task', status: 'pending' }));
    vi.stubGlobal('fetch', fetcher);
    const waiting = expect(client.waitOperation('slow-task')).rejects.toThrow(
      '操作仍在处理中，请查询原操作结果。',
    );
    await vi.runAllTimersAsync();
    await waiting;
    expect(client.pending()?.id).toBe('slow-task');
    await expect(client.mutate('/matches/feedback-match/publish', {})).rejects.toThrow(
      '请先查询上一次操作结果。',
    );
    fetcher.mockImplementation(async () => Response.json({ id: 'slow-task', status: 'succeeded' }));
    expect(await client.completeOperation(await client.resolvePending(), vi.fn())).toBe(true);
    expect(client.pending()).toBeNull();
    expect(fetcher.mock.calls).toHaveLength(61);
  });

  it.each(routes)('%s 发布失败显示后台原因，处理期间禁止重复提交', async (route) => {
    let finish!: (value: Response) => void;
    const task = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetcher = managementFetch(async (url) => {
      if (url.endsWith('/publish'))
        return Response.json({ operationId: 'publish-task', status: 'pending' }, { status: 202 });
      if (url === '/api/me/operations/publish-task') return task;
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await mountManagement(route);
    const publish = button('发布准备入口');
    await act(async () => {
      publish.click();
      publish.click();
    });
    expect(document.querySelector('.feedback-stack [role="status"]')?.textContent).toContain(
      '操作正在处理中',
    );
    expect(publish.closest('fieldset')?.disabled).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/publish'))).toHaveLength(1);
    await act(async () =>
      finish(
        Response.json({
          id: 'publish-task',
          status: 'failed',
          error: '发布准备入口前至少绑定两名玩家。',
        }),
      ),
    );
    const alert = document.querySelector('.feedback-stack [role="alert"]')!;
    expect(alert.textContent).toContain('发布准备入口前至少绑定两名玩家。');
    expect(alert.closest('.feedback-stack')?.parentElement).toBe(document.body);
    expect(document.body.textContent).not.toContain('操作已完成');
    expect(publish.closest('fieldset')?.disabled).toBe(false);
    expect(sessionStorage.getItem('darkforest.platform-pending.staff')).toBeNull();
  });

  it.each(routes)('%s 直接拒绝同样使用共用横幅显示原因', async (route) => {
    vi.stubGlobal(
      'fetch',
      managementFetch(async () =>
        Response.json({ message: '当前账号没有平台管理权限。', definitive: true }, { status: 403 }),
      ),
    );
    await mountManagement(route);
    await act(async () => button('发布准备入口').click());
    expect(document.querySelector('.feedback-stack [role="alert"]')?.textContent).toContain(
      '当前账号没有平台管理权限。',
    );
    expect(document.body.textContent).not.toContain('操作已完成');
  });

  it.each(routes)('%s 查询断连后保留原任务，恢复查询仍显示任务失败原因', async (route) => {
    let connected = false;
    let reads = 0;
    const fetcher = managementFetch(async (url) => {
      if (url.endsWith('/publish'))
        return Response.json({ operationId: 'original-task', status: 'pending' });
      if (url === '/api/me/operations/original-task') {
        reads++;
        if (!connected) throw new Error('Failed to fetch');
        return Response.json({
          id: 'original-task',
          status: 'failed',
          error: '需要先安排有效总裁判。',
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await mountManagement(route);
    await act(async () => button('发布准备入口').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('暂时无法查询操作结果');
    expect(JSON.parse(sessionStorage.getItem('darkforest.platform-pending.staff')!).id).toBe(
      'original-task',
    );
    connected = true;
    await act(async () => button('查询原操作结果').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      '需要先安排有效总裁判。',
    );
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/publish'))).toHaveLength(1);
    expect(reads).toBe(2);
    expect(sessionStorage.getItem('darkforest.platform-pending.staff')).toBeNull();
  });

  it.each(['player', 'staff'] as const)(
    '%s 接受邀请失败在本页显示原因并保留邀请操作',
    async (audience) => {
      history.replaceState({}, '', `/matches?audience=${audience}`);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url === '/api/auth/session')
            return Response.json({
              ...session,
              roles: [],
              account: { ...session.account, kind: audience },
            });
          if (url === '/api/me/matches')
            return Response.json([
              {
                ...entry,
                membership: {
                  account_id: 'manager',
                  kind: audience,
                  name: '本人',
                  state: 'invited',
                  epoch: 1,
                  assignment_id: null,
                  local_id: null,
                },
              },
            ]);
          if (url.endsWith('/members/accept')) return Response.json({ operationId: 'accept-task' });
          if (url === '/api/me/operations/accept-task')
            return Response.json({ status: 'failed', error: '本场邀请已撤销，请联系主办方。' });
          throw new Error(`Unexpected request ${url}`);
        }),
      );
      await mount(<PlatformApp />);
      await act(async () => button('接受邀请').click());
      expect(document.querySelector('.feedback-stack [role="alert"]')?.textContent).toContain(
        '本场邀请已撤销，请联系主办方。',
      );
      expect(button('接受邀请')?.disabled).toBe(false);
      expect(document.body.textContent).not.toContain('操作已完成');
    },
  );

  it.each(routes)('%s 成功收据到达后才显示完成并刷新页面状态', async (route) => {
    const fetcher = managementFetch(async (url) => {
      if (url.endsWith('/publish'))
        return Response.json({ operationId: 'success-task', status: 'pending' });
      if (url === '/api/me/operations/success-task') return Response.json({ status: 'succeeded' });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await mountManagement(route);
    const before = fetcher.mock.calls.filter(([url]) => url.endsWith('/manage')).length;
    await act(async () => button('发布准备入口').click());
    expect(document.querySelector('.feedback-stack [role="status"]')?.textContent).toContain(
      '操作已完成。',
    );
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/manage')).length).toBeGreaterThan(
      before,
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="关闭本次操作结果"]')!.click(),
    );
    expect(document.querySelector('.feedback-stack')).toBeNull();
  });

  it('原有场内失败横幅也使用同一个组件，并移到页面滚动容器之外', async () => {
    history.replaceState({}, '', '/player');
    const source = new MockSource();
    vi.spyOn(source, 'read').mockRejectedValue(new Error('比赛状态暂时无法读取。'));
    await mount(<App source={source} />);
    const alert = document.querySelector('.feedback-stack .error-feedback[role="alert"]')!;
    expect(alert.textContent).toContain('比赛状态暂时无法读取。');
    expect(alert.closest('.feedback-stack')?.parentElement).toBe(document.body);
    expect(document.querySelector('#main-content .global-feedback')).toBeNull();
  });
});
