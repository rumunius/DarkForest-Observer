// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpSource } from '../../apps/web/src/data/http';
import { PlatformClient } from '../../apps/web/src/data/platform';
import { accountCsv } from '../../apps/web/src/data/csv';
import { renderToStaticMarkup } from 'react-dom/server';
import { HumanData } from '../../apps/web/src/platform-copy';
import type { PlatformSession, Snapshot } from '@darkforest/contracts';
import { MockSource } from '../../apps/web/src/dev/mock-source';
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
describe('跨比赛前端请求与中文信息', () => {
  it('两个标签页数据源固定原场次；操作查询、分页与下载均不改目的地', async () => {
    const calls: { path: string; headers: Headers; body: unknown }[] = [];
    const base = await new MockSource().read('/player');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        calls.push({ path, headers: new Headers(init?.headers), body: init?.body });
        if (path.includes('/snapshot'))
          return Response.json({ ...base, session: { ...base.session, csrfToken: 'test-csrf' } });
        if (path.includes('/operations/')) return Response.json({ status: 'complete' });
        return Response.json({ fileName: 'test.json', text: '{}' });
      }),
    );
    const a = new HttpSource('match-A', 'staff'),
      b = new HttpSource('match-B', 'player');
    await a.read('/judge');
    await b.read('/player');
    await a.submit({
      path: '/judge/pause',
      requestId: 'origin-request',
      payload: { reason: '暂停核对' },
    });
    await b.result('B-request');
    await a.exportData('report');
    expect(calls.map((c) => c.path)).toEqual([
      '/api/matches/match-A/snapshot?route=%2Fjudge',
      '/api/matches/match-B/snapshot?route=%2Fplayer',
      '/api/matches/match-A/judge/pause',
      '/api/matches/match-B/operations/B-request',
      '/api/matches/match-A/judge/export?kind=report',
    ]);
    expect(calls[2]!.headers.get('X-Darkforest-Audience')).toBe('staff');
    expect(calls[2]!.headers.get('X-CSRF-Token')).toBe('test-csrf');
  });
  it('管理写入断连后保存原编号，查询并取消未接收请求后才允许新操作', async () => {
    const client = new PlatformClient('staff');
    client.session = { account: { id: 'long-account' }, csrfToken: 'csrf' } as PlatformSession;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test disconnect')));
    await expect(
      client.mutate('/platform/matches/create', { name: 'A', reason: '创建' }),
    ).rejects.toThrow('test disconnect');
    const pending = client.pending();
    expect(pending?.account).toBe('long-account');
    await expect(
      client.mutate('/platform/matches/create', { name: 'B', reason: '创建' }),
    ).rejects.toThrow('请先查询');
    const fetcher = vi.fn(async (path: string) =>
      Response.json({ status: path.endsWith('/resolve') ? 'cancelled' : 'unknown' }),
    );
    vi.stubGlobal('fetch', fetcher);
    await client.resolvePending();
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
      `/api/me/operations/${pending!.id}`,
      `/api/me/operations/${pending!.id}/resolve`,
    ]);
    expect(client.pending()).toBeNull();
  });
  it('高影响操作的预览不会自动提交，确认前不登记写请求', async () => {
    const client = new PlatformClient('staff');
    client.session = { account: { id: 'manager' }, csrfToken: 'csrf' } as PlatformSession;
    const fetcher = vi.fn(async (path: string) => {
      if (path === '/api/platform/preview')
        return Response.json({ previewToken: 'preview', warning: '会影响全部比赛' });
      throw new Error('预览不应提交停用');
    });
    vi.stubGlobal('fetch', fetcher);
    const preview = await client.mutate(
      '/platform/accounts/status',
      { accountId: 'target', status: 'disabled', expected_version: 2, reason: '核对影响' },
      true,
    );
    expect(preview.review.body).toMatchObject({ accountId: 'target', expected_version: 2 });
    expect(fetcher.mock.calls.map((row) => row[0])).toEqual(['/api/platform/preview']);
    expect(client.pending()).toBeNull();
  });
  it('CSV支持引号、逗号和换行，同名行保留独立记录，不计算公式', () => {
    const rows = accountCsv(
      'name,kind,accountId\r\n"张,三",player,\r\n"张,三",player,\r\n"=1+2",staff,explicit-id\r\n',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ name: '张,三', kind: 'player' });
    expect(rows[2]).toEqual({ name: '=1+2', kind: 'staff', accountId: 'explicit-id' });
    expect(() => accountCsv('name,kind,accountId\n"未闭合,player,')).toThrow('未闭合');
  });
  it('管理响应显示中文状态与阶段，未知内部字段不会进入普通页面', () => {
    const html = renderToStaticMarkup(
      <HumanData
        value={{
          status: 'pending',
          phase: 'forest',
          name: '测试比赛',
          body_hash: 'secret-hash',
          previewToken: 'secret-token',
        }}
      />,
    );
    expect(html).toContain('等待处理');
    expect(html).toContain('黑暗森林');
    expect(html).not.toContain('forest');
    expect(html).not.toContain('secret-hash');
    expect(html).not.toContain('secret-token');
  });
  it('晚到的A场响应保留A场标识，实例不会在B场请求后重新选路', async () => {
    const data = await new MockSource().read('/player');
    let resolveA!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        path.includes('/match-A/')
          ? new Promise<Response>((resolve) => {
              resolveA = resolve;
            })
          : Promise.resolve(Response.json({ ...data, match: { ...data.match, id: 'match-B' } })),
      ),
    );
    const a = new HttpSource('match-A'),
      b = new HttpSource('match-B'),
      waiting = a.read('/player');
    const resultB = await b.read('/player');
    resolveA(Response.json({ ...data, match: { ...data.match, id: 'match-A' } }));
    const resultA: Snapshot = await waiting;
    expect(resultB.match?.id).toBe('match-B');
    expect(resultA.match?.id).toBe('match-A');
    expect(a.matchId).toBe('match-A');
  });
});
