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
  it.each(['draft', 'available'] as const)(
    '成员移除只在发布前显示，并确认后提交与刷新（%s）',
    async (state) => {
      history.replaceState({}, '', '/m/match-a/manage');
      const members = [
        {
          ...entry.membership!,
          account_id: 'pending',
          name: '待接受玩家',
          state: 'invited',
          local_id: null,
        },
        {
          ...entry.membership!,
          account_id: 'accepted',
          name: '已接受工作人员',
          kind: 'staff',
          state: 'accepted',
          local_id: null,
        },
        {
          ...entry.membership!,
          account_id: 'bound',
          name: '已绑定玩家',
          state: 'bound',
          local_id: 'C02',
        },
      ];
      let removed = false;
      const fetcher = vi.fn<(...args: [string, RequestInit?]) => Promise<Response>>(async (url) => {
        if (url === '/api/auth/session') return Response.json({ ...session, roles: ['owner'] });
        if (url === '/api/me/matches') return Response.json([{ ...entry, state }]);
        if (url === '/api/platform/accounts') return Response.json([]);
        if (url.endsWith('/manage'))
          return Response.json({
            match: { ...entry, state },
            current: {
              members: removed ? members.slice(0, 2) : members,
              assignments: [],
              players: 0,
              phase: 'setup',
              revision: 7,
            },
          });
        if (url.endsWith('/members/remove')) {
          removed = true;
          return Response.json({ operationId: 'remove-op', status: 'pending' });
        }
        if (url === '/api/me/operations/remove-op')
          return Response.json({ id: 'remove-op', status: 'succeeded' });
        throw new Error(`Unexpected request ${url}`);
      });
      vi.stubGlobal('fetch', fetcher);
      const confirm = vi.fn();
      vi.stubGlobal('confirm', confirm);
      await mount(<MatchApp id="match-a" />);
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="移除成员"]'),
      ];
      expect(buttons).toHaveLength(state === 'draft' ? 3 : 0);
      if (state === 'available') return;
      buttons[2]!.focus();
      await act(async () => buttons[2]!.click());
      expect(document.querySelector('dialog')?.textContent).toContain('C02');
      expect(fetcher.mock.calls.some(([url]) => url.endsWith('/members/remove'))).toBe(false);
      const cancel = document.querySelector<HTMLButtonElement>('dialog button')!;
      await act(async () => cancel.click());
      expect(document.querySelector('dialog')).toBeNull();
      expect(document.activeElement).toBe(buttons[2]);
      await act(async () => buttons[2]!.click());
      await act(async () => {
        const event = new Event('cancel', { cancelable: true });
        document.querySelector('dialog')!.dispatchEvent(event);
      });
      expect(document.querySelector('dialog')).toBeNull();
      await act(async () => buttons[2]!.click());
      const submit = document.querySelector<HTMLButtonElement>('dialog button.danger')!;
      await act(async () => {
        submit.click();
        submit.click();
      });
      const requests = fetcher.mock.calls.filter(([url]) => url.endsWith('/members/remove'));
      expect(requests).toHaveLength(1);
      expect(confirm).not.toHaveBeenCalled();
      expect(JSON.parse(String(requests[0]![1]?.body))).toMatchObject({
        accountId: 'bound',
        expectedRevision: 7,
      });
      expect(document.querySelector('button[aria-label="移除成员 已绑定玩家"]')).toBeNull();
    },
  );
  it.each([false, true])('账号安全页无近期认证入口，已验证第二因素=%s', async (verified) => {
    history.replaceState({}, '', '/account');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/session')
          return Response.json({
            ...session,
            secondFactorEnabled: verified,
            secondFactor: verified,
          });
        if (url === '/api/me/sessions') return Response.json([]);
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    await mount(<PlatformApp />);
    expect(document.body.textContent).not.toContain('重新认证');
    expect(document.querySelector('input[type="password"]')).toBeNull();
    const control = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(verified ? '关闭第二因素验证' : '生成认证器密钥'),
    );
    expect(control).toBeDefined();
    expect(control!.disabled).toBe(false);
  });
  it('仅未验证第二因素的会话显示补充验证表单', async () => {
    history.replaceState({}, '', '/account');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/session')
          return Response.json({ ...session, secondFactorEnabled: true, secondFactor: false });
        if (url === '/api/me/sessions') return Response.json([]);
        throw new Error(`Unexpected request ${url}`);
      }),
    );
    await mount(<PlatformApp />);
    expect(document.body.textContent).toContain('验证第二因素');
    expect(document.body.textContent).not.toContain('有效10分钟');
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
    const disable = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('关闭第二因素验证'),
    );
    expect(disable!.disabled).toBe(true);
  });
  it('启用第二因素时可在设置区域输入验证码并确认', async () => {
    history.replaceState({}, '', '/account');
    let enabled = false;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/session')
        return Response.json({ ...session, secondFactorEnabled: enabled, secondFactor: enabled });
      if (url === '/api/me/sessions') return Response.json([]);
      if (url === '/api/me/security/setup') return Response.json({ secret: 'test-secret' });
      if (url === '/api/me/security/confirm') {
        expect(JSON.parse(String(init?.body))).toEqual({ code: '123456' });
        enabled = true;
        return Response.json({ recoveryCodes: ['test-recovery'] });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await mount(<PlatformApp />);
    const button = (label: string) =>
      [...document.querySelectorAll('button')].find((value) => value.textContent === label)!;
    await act(async () => button('生成认证器密钥').click());
    const input = document.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '123456',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('确认验证码').disabled).toBe(false);
    await act(async () => button('确认验证码').click());
    expect(document.body.textContent).toContain('test-recovery');
    expect(document.body.textContent).toContain('第二因素验证已启用');
    expect(button('关闭第二因素验证').disabled).toBe(false);
  });
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
  it.each([true, false])('邀请与裁判设置独立选择账号（平台管理员：%s）', async (admin) => {
    history.replaceState({}, '', '/m/match-a/manage');
    const accounts = [
      { id: 'player-a', kind: 'player', status: 'active' },
      { id: 'staff-a', kind: 'staff', status: 'active' },
      { id: 'staff-b', kind: 'staff', status: 'active' },
      { id: 'staff-invited', kind: 'staff', status: 'active' },
      { id: 'staff-disabled', kind: 'staff', status: 'disabled' },
    ].map((a) => ({ ...session.account, ...a, name: a.id }));
    const fetcher = vi.fn<(...args: [string, RequestInit?]) => Promise<Response>>(async (url) => {
      if (url === '/api/auth/session')
        return Response.json({
          ...session,
          account: { ...session.account, kind: 'staff' },
          roles: admin ? ['owner'] : [],
        });
      if (url === '/api/me/matches') return Response.json([entry]);
      if (url === '/api/matches/match-a/manage')
        return Response.json({
          match: entry,
          current: {
            players: 0,
            phase: 'setup',
            assignments: [],
            members: accounts.map((a) => ({
              ...entry.membership,
              account_id: a.id,
              name: a.name,
              kind: a.kind,
              state: a.id === 'staff-invited' ? 'invited' : 'accepted',
            })),
          },
        });
      if (url === (admin ? '/api/platform/accounts' : '/api/matches/match-a/eligible'))
        return Response.json(accounts);
      if (url.endsWith('/members/invite')) return Response.json({ operationId: 'invitation' });
      if (url.endsWith('/preview')) return Response.json({ previewToken: 'judge-preview' });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    await mount(<MatchApp id="match-a" />);
    const sections = [...document.querySelectorAll('section.platform-detail')];
    const invitation = sections.find((s) => s.querySelector('h2')?.textContent === '邀请账号')!;
    const judge = sections.find((s) => s.querySelector('h2')?.textContent === '裁判设置')!;
    expect(invitation.textContent).not.toContain('操作原因');
    expect(invitation.textContent).not.toContain('裁判设置');
    const inviteSelect = invitation.querySelector('select')!;
    const [judgeSelect, seatSelect] = [...judge.querySelectorAll('select')];
    const reason = judge.querySelector('input')!;
    const preview = [...judge.querySelectorAll('button')].find(
      (button) => button.textContent === '预览影响',
    )!;
    expect([...judgeSelect!.options].map((o) => o.value)).toEqual(['', 'staff-a', 'staff-b']);
    await act(async () => {
      inviteSelect.value = 'player-a';
      inviteSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const invite = invitation.querySelector('button')!;
    expect(invite.disabled).toBe(false);
    expect(judgeSelect!.value).toBe('');
    expect(preview.disabled).toBe(true);
    await act(async () => invite.click());
    const inviteRequest = fetcher.mock.calls.find(([url]) => url.endsWith('/members/invite'))!;
    expect(JSON.parse(String(inviteRequest[1]?.body))).toMatchObject({
      accountId: 'player-a',
      reason: '邀请账号加入本场比赛',
    });
    await act(async () => {
      judgeSelect!.value = 'staff-a';
      judgeSelect!.dispatchEvent(new Event('change', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        reason,
        '现场换班',
      );
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(inviteSelect.value).toBe('player-a');
    expect(preview.disabled).toBe(false);
    await act(async () => preview.click());
    const previewRequest = fetcher.mock.calls.find(([url]) => url.endsWith('/preview'))!;
    expect(JSON.parse(String(previewRequest[1]?.body))).toMatchObject({
      path: '/matches/match-a/staff/assign',
      payload: { accountId: 'staff-a', reason: '现场换班', seat: 'J01' },
    });
    await act(async () => {
      inviteSelect.value = 'staff-b';
      inviteSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(judgeSelect!.value).toBe('staff-a');
    expect(judge.textContent).toContain('确认交接');
    await act(async () => {
      seatSelect!.value = 'J02';
      seatSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(judge.textContent).not.toContain('确认交接');
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
