import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  MatchEntry,
  MatchDownload,
  MatchHistory,
  MatchMember,
  PlatformAccount,
  PlatformOperation,
} from '@darkforest/contracts';
import { PlatformClient, saveDownload, type PlatformReview } from './data/platform';
import { Button, Feedback, Field, Icon, type FeedbackMessage } from './ui';
import { App } from './app';
import { HttpSource } from './data/http';
import { HumanData, OPERATION_NAMES, PHASE_NAMES } from './platform-copy';
import { accountCsv } from './data/csv';

const states: Record<string, string> = {
  draft: '草稿',
  provisioning: '创建中',
  available: '已发布',
  archiving: '归档中',
  archived: '已归档',
  purge_pending: '待清理',
  purged: '已清理',
  imported_archive: '导入档案',
  pending: '待执行',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '需处理',
  cancelled: '已取消',
  active: '已激活',
  disabled: '已停用',
};
const accountStates: Record<string, string> = {
  pending: '待领取',
  active: '已激活',
  disabled: '已停用',
};
const roles: Record<string, string> = {
  owner: '平台所有者',
  admin: '平台管理员',
  archivist: '资料管理员',
};
function Label({ children }: { children: ReactNode }) {
  return <span className="platform-label">{children}</span>;
}
function Header({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="platform-heading">
      <div>
        <p className="secondary">黑暗森林，赛事中心</p>
        <h1 tabIndex={-1}>{title}</h1>
      </div>
      {children}
    </header>
  );
}
function platformFeedbackMessages(
  client: PlatformClient,
  run: Run,
  error: string,
  notice: string,
  busy: boolean,
  clear: () => void,
): FeedbackMessage[] {
  const pending = client.session && client.pending();
  if (!error && !notice && !pending) return [];
  return [
    {
      tone: error ? 'error' : busy || pending ? 'pending' : 'result',
      ...(busy ? {} : { onClose: clear }),
      content: (
        <>
          <p>{error || notice || '正在确认上一次操作结果。取得处理结果后再提交新的操作。'}</p>
          {pending && !busy && (
            <Button onClick={() => void run(() => client.resolvePending())}>查询原操作结果</Button>
          )}
        </>
      ),
    },
  ];
}
function Delivery({ value }: { value: Record<string, unknown> | null }) {
  if (!value) return null;
  return (
    <section className="platform-delivery">
      <h2>本次交付</h2>
      <p>请单人复制或打印交付；长期口令只在领取时显示。邀请7天有效，交付原文24小时后清除。</p>
      {typeof value.invitation === 'string' && (
        <>
          <code className="credential-text">{`${location.origin}/claim#${value.invitation}`}</code>
          <Button
            onClick={() =>
              void navigator.clipboard.writeText(`${location.origin}/claim#${value.invitation}`)
            }
          >
            复制领取链接
          </Button>
        </>
      )}
      {typeof value.credential === 'string' && (
        <code className="credential-text">{value.credential}</code>
      )}
      <HumanData
        value={Object.fromEntries(
          Object.entries(value).filter(([k]) => !['invitation', 'credential'].includes(k)),
        )}
      />
    </section>
  );
}
export function PlatformApp() {
  const route = location.pathname;
  const requestedAudience = new URLSearchParams(location.search).get('audience');
  const [audience, setAudience] = useState<'player' | 'staff'>(
    route.startsWith('/manage') || requestedAudience === 'staff'
      ? 'staff'
      : requestedAudience !== 'player' && sessionStorage.getItem('df.portal.audience') === 'staff'
        ? 'staff'
        : 'player',
  );
  const client = useMemo(() => new PlatformClient(audience), [audience]);
  useEffect(() => {
    sessionStorage.setItem('df.portal.audience', audience);
  }, [audience]);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0),
    [delivery, setDelivery] = useState<Record<string, unknown> | null>(null),
    [review, setReview] = useState<PlatformReview | null>(null);
  const running = useRef(false);
  const refresh = useCallback(async () => {
    try {
      await client.load();
      setReady(true);
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败。');
      setReady(true);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!client.session) return;
    const timer = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(timer);
  }, [client, ready]);
  const run = async (work: () => Promise<unknown>) => {
    if (running.current) return;
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
      if (result?.invitation || result?.credential) setDelivery(result);
      await client.completeOperation(result, () => setNotice('操作正在处理中，请稍候。'));
      setNotice('操作已完成。');
    } catch (e) {
      setNotice('');
      setError(e instanceof Error ? e.message : '操作结果未知，请查询原操作。');
    } finally {
      setTick((t) => t + 1);
      running.current = false;
      setBusy(false);
    }
  };
  const session = client.session,
    manage = session?.roles.some((r) => r === 'owner' || r === 'admin'),
    archive = session?.roles.some((r) => r === 'owner' || r === 'archivist');
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
              <a href="/matches" aria-current={route === '/matches' ? 'page' : undefined}>
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
          {session?.roles.includes('owner') && <a href="/manage/security">平台权限</a>}
        </nav>
        <div className="platform-identity">
          {session ? (
            <>
              <strong>{session.account.name}</strong>
              <small>
                {audience === 'staff' ? '工作人员账号' : '玩家账号'}
                {session.roles.length ? `，${session.roles.map((r) => roles[r]).join('、')}` : ''}
              </small>
              <button
                className="text-button"
                onClick={() =>
                  void run(async () => {
                    await client.request('/auth/logout', {});
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
          messages={platformFeedbackMessages(client, run, error, notice, busy, () => {
            setError('');
            setNotice('');
          })}
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
                    const result = await client.request(review.review.path, {
                      ...review.review.body,
                      request_id: crypto.randomUUID(),
                      preview_token: review.previewToken,
                    });
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
        <fieldset className="platform-action-scope" disabled={busy} aria-busy={busy}>
          {!ready ? (
            <p role="status">正在连接赛事中心</p>
          ) : route === '/claim' ? (
            <Claim client={client} run={run} busy={busy} />
          ) : !session ? (
            <Login
              client={client}
              audience={audience}
              setAudience={(v) => {
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
            <ManageMatch client={client} id={route.split('/')[3]!} tick={tick} run={run} />
          ) : route === '/manage/data' && archive ? (
            <DataCenter client={client} tick={tick} run={run} />
          ) : route === '/manage/security' && session.roles.includes('owner') ? (
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
type Run = (work: () => Promise<unknown>) => Promise<void>;
function Login({
  client,
  audience,
  setAudience,
  refresh,
  run,
  busy,
}: {
  client: PlatformClient;
  audience: 'player' | 'staff';
  setAudience: (value: 'player' | 'staff') => void;
  refresh: () => Promise<void>;
  run: Run;
  busy: boolean;
}) {
  const [credential, setCredential] = useState(''),
    [code, setCode] = useState('');
  return (
    <>
      <Header title="进入赛事中心" />
      <p className="platform-intro">
        一个长期账号，查看属于你的每一场比赛。比赛内的文明编号与裁判岗位独立记录。
      </p>
      <form
        className="form-stack platform-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await client.login(credential, code);
            setCredential('');
            await refresh();
          });
        }}
      >
        <Field label="账号类别">
          <select
            value={audience}
            onChange={(e) => setAudience(e.target.value as 'staff' | 'player')}
          >
            <option value="player">玩家</option>
            <option value="staff">工作人员</option>
          </select>
        </Field>
        <Field label="长期口令">
          <input
            type="password"
            required
            autoComplete="current-password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
          />
        </Field>
        {audience === 'staff' && (
          <Field label="第二因素验证码或恢复码（已设置时填写）">
            <input
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        )}
        <Button type="submit" className="primary" disabled={busy || !credential}>
          {busy ? '正在登录' : '登录'}
        </Button>
      </form>
    </>
  );
}
function Claim({ client, run, busy }: { client: PlatformClient; run: Run; busy: boolean }) {
  const [invitation, setInvitation] = useState(() => location.hash.slice(1));
  useEffect(() => {
    history.replaceState(null, '', location.pathname);
  }, []);
  return (
    <>
      <Header title="领取长期账号" />
      <p>请确认这是工作人员单独交付给你的邀请。领取后立即保存生成的长期口令，再回到登录页。</p>
      <form
        className="form-stack platform-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const result = await client.request('/auth/claim', { invitation });
            setInvitation('');
            return result;
          });
        }}
      >
        <Field label="邀请令牌">
          <input
            type="password"
            required
            value={invitation}
            onChange={(e) => setInvitation(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Button type="submit" disabled={busy || !invitation}>
          领取并生成长期口令
        </Button>
      </form>
      <a href="/matches">返回登录</a>
    </>
  );
}
function useRows<T>(client: PlatformClient, path: string, tick: number) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void client
      .request<T>(path)
      .then((value) => {
        if (active) {
          setData(value);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : '读取失败。');
      });
    return () => {
      active = false;
    };
  }, [client, path, tick]);
  return { data, error };
}
function matchEnded(entry: MatchEntry) {
  if (entry.phase) return entry.phase === 'ended';
  try {
    return JSON.parse(entry.summary).phase === 'ended';
  } catch {
    return false;
  }
}
function AcceptInvitation({
  client,
  id,
  run,
  accepted,
}: {
  client: PlatformClient;
  id: string;
  run: Run;
  accepted: boolean;
}) {
  const [state, setState] = useState<'idle' | 'pending' | 'done'>('idle');
  if (state === 'done')
    return (
      <span role="status">
        {client.audience === 'player' ? '已加入比赛' : '已接受邀请，等待安排裁判岗位'}
      </span>
    );
  return (
    <Button
      disabled={state === 'pending'}
      onClick={() => {
        void run(async () => {
          setState('pending');
          try {
            const result = await client.mutate<{ operationId: string }>(
              `/matches/${id}/members/accept`,
              { consent: true, reason: '本人接受活动说明与数据保留期限，并加入本场比赛' },
            );
            await client.waitOperation(result.operationId);
            setState('done');
            return undefined;
          } catch (error) {
            setState('idle');
            throw error;
          }
        });
      }}
    >
      {state === 'pending' ? '正在加入比赛' : accepted ? '加入比赛' : '接受邀请'}
    </Button>
  );
}
function Matches({
  client,
  tick,
  run,
  manage,
}: {
  client: PlatformClient;
  tick: number;
  run: Run;
  manage: boolean;
}) {
  const { data, error } = useRows<MatchEntry[]>(
    client,
    manage ? '/platform/matches' : '/me/matches',
    tick,
  );
  const [filter, setFilter] = useState('all');
  return (
    <>
      <Header title={manage ? '赛事目录' : '我的比赛'}>
        {manage && (
          <a href="/manage/matches/new" className="text-link">
            新建比赛 <Icon name="arrow" size={18} />
          </a>
        )}
      </Header>
      <Field label="比赛类型">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">全部类型</option>
          <option value="official">正式比赛</option>
          <option value="trial">试玩</option>
        </select>
      </Field>
      {error && <p role="alert">{error}</p>}
      <div className="platform-match-list">
        {data
          ?.filter((d) => filter === 'all' || d.kind === filter)
          .map((d) => (
            <article key={d.id} className="platform-match-row">
              <div>
                <Label>{d.kind === 'trial' ? '试玩' : '正式比赛'}</Label>
                <span className="secondary">{states[d.state] ?? d.state}</span>
                <h2>{d.name}</h2>
                <small>
                  {new Date(d.created_utc).toLocaleDateString('zh-CN')}，完整复盘保留{' '}
                  {d.retention_days} 天
                </small>
                {d.synced_utc && (
                  <small>状态同步于 {new Date(d.synced_utc).toLocaleString('zh-CN')}</small>
                )}
              </div>
              <div className="platform-row-actions">
                {manage ? (
                  <a href={`/manage/matches/${d.id}`}>管理比赛</a>
                ) : (
                  <>
                    {d.membership?.state === 'bound' && d.state === 'available' && (
                      <a href={`/m/${d.id}/${client.audience === 'staff' ? 'judge' : 'player'}`}>
                        进入比赛
                      </a>
                    )}
                    {(d.membership?.state === 'invited' ||
                      (d.membership?.state === 'accepted' && client.audience === 'player')) && (
                      <>
                        <p className="secondary">接受邀请即确认本场活动说明与上述资料保留期限。</p>
                        <AcceptInvitation
                          key={`${d.id}:${d.membership.state}`}
                          client={client}
                          id={d.id}
                          run={run}
                          accepted={d.membership.state === 'accepted'}
                        />
                      </>
                    )}
                    {d.membership?.state === 'bound' && (
                      <span>
                        已加入本场，身份为 {d.membership.local_id}
                        {d.state === 'draft' ? '，等待发布比赛' : ''}
                      </span>
                    )}
                    {d.membership?.state === 'accepted' && client.audience === 'staff' && (
                      <span>已接受邀请，等待安排裁判岗位</span>
                    )}
                  </>
                )}
                {matchEnded(d) && (
                  <a href={`/m/${d.id}/history?audience=${client.audience}`}>赛后资料与版本</a>
                )}
              </div>
            </article>
          ))}
      </div>
      {data?.length === 0 && (
        <section className="platform-detail">暂无可访问比赛。请联系主办方取得本场邀请。</section>
      )}
    </>
  );
}
function NewMatch({ client, run }: { client: PlatformClient; run: Run }) {
  const [name, setName] = useState(''),
    [kind, setKind] = useState('official'),
    [description, setDescription] = useState(''),
    [days, setDays] = useState(44),
    [auditDays, setAuditDays] = useState(365),
    [confirmed, setConfirmed] = useState(false),
    [stage, setStage] = useState(0),
    [copyFrom, setCopyFrom] = useState(new URLSearchParams(location.search).get('copy') ?? '');
  const [created, setCreated] = useState<string | null>(null);
  const { data } = useRows<MatchEntry[]>(client, '/platform/matches', 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (stage === 0) {
      setStage(1);
      return;
    }
    void run(async () => {
      const result = await client.mutate<{ matchId: string }>('/platform/matches/create', {
        name,
        kind,
        description,
        retentionDays: days,
        auditDays,
        retentionConfirmed: confirmed,
        copyFrom: copyFrom || undefined,
        reason: '网站新建独立场次',
      });
      setCreated(result.matchId);
      return result;
    });
  };
  if (created)
    return (
      <>
        <Header title="比赛草稿已受理" />
        <section className="platform-detail">
          <p>{name}的创建任务已保存，离开页面后继续执行。</p>
          <a href={`/manage/matches/${created}`}>查看本场成员与裁判岗位</a>
        </section>
        <a href="/manage">查看创建任务处理结果</a>
      </>
    );
  return (
    <>
      <Header title="新建比赛" />
      <ol className="platform-steps">
        <li aria-current={stage === 0 ? 'step' : undefined}>填写基本信息与期限</li>
        <li aria-current={stage === 1 ? 'step' : undefined}>核对并创建草稿</li>
      </ol>
      <form className="form-stack platform-form" onSubmit={submit}>
        {stage === 0 ? (
          <>
            <Field label="比赛名称">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
              />
            </Field>
            <Field label="类型">
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setDays(e.target.value === 'trial' ? 14 : 44);
                }}
              >
                <option value="official">正式比赛</option>
                <option value="trial">试玩</option>
              </select>
            </Field>
            <Field label="活动说明来源">
              <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                <option value="">从空白开始</option>
                {data
                  ?.filter((d) => d.state !== 'imported_archive')
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}（活动说明、七色色值和比赛参数）
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="活动说明">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
              />
            </Field>
            <Field label="完赛后完整复盘保留天数">
              <input
                type="number"
                min={1}
                max={3650}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </Field>
            <Field label="战报与必要审计保留天数">
              <input
                type="number"
                min={days}
                max={3650}
                value={auditDays}
                onChange={(e) => setAuditDays(Number(e.target.value))}
              />
            </Field>
            <label className="check-label">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              确认主办方采用上述期限，并向参与者展示
            </label>
          </>
        ) : (
          <section className="platform-detail">
            <h2>{name}</h2>
            <p>
              {kind === 'trial' ? '试玩' : '正式比赛'}，完整复盘 {days} 天，战报与审计 {auditDays}{' '}
              天
            </p>
            <p>
              创建后进入草稿；在管理页面邀请玩家并任命总裁判，再发布准备入口。玩家接受邀请后自动获得本场文明，通讯与事件裁判可按需增设。复制时采用活动说明、七色色值和比赛参数。
            </p>
            <Button onClick={() => setStage(0)}>返回修改</Button>
          </section>
        )}
        <Button type="submit" className="primary" disabled={!name || !confirmed}>
          {stage === 0 ? '预览创建' : '确认创建独立草稿'}
        </Button>
      </form>
    </>
  );
}
function Accounts({ client, tick, run }: { client: PlatformClient; tick: number; run: Run }) {
  const { data, error } = useRows<PlatformAccount[]>(client, '/platform/accounts', tick),
    [name, setName] = useState(''),
    [kind, setKind] = useState('player'),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState<PlatformAccount | null>(null),
    [reason, setReason] = useState(''),
    [csv, setCsv] = useState(''),
    [report, setReport] = useState<unknown>(null),
    [batch, setBatch] = useState(() => crypto.randomUUID());
  const rows = () => accountCsv(csv);
  return (
    <>
      <Header title="长期账号池" />
      <form
        className="form-stack platform-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() =>
            client.mutate('/platform/accounts/create', { name, kind, reason: '预注册长期账号' }),
          );
        }}
      >
        <Field label="显示名称">
          <input required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
        <Field label="账号类别">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="player">玩家</option>
            <option value="staff">工作人员</option>
          </select>
        </Field>
        <Button type="submit" disabled={!name}>
          创建并交付邀请
        </Button>
      </form>
      <details>
        <summary>CSV批量导入（每批最多100行）</summary>
        <p>
          请按模板填写姓名、账号类别和账号编号。类别一列用 player 表示玩家，用 staff
          表示工作人员。新账号留空编号；更新已有账号时填写原编号。
        </p>
        <Button
          onClick={() =>
            saveDownload('账号导入模板.csv', 'name,kind,accountId\n示例玩家,player,\n')
          }
        >
          下载模板
        </Button>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="选择账号CSV"
          onChange={(e) =>
            void e.target.files?.[0]?.text().then((value) => {
              setCsv(value);
              setBatch(crypto.randomUUID());
              setReport(null);
            })
          }
        />
        <Button
          disabled={!csv}
          onClick={() =>
            void run(async () => {
              const value = await client.mutate('/platform/accounts/import', {
                rows: rows(),
                batchId: batch,
                preview: true,
              });
              setReport(value);
            })
          }
        >
          预览行级结果
        </Button>
        {report !== null && (
          <>
            <HumanData value={report} />
            <Button
              onClick={() =>
                void run(() =>
                  client.mutate('/platform/accounts/import', {
                    rows: rows(),
                    batchId: batch,
                    confirmMapping: true,
                    reason: '已核对CSV逐行明确ID映射',
                  }),
                )
              }
            >
              确认整批导入
            </Button>
          </>
        )}
      </details>
      <Field label="筛选账号">
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </Field>
      {error && <p role="alert">{error}</p>}
      <div className="platform-account-list">
        {data
          ?.filter((a) => `${a.name} ${a.tags} ${a.id}`.includes(search))
          .map((a) => (
            <button key={a.id} className="platform-account-row" onClick={() => setSelected(a)}>
              <span>
                <strong>{a.name}</strong>
                <small>
                  {a.kind === 'staff' ? '工作人员' : '玩家'}，{accountStates[a.status]}
                </small>
              </span>
              <Icon name="arrow" size={18} />
            </button>
          ))}
      </div>
      {selected && (
        <section className="platform-detail">
          <h2>{selected.name}</h2>
          <p>
            {selected.id}，版本 {selected.version}
          </p>
          <Field label="核验依据与操作原因">
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="platform-row-actions">
            <Button
              disabled={!reason}
              onClick={() =>
                void run(() =>
                  client.mutate(
                    `/platform/accounts/${selected.status === 'pending' ? 'invite' : 'reset'}`,
                    { accountId: selected.id, expected_version: selected.version, reason },
                    true,
                  ),
                )
              }
            >
              {selected.status === 'pending' ? '重新发送邀请' : '重置全局凭据'}
            </Button>
            <Button
              disabled={!reason}
              onClick={() =>
                void run(() =>
                  client.mutate(
                    '/platform/accounts/status',
                    {
                      accountId: selected.id,
                      status: selected.status === 'disabled' ? 'active' : 'disabled',
                      expected_version: selected.version,
                      reason,
                    },
                    true,
                  ),
                )
              }
            >
              {selected.status === 'disabled' ? '启用账号' : '全局停用'}
            </Button>
          </div>
          <p className="secondary">
            全局重置影响所有比赛。停用阻止访问和管理任务，赛事成绩与生存状态须另行处理。
          </p>
        </section>
      )}
    </>
  );
}
function ManageMatch({
  client,
  id,
  tick,
  run,
}: {
  client: PlatformClient;
  id: string;
  tick: number;
  run: Run;
}) {
  const { data, error } = useRows<{
    match: MatchEntry;
    current: {
      members: MatchMember[];
      assignments: { seat_id: string; epoch: number; ended_utc: number | null }[];
      phase: string;
      players: number;
    };
  }>(client, `/matches/${id}/manage`, tick);
  const platformAdmin = client.session?.roles.some((r) => ['owner', 'admin'].includes(r)) ?? false;
  const { data: accounts } = useRows<PlatformAccount[]>(
      client,
      platformAdmin ? '/platform/accounts' : `/matches/${id}/eligible`,
      tick,
    ),
    [inviteAccount, setInviteAccount] = useState(''),
    [judgeAccount, setJudgeAccount] = useState(''),
    [seat, setSeat] = useState('J01'),
    [reason, setReason] = useState(''),
    [preview, setPreview] = useState<{
      previewToken: string;
      payload: Record<string, unknown>;
      details: unknown;
    } | null>(null);
  if (!data) return <p role="status">{error || '正在读取本场最新状态'}</p>;
  const d = data.match,
    epoch =
      data.current.assignments.find((a) => a.seat_id === seat && a.ended_utc === null)?.epoch ?? 0;
  const assignment = {
    accountId: judgeAccount,
    seat,
    expectedVersion: epoch,
    reason,
    matchId: id,
    takeover: platformAdmin,
  };
  return (
    <>
      <Header title={d.name}>
        <Label>
          {d.kind === 'trial' ? '试玩' : '正式比赛'}，{states[d.state]}
        </Label>
      </Header>
      <p>
        本场正式名单 {data.current.players} 人。
        {PHASE_NAMES[data.current.phase] ?? '正在读取比赛阶段'}。
      </p>
      <div className="platform-row-actions">
        {data.current.members.find((m) => m.account_id === client.session?.account.id)?.state ===
          'invited' && <AcceptInvitation client={client} id={id} run={run} accepted={false} />}
        {d.state === 'available' &&
          data.current.members.some(
            (m) => m.account_id === client.session?.account.id && m.state === 'bound',
          ) && <a href={`/m/${id}/judge`}>进入本人裁判工作台</a>}
        {data.current.phase === 'ended' && (
          <a href={`/m/${id}/history?audience=staff`}>查看赛后资料</a>
        )}
        <a href={`/manage/matches/new?copy=${id}`}>以此设置再建一场</a>
      </div>
      <section className="platform-detail">
        <h2>邀请账号</h2>
        <Field label="从长期池选择">
          <select value={inviteAccount} onChange={(e) => setInviteAccount(e.target.value)}>
            <option value="">请选择</option>
            {accounts
              ?.filter((a) => a.status !== 'disabled')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}，{a.kind === 'staff' ? '工作人员' : '玩家'}，{a.id.slice(0, 8)}
                </option>
              ))}
          </select>
        </Field>
        {!platformAdmin && (
          <Field label="新成员长期账号编号">
            <input value={inviteAccount} onChange={(e) => setInviteAccount(e.target.value)} />
          </Field>
        )}
        <Button
          disabled={!inviteAccount}
          onClick={() =>
            void run(() =>
              client.mutate(`/matches/${id}/members/invite`, {
                accountId: inviteAccount,
                reason: '邀请账号加入本场比赛',
              }),
            )
          }
        >
          邀请到本场
        </Button>
        <p>对方需用自己的账号接受邀请。玩家接受时自动确认本场文明；总裁判在场内选择正式名单。</p>
      </section>
      <section className="platform-detail">
        <h2>裁判设置</h2>
        <Field label="裁判账号">
          <select
            value={judgeAccount}
            onChange={(e) => {
              setJudgeAccount(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">请选择已接受邀请的工作人员</option>
            {accounts
              ?.filter(
                (a) =>
                  a.kind === 'staff' &&
                  a.status === 'active' &&
                  data.current.members.some(
                    (m) => m.account_id === a.id && (m.state === 'accepted' || m.state === 'bound'),
                  ),
              )
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}，{a.id.slice(0, 8)}
                </option>
              ))}
          </select>
        </Field>
        <Field label="裁判岗位">
          <select
            value={seat}
            onChange={(e) => {
              setSeat(e.target.value);
              setPreview(null);
            }}
          >
            <option value="J01">J01 总裁判</option>
            <option value="J02">J02 通讯与母星</option>
            <option value="J03">J03 事件</option>
          </select>
        </Field>
        <Field label="操作原因">
          <input
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setPreview(null);
            }}
          />
        </Field>
        <Button
          disabled={!judgeAccount || !reason.trim()}
          onClick={() =>
            void run(async () => {
              const result = await client.request<{ previewToken: string }>(
                platformAdmin ? '/platform/preview' : `/matches/${id}/preview`,
                {
                  path: `/matches/${id}/staff/assign`,
                  payload: assignment,
                },
              );
              setPreview({
                previewToken: result.previewToken,
                payload: assignment,
                details: result,
              });
            })
          }
        >
          预览影响
        </Button>
        {preview && (
          <section className="platform-detail">
            <HumanData value={preview.details} />
            <p>确认后旧任职结束，旧预览失效；旧管理任务进入待核对。</p>
            <Button
              onClick={() =>
                void run(() =>
                  client.request(`/matches/${id}/staff/assign`, {
                    ...preview.payload,
                    request_id: crypto.randomUUID(),
                    preview_token: preview.previewToken,
                  }),
                )
              }
            >
              确认交接 {d.name}，{seat}
            </Button>
          </section>
        )}
      </section>
      <section className="platform-detail">
        <h2>本场成员</h2>
        {data.current.members.map((m) => (
          <p key={m.account_id}>
            <strong>{m.name}</strong>，{m.local_id ?? '尚未确认本场身份'}，
            {
              (
                {
                  invited: '待接受',
                  accepted: '已接受',
                  bound: '已确认本场身份',
                  revoked: '任职已结束',
                } as Record<string, string>
              )[m.state]
            }
          </p>
        ))}
      </section>
      {d.state === 'draft' && (
        <Button
          onClick={() =>
            void run(() =>
              client.mutate(`/matches/${id}/publish`, {
                reason: '已核对独立裁判岗位、玩家和保留期限',
              }),
            )
          }
        >
          发布准备入口
        </Button>
      )}
    </>
  );
}
function Operations({ client, tick, run }: { client: PlatformClient; tick: number; run: Run }) {
  const { data, error } = useRows<PlatformOperation[]>(client, '/platform/operations', tick);
  return (
    <>
      <Header title="管理待办" />
      <Button onClick={() => void run(async () => {})}>刷新任务</Button>
      {error && <p role="alert">{error}</p>}
      {data?.map((op) => (
        <article key={op.id} className="platform-match-row">
          <div>
            <Label>{states[op.status]}</Label>
            <h2>{OPERATION_NAMES[op.action] ?? '平台管理操作'}</h2>
            <small>{op.id}</small>
            <p>{op.error}</p>
            <details>
              <summary>各项处理结果与下一步</summary>
              <HumanData value={op} />
            </details>
          </div>
          {['failed', 'partial'].includes(op.status) && (
            <Button
              onClick={() =>
                void run(() =>
                  client.mutate(
                    '/platform/operations/retry',
                    { operationId: op.id, reason: '已核对失败步骤，按原编号继续' },
                    true,
                  ),
                )
              }
            >
              重试未完成步骤
            </Button>
          )}
        </article>
      ))}
      <Matches client={client} tick={tick} run={run} manage />
    </>
  );
}
function Security({
  client,
  run,
  refresh,
}: {
  client: PlatformClient;
  run: Run;
  refresh: () => Promise<void>;
}) {
  const [credential, setCredential] = useState(''),
    [code, setCode] = useState(''),
    [setup, setSetup] = useState<{ secret: string } | null>(null),
    [recovery, setRecovery] = useState<string[]>([]);
  const { data: sessions } = useRows<{ created_utc: number; expires: number; revoked: number }[]>(
    client,
    '/me/sessions',
    0,
  );
  return (
    <>
      <Header title="账号与安全" />
      <p>
        {client.session?.account.name}，{client.audience === 'staff' ? '工作人员' : '玩家'}
      </p>
      {client.session?.secondFactorEnabled && !client.session.secondFactor && (
        <form
          className="form-stack platform-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await client.request('/auth/reauth', { credential, code });
              setCredential('');
              setCode('');
              await refresh();
            });
          }}
        >
          <p>关闭第二因素验证前，请先在当前设备验证第二因素。</p>
          <Field label="长期口令">
            <input
              type="password"
              autoComplete="current-password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
            />
          </Field>
          <Field label="第二因素验证码或恢复码">
            <input
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!credential || !code}>
            验证第二因素
          </Button>
        </form>
      )}
      {!client.session?.secondFactorEnabled && (
        <section className="platform-detail">
          <h2>设置第二因素</h2>
          <p>
            你可以自愿启用第二因素验证。启用后，登录需要认证器验证码或恢复码，也可以在这里关闭。
          </p>
          <Button
            onClick={() =>
              void run(async () => {
                setSetup(await client.request('/me/security/setup', {}));
              })
            }
          >
            生成认证器密钥
          </Button>
          {setup && (
            <>
              <code className="credential-text">{setup.secret}</code>
              <Field label="认证器验证码">
                <input
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <Button
                disabled={!code}
                onClick={() =>
                  void run(async () => {
                    const result = await client.request<{ recoveryCodes: string[] }>(
                      '/me/security/confirm',
                      { code },
                    );
                    setRecovery(result.recoveryCodes);
                    setSetup(null);
                    await refresh();
                  })
                }
              >
                确认验证码
              </Button>
            </>
          )}
        </section>
      )}
      {client.session?.secondFactorEnabled && (
        <section className="platform-detail">
          <h2>第二因素验证已启用</h2>
          <Button
            disabled={!client.session.secondFactor}
            onClick={() =>
              void run(async () => {
                await client.request('/me/security/disable', {});
                setRecovery([]);
                await refresh();
              })
            }
          >
            关闭第二因素验证
          </Button>
        </section>
      )}
      {recovery.length > 0 && (
        <section className="platform-detail">
          <p>一次性恢复码，请安全保存，离页后不再显示。</p>
          <pre>{recovery.join('\n')}</pre>
        </section>
      )}
      <section className="platform-detail">
        <h2>设备会话</h2>
        {sessions?.map((s, i) => (
          <p key={i}>
            {new Date(s.created_utc).toLocaleString('zh-CN')}，
            {s.revoked ? '已撤销' : new Date(s.expires).toLocaleString('zh-CN') + ' 到期'}
          </p>
        ))}
        <Button
          onClick={() =>
            void run(async () => {
              await client.request('/me/sessions/revoke', {});
              await refresh();
            })
          }
        >
          退出全部设备
        </Button>
      </section>
    </>
  );
}
function DataCenter({ client, tick, run }: { client: PlatformClient; tick: number; run: Run }) {
  const { data: matches } = useRows<MatchEntry[]>(client, '/platform/matches', tick),
    { data } = useRows<{ holds: { match_id: string }[]; ledger: unknown[] }>(
      client,
      '/platform/data',
      tick,
    ),
    [selected, setSelected] = useState(''),
    [reason, setReason] = useState(''),
    [preview, setPreview] = useState<{
      path: string;
      body: Record<string, unknown>;
      token: string;
      details: unknown;
    } | null>(null);
  const d = matches?.find((m) => m.id === selected);
  const held = data?.holds.some((hold) => hold.match_id === selected);
  const planCleanup = async () => {
    const body = { matchId: selected, expected_version: d?.version, reason },
      path = '/platform/data/purge',
      result = await client.request<{ previewToken: string }>('/platform/preview', {
        path,
        payload: body,
      });
    setPreview({ path, body, token: result.previewToken, details: result });
  };
  return (
    <>
      <Header title="历史与数据" />
      <p>比赛结束后可下载赛后资料。请将需要留存的文件保存到主办方自己的设备或文件夹。</p>
      <Field label="选择比赛">
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setPreview(null);
          }}
        >
          <option value="">请选择</option>
          {matches?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}，{d.kind === 'trial' ? '试玩' : '正式比赛'}，{states[d.state]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="操作原因与核验依据">
        <textarea
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setPreview(null);
          }}
        />
      </Field>
      <div className="platform-row-actions">
        {d && <a href={`/m/${d.id}/history?audience=staff`}>查看与下载赛后资料</a>}
        <Button
          disabled={!d || !reason || !!held || d.state === 'purge_pending' || d.state === 'purged'}
          onClick={() => void run(planCleanup)}
        >
          预览到期清理
        </Button>
        <Button
          disabled={!d || !reason}
          onClick={() =>
            void run(() =>
              client.mutate(
                '/platform/data/hold',
                {
                  matchId: selected,
                  expected_version: d?.version,
                  reason,
                  ...(held ? { release: true } : { reviewUtc: Date.now() + 30 * 86400000 }),
                },
                true,
              ),
            )
          }
        >
          {held ? '解除申诉保留' : '因申诉暂缓清理'}
        </Button>
      </div>
      {preview && (
        <section className="platform-detail">
          <HumanData value={preview.details} />
          <Button
            onClick={() =>
              void run(() =>
                client.request(preview.path, {
                  ...preview.body,
                  request_id: crypto.randomUUID(),
                  preview_token: preview.token,
                }),
              )
            }
          >
            确认安排清理
          </Button>
        </section>
      )}
      <details>
        <summary>查看申诉保留和清理记录</summary>
        <HumanData value={data} />
      </details>
      <Operations client={client} tick={tick} run={run} />
    </>
  );
}
function RoleManager({ client, tick, run }: { client: PlatformClient; tick: number; run: Run }) {
  const { data } = useRows<unknown>(client, '/platform/security', tick),
    { data: accounts } = useRows<PlatformAccount[]>(client, '/platform/accounts', tick),
    { data: matches } = useRows<MatchEntry[]>(client, '/platform/matches', tick),
    [id, setId] = useState(''),
    [role, setRole] = useState('admin'),
    [scope, setScope] = useState(''),
    [reason, setReason] = useState('');
  const a = accounts?.find((a) => a.id === id);
  return (
    <>
      <Header title="平台权限与所有权" />
      <Field label="已激活工作人员">
        <select value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">请选择</option>
          {accounts
            ?.filter((a) => a.kind === 'staff' && a.status === 'active')
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="平台角色">
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {Object.entries(roles).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      {role === 'archivist' && (
        <Field label="允许管理哪场比赛的资料（30天有效）">
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">请选择比赛</option>
            {matches?.map((m) => (
              <option value={m.id} key={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="原因">
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="platform-row-actions">
        {[true, false].map((enabled) => (
          <Button
            key={String(enabled)}
            disabled={!a || !reason || (enabled && role === 'archivist' && !scope)}
            onClick={() =>
              void run(() =>
                client.mutate(
                  '/platform/roles/update',
                  {
                    accountId: id,
                    role,
                    enabled,
                    expected_version: a?.version,
                    reason,
                    ...(enabled && role === 'archivist' ? { matchId: scope } : {}),
                  },
                  true,
                ),
              )
            }
          >
            {enabled ? '授予角色' : '撤销角色'}
          </Button>
        ))}
      </div>
      <details>
        <summary>角色与审计</summary>
        <HumanData value={data} />
      </details>
    </>
  );
}
export function MatchApp({ id }: { id: string }) {
  const requestedAudience = new URLSearchParams(location.search).get('audience');
  const internal = location.pathname.slice(`/m/${id}`.length) || '/',
    audience: 'staff' | 'player' =
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
  const source = useMemo(() => new HttpSource(id, audience), [id, audience]),
    client = useMemo(() => new PlatformClient(audience), [audience]),
    [entry, setEntry] = useState<MatchEntry | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    sessionStorage.setItem('df.portal.audience', audience);
    let active = true;
    void (async () => {
      const session = await client.load();
      if (!active) return;
      if (!session) {
        location.replace(`/?audience=${audience}`);
        return;
      }
      const rows = await client.request<MatchEntry[]>('/me/matches');
      let current = rows.find((d) => d.id === id);
      if (!current && session.roles.some((role) => role === 'owner' || role === 'admin'))
        current = (await client.request<MatchEntry[]>('/platform/matches')).find(
          (d) => d.id === id,
        );
      if (!active) return;
      if (internal !== '/manage' && internal !== '/history') {
        if (current?.membership?.state !== 'bound' || current.state !== 'available') {
          location.replace(`/matches?audience=${audience}`);
          return;
        }
        if (internal === '/' || internal === '/login') {
          location.replace(`/m/${id}/${audience === 'staff' ? 'judge' : 'player'}`);
          return;
        }
      }
      if (!current) throw new Error('当前账号不能查看这场比赛。请返回我的比赛选择场次。');
      setEntry(current);
    })().catch((e) => {
      if (active) setError(e instanceof Error ? e.message : '暂时无法读取比赛，请刷新重试。');
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
  if (!entry)
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
  if (internal !== '/history' && internal !== '/manage')
    return <App source={source} base={`/m/${id}`} matchContext={{ entry, audience }} />;
  return (
    <div className="platform-shell">
      <aside className="platform-sidebar">
        <strong className="platform-brand">{entry.name}</strong>
        <nav aria-label="本场比赛导航">
          <a href={`/matches?audience=${audience}`} onClick={leave}>
            我的比赛
          </a>
          {entry.membership?.state === 'bound' && entry.state === 'available' && (
            <a href={`/m/${id}/${audience === 'staff' ? 'judge' : 'player'}`} onClick={leave}>
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
function MatchManagement({ client, id }: { client: PlatformClient; id: string }) {
  const [tick, setTick] = useState(0),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    void client
      .load()
      .then(() => setReady(true))
      .catch((e) => setError(e.message));
  }, [client]);
  const run: Run = async (work) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('正在提交操作，请稍候。');
    try {
      const result = await work();
      await client.completeOperation(result, () => setNotice('操作正在处理中，请稍候。'));
      setNotice('操作已完成。');
    } catch (e) {
      setNotice('');
      setError(e instanceof Error ? e.message : '操作未完成，请查询原操作。');
    } finally {
      setTick((t) => t + 1);
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <main className="platform-history">
      <Feedback
        messages={platformFeedbackMessages(client, run, error, notice, busy, () => {
          setError('');
          setNotice('');
        })}
      />
      <fieldset className="platform-action-scope" disabled={busy} aria-busy={busy}>
        {ready ? (
          <>
            <Button onClick={() => setTick((t) => t + 1)}>刷新本场成员</Button>
            <ManageMatch client={client} id={id} tick={tick} run={run} />
          </>
        ) : (
          <p>正在读取本场管理权限</p>
        )}
      </fieldset>
    </main>
  );
}
const downloadLabels: Record<MatchDownload, string> = {
  report: '下载战报',
  replay: '下载完整复盘',
  audit: '下载裁判操作记录',
  backup: '下载加密备份',
};

function History({ client, id }: { client: PlatformClient; id: string }) {
  const [history, setHistory] = useState<MatchHistory | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [record, setRecord] = useState<{ label: string; data: unknown } | null>(null);
  const path = `/matches/${id}/history`;
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then(() => client.request<MatchHistory>(path))
      .then((value) => {
        if (active) setHistory(value);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : '暂时无法读取赛后资料，请刷新重试。');
      });
    return () => {
      active = false;
    };
  }, [client, path]);
  async function run(work: () => Promise<unknown>) {
    setError('');
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error && e.name !== 'AbortError' ? e.message : '请求未完成，请稍后重试。',
      );
    } finally {
      setBusy(false);
    }
  }
  function view(label: string, subpath: string) {
    setRecord(null);
    return run(async () => setRecord({ label, data: await client.request(`${path}/${subpath}`) }));
  }
  function download(kind: MatchDownload, version?: number) {
    return run(async () => {
      const file = await client.request<{ fileName: string; text: string }>(
        `${path}/download/${kind}${version === undefined ? '' : `?version=${version}`}`,
      );
      saveDownload(file.fileName, file.text);
    });
  }
  return (
    <main className="platform-history">
      <Header title="赛后资料" />
      {error && (
        <p className="danger" role="alert">
          {error}
        </p>
      )}
      {!history && !error && <p role="status">正在读取赛后资料。</p>}
      {history && history.phase !== 'ended' && (
        <section className="platform-detail">比赛结束后可以在这里查看战报。</section>
      )}
      {history?.phase === 'ended' && history.versions.length === 0 && (
        <section className="platform-detail">目前没有可查看的战报。</section>
      )}
      {history?.versions.map((row) => (
        <article key={row.version} className="platform-match-row">
          <div>
            <h2>第{row.version}版战报</h2>
            <p>发布于 {new Date(row.created_utc).toLocaleString('zh-CN')}</p>
            {row.correction_reason && <p>更正原因：{row.correction_reason}</p>}
          </div>
          <div className="platform-row-actions">
            <Button
              disabled={busy}
              onClick={() => void view(`第${row.version}版战报`, `report?version=${row.version}`)}
            >
              查看战报
            </Button>
            {history.downloads.includes('report') && (
              <Button disabled={busy} onClick={() => void download('report', row.version)}>
                下载战报
              </Button>
            )}
          </div>
        </article>
      ))}
      {history?.replayAvailable && (
        <Button disabled={busy} onClick={() => void view('完整复盘', 'replay')}>
          查看完整复盘
        </Button>
      )}
      {history?.phase === 'ended' && history.versions.length > 0 && !history.replayAvailable && (
        <p>本场目前只提供战报，不再提供完整复盘。</p>
      )}
      {!!history?.downloads.length && (
        <section className="platform-detail">
          <h2>主办方留存资料</h2>
          <p>文件下载后由主办方自行保管。请把包含比赛秘密的资料放在仅授权人员可访问的位置。</p>
          <div className="platform-row-actions">
            {history.downloads
              .filter((kind) => kind !== 'report')
              .map((kind) => (
                <Button key={kind} disabled={busy} onClick={() => void download(kind)}>
                  {downloadLabels[kind]}
                </Button>
              ))}
          </div>
        </section>
      )}
      {record && (
        <section className="platform-detail">
          <h2>{record.label}</h2>
          <HumanData value={record.data} />
        </section>
      )}
    </main>
  );
}
