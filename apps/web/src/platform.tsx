import type {MatchEntry} from '@darkforest/contracts';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {App} from './app';
import {HttpSource} from './data/http';
import {PlatformClient, type PlatformReview} from './data/platform';
import {Accounts, RoleManager} from './platform/accounts';
import {Claim, Login} from './platform/auth';
import {DataCenter, History, Operations} from './platform/data_center';
import {ManageMatch, MatchManagement} from './platform/management';
import {Matches, NewMatch} from './platform/matches';
import {Security} from './platform/security';
import {Delivery, platformFeedbackMessages, roles} from './platform/shared';
import {HumanData} from './platform_copy';
import {Button, Feedback} from './ui';
import {requireError} from '@darkforest/contracts';

/** 协调长期会话、平台导航和持久操作反馈，单场玩法仍走独立入口。 */
export function PlatformApp() {
  const route = location.pathname;
  const requestedAudience = new URLSearchParams(location.search).get(
    'audience',
  );
  const [audience, setAudience] = useState<'player' | 'staff'>(
    route.startsWith('/manage') || requestedAudience === 'staff'
      ? 'staff'
      : requestedAudience !== 'player' &&
          sessionStorage.getItem('df.portal.audience') === 'staff'
        ? 'staff'
        : 'player',
  );
  const client = useMemo(() => new PlatformClient(audience), [audience]);
  useEffect(() => {
    sessionStorage.setItem('df.portal.audience', audience);
  }, [audience]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [delivery, setDelivery] = useState<Record<string, unknown> | null>(
    null,
  );
  const [review, setReview] = useState<PlatformReview | null>(null);
  const running = useRef(false);
  const refresh = useCallback(async () => {
    try {
      await client.load();
      setReady(true);
      setTick(t => t + 1);
    } catch (e) {
      setError(requireError(e).message);
      setReady(true);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!client.session) {
      return;
    }
    const timer = setInterval(() => setTick(t => t + 1), 5000);
    return () => clearInterval(timer);
  }, [client, ready]);
  const run = async (work: () => Promise<unknown>) => {
    if (running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('正在提交操作，请稍候。');
    try {
      const result = (await work()) as Record<string, unknown> | undefined;
      if (result?.review && result.previewToken) {
        setReview(result as PlatformReview);
        setNotice('');
        return;
      }
      if (result?.invitation || result?.credential) {
        setDelivery(result);
      }
      await client.completeOperation(result, () =>
        setNotice('操作正在处理中，请稍候。'),
      );
      setNotice('操作已完成。');
    } catch (e) {
      setNotice('');
      setError(requireError(e).message);
    } finally {
      setTick(t => t + 1);
      running.current = false;
      setBusy(false);
    }
  };
  const session = client.session;
  const manage = session?.roles.some(r => r === 'owner' || r === 'admin');
  const archive = session?.roles.some(r => r === 'owner' || r === 'archivist');
  return (
    <div className="platform-shell">
      <a className="skip-link" href="#platform-main">
        跳到主要内容
      </a>
      <aside className="platform-sidebar">
        <a className="platform-brand" href="/matches">
          黑暗森林<span>赛事与账号</span>
        </a>
        <nav aria-label="赛事中心导航">
          {session && (
            <>
              <a
                href="/matches"
                aria-current={route === '/matches' ? 'page' : undefined}
              >
                我的比赛
              </a>
              <a href="/account">账号与安全</a>
            </>
          )}
          {manage && (
            <>
              <a href="/manage">管理待办</a>
              <a href="/manage/accounts">账号池</a>
              <a href="/manage/matches/new">新建比赛</a>
            </>
          )}
          {archive && <a href="/manage/data">历史与数据</a>}
          {session?.roles.includes('owner') && (
            <a href="/manage/security">平台权限</a>
          )}
        </nav>
        <div className="platform-identity">
          {session ? (
            <>
              <strong>{session.account.name}</strong>
              <small>
                {audience === 'staff' ? '工作人员账号' : '玩家账号'}
                {session.roles.length
                  ? `，${session.roles.map(r => roles[r]).join('、')}`
                  : ''}
              </small>
              <button
                className="text-button"
                onClick={() =>
                  void run(async () => {
                    await client.request<unknown>('/auth/logout', {});
                    await refresh();
                  })
                }
              >
                退出当前设备
              </button>
            </>
          ) : (
            <small>请使用管理员交付的长期口令</small>
          )}
        </div>
      </aside>
      <main id="platform-main" className="platform-main">
        <Feedback
          messages={platformFeedbackMessages(
            client,
            run,
            error,
            notice,
            busy,
            () => {
              setError('');
              setNotice('');
            },
          )}
        />
        {review && (
          <section className="platform-detail">
            <h2>确认管理操作</h2>
            <HumanData value={review} />
            <HumanData value={review.review.body} />
            <div className="platform-row-actions">
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await client.request<unknown>(
                      review.review.path,
                      {
                        ...review.review.body,
                        request_id: crypto.randomUUID(),
                        preview_token: review.previewToken,
                      },
                    );
                    setReview(null);
                    return result;
                  })
                }
              >
                确认执行本次操作
              </Button>
              <Button disabled={busy} onClick={() => setReview(null)}>
                返回继续核对
              </Button>
            </div>
          </section>
        )}
        <fieldset
          className="platform-action-scope"
          disabled={busy}
          aria-busy={busy}
        >
          {!ready ? (
            <p role="status">正在连接赛事中心</p>
          ) : route === '/claim' ? (
            <Claim client={client} run={run} busy={busy} />
          ) : !session ? (
            <Login
              client={client}
              audience={audience}
              setAudience={v => {
                sessionStorage.setItem('df.portal.audience', v);
                setAudience(v);
              }}
              refresh={refresh}
              run={run}
              busy={busy}
            />
          ) : route === '/account' ? (
            <Security client={client} run={run} refresh={refresh} />
          ) : route === '/manage/accounts' && manage ? (
            <Accounts client={client} tick={tick} run={run} />
          ) : route === '/manage/matches/new' && manage ? (
            <NewMatch client={client} run={run} />
          ) : route.startsWith('/manage/matches/') && manage ? (
            <ManageMatch
              client={client}
              id={route.split('/')[3]!}
              tick={tick}
              run={run}
            />
          ) : route === '/manage/data' && archive ? (
            <DataCenter client={client} tick={tick} run={run} />
          ) : route === '/manage/security' &&
            session.roles.includes('owner') ? (
            <RoleManager client={client} tick={tick} run={run} />
          ) : route === '/manage' && manage ? (
            <Operations client={client} tick={tick} run={run} />
          ) : (
            <Matches client={client} tick={tick} run={run} manage={!!manage} />
          )}
        </fieldset>
        <Delivery value={delivery} />
      </main>
    </div>
  );
}

/** 验证本场可见目录后装配玩家、裁判或管理页面，保留待确认操作的离场限制。 */
export function MatchApp({id}: {id: string}) {
  const requestedAudience = new URLSearchParams(location.search).get(
    'audience',
  );
  const internal = location.pathname.slice(`/m/${id}`.length) || '/';
  const audience: 'staff' | 'player' =
    internal.startsWith('/judge') ||
    internal === '/manage' ||
    internal === '/display' ||
    requestedAudience === 'staff' ||
    requestedAudience === 'judge' ||
    (!internal.startsWith('/player') &&
      requestedAudience !== 'player' &&
      sessionStorage.getItem('df.portal.audience') === 'staff')
      ? 'staff'
      : 'player';
  const source = useMemo(() => new HttpSource(id, audience), [id, audience]);
  const client = useMemo(() => new PlatformClient(audience), [audience]);
  const [entry, setEntry] = useState<MatchEntry | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    sessionStorage.setItem('df.portal.audience', audience);
    let active = true;
    void (async () => {
      const session = await client.load();
      if (!active) {
        return;
      }
      if (!session) {
        location.replace(`/?audience=${audience}`);
        return;
      }
      const rows = await client.request<MatchEntry[]>('/me/matches');
      let current = rows.find(d => d.id === id);
      if (
        !current &&
        session.roles.some(role => role === 'owner' || role === 'admin')
      ) {
        current = (
          await client.request<MatchEntry[]>('/platform/matches')
        ).find(d => d.id === id);
      }
      if (!active) {
        return;
      }
      if (internal !== '/manage' && internal !== '/history') {
        if (
          current?.membership?.state !== 'bound' ||
          current.state !== 'available'
        ) {
          location.replace(`/matches?audience=${audience}`);
          return;
        }
        if (internal === '/' || internal === '/login') {
          location.replace(
            `/m/${id}/${audience === 'staff' ? 'judge' : 'player'}`,
          );
          return;
        }
      }
      if (!current) {
        throw new Error('当前账号不能查看这场比赛。请返回我的比赛选择场次。');
      }
      setEntry(current);
    })().catch(e => {
      if (active) {
        setError(requireError(e).message);
      }
    });
    return () => {
      active = false;
    };
  }, [client, id, audience, internal]);
  const leave = (event: React.MouseEvent) => {
    if (sessionStorage.getItem(`darkforest.pending-operation./m/${id}`)) {
      event.preventDefault();
      alert('请先在本场查询原操作结果，取得确定结论后再切换比赛。');
    }
  };
  if (!entry) {
    return (
      <main className="platform-history">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <a href={`/matches?audience=${audience}`}>返回我的比赛</a>
          </>
        ) : (
          <p role="status">正在读取比赛</p>
        )}
      </main>
    );
  }
  if (internal !== '/history' && internal !== '/manage') {
    return (
      <App source={source} base={`/m/${id}`} matchContext={{entry, audience}} />
    );
  }
  return (
    <div className="platform-shell">
      <aside className="platform-sidebar">
        <strong className="platform-brand">{entry.name}</strong>
        <nav aria-label="本场比赛导航">
          <a href={`/matches?audience=${audience}`} onClick={leave}>
            我的比赛
          </a>
          {entry.membership?.state === 'bound' &&
            entry.state === 'available' && (
              <a
                href={`/m/${id}/${audience === 'staff' ? 'judge' : 'player'}`}
                onClick={leave}
              >
                返回本场比赛
              </a>
            )}
          <a href={`/account?audience=${audience}`} onClick={leave}>
            账号与安全
          </a>
        </nav>
      </aside>
      <div className="platform-main">
        {internal === '/history' ? (
          <History client={client} id={id} />
        ) : (
          <MatchManagement client={client} id={id} />
        )}
      </div>
    </div>
  );
}
