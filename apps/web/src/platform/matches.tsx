import type {MatchEntry} from '@darkforest/contracts';
import {useState, type FormEvent} from 'react';
import type {PlatformClient} from '../data/platform';
import {Button, Field, Icon} from '../ui';
import type {Run} from './shared';
import {Header, Label, matchEnded, states, useRows} from './shared';

/** 由本人确认参赛与保留期限后接受邀请并等待持久绑定结果。 */
export function AcceptInvitation({
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
  if (state === 'done') {
    return (
      <span role="status">
        {client.audience === 'player'
          ? '已加入比赛'
          : '已接受邀请，等待安排裁判岗位'}
      </span>
    );
  }
  return (
    <Button
      disabled={state === 'pending'}
      onClick={() => {
        void run(async () => {
          setState('pending');
          try {
            const result = await client.mutate<{operationId: string}>(
              `/matches/${id}/members/accept`,
              {
                consent: true,
                reason: '本人接受活动说明与数据保留期限，并加入本场比赛',
              },
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
      {state === 'pending'
        ? '正在加入比赛'
        : accepted
          ? '加入比赛'
          : '接受邀请'}
    </Button>
  );
}

/** 列出当前账号可发现的比赛，并按成员状态提供进入或接受邀请操作。 */
export function Matches({
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
  const {data, error} = useRows<MatchEntry[]>(
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
        <select value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">全部类型</option>
          <option value="official">正式比赛</option>
          <option value="trial">试玩</option>
        </select>
      </Field>
      {error && <p role="alert">{error}</p>}
      <div className="platform-match-list">
        {data
          ?.filter(d => filter === 'all' || d.kind === filter)
          .map(matchEntry => (
            <article key={matchEntry.id} className="platform-match-row">
              <div>
                <Label>
                  {matchEntry.kind === 'trial' ? '试玩' : '正式比赛'}
                </Label>
                <span className="secondary">
                  {states[matchEntry.state] ?? matchEntry.state}
                </span>
                <h2>{matchEntry.name}</h2>
                <small>
                  {new Date(matchEntry.created_utc).toLocaleDateString('zh-CN')}
                  ，完整复盘保留 {matchEntry.retention_days} 天
                </small>
                {matchEntry.synced_utc && (
                  <small>
                    更新于{' '}
                    {new Date(matchEntry.synced_utc).toLocaleString('zh-CN')}
                  </small>
                )}
              </div>
              <div className="platform-row-actions">
                {manage ? (
                  <a href={`/manage/matches/${matchEntry.id}`}>管理比赛</a>
                ) : (
                  <>
                    {matchEntry.membership?.state === 'bound' &&
                      matchEntry.state === 'available' && (
                        <a
                          href={`/m/${matchEntry.id}/${client.audience === 'staff' ? 'judge' : 'player'}`}
                        >
                          进入比赛
                        </a>
                      )}
                    {(matchEntry.membership?.state === 'invited' ||
                      (matchEntry.membership?.state === 'accepted' &&
                        client.audience === 'player')) && (
                      <>
                        <AcceptInvitation
                          key={`${matchEntry.id}:${matchEntry.membership.state}`}
                          client={client}
                          id={matchEntry.id}
                          run={run}
                          accepted={matchEntry.membership.state === 'accepted'}
                        />
                      </>
                    )}
                    {matchEntry.membership?.state === 'bound' && (
                      <span>
                        已加入本场，身份为 {matchEntry.membership.local_id}
                        {matchEntry.state === 'draft' ? '，等待发布比赛' : ''}
                      </span>
                    )}
                    {matchEntry.membership?.state === 'accepted' &&
                      client.audience === 'staff' && (
                        <span>已接受邀请，等待安排裁判岗位</span>
                      )}
                  </>
                )}
                {matchEnded(matchEntry) && (
                  <a
                    href={`/m/${matchEntry.id}/history?audience=${client.audience}`}
                  >
                    赛后资料与版本
                  </a>
                )}
              </div>
            </article>
          ))}
      </div>
      {data?.length === 0 && (
        <section className="platform-detail">
          暂无可访问比赛。请联系主办方取得本场邀请。
        </section>
      )}
    </>
  );
}

/** 创建独立正式场或试玩，先展示设置和保留期限再提交。 */
export function NewMatch({client, run}: {client: PlatformClient; run: Run}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('official');
  const [description, setDescription] = useState('');
  const [days, setDays] = useState(44);
  const [auditDays, setAuditDays] = useState(365);
  const [confirmed, setConfirmed] = useState(false);
  const [stage, setStage] = useState(0);
  const [copyFrom, setCopyFrom] = useState(
    new URLSearchParams(location.search).get('copy') ?? '',
  );
  const [created, setCreated] = useState<string | null>(null);
  const {data} = useRows<MatchEntry[]>(client, '/platform/matches', 0);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (stage === 0) {
      setStage(1);
      return;
    }
    void run(async () => {
      const result = await client.mutate<{matchId: string}>(
        '/platform/matches/create',
        {
          name,
          kind,
          description,
          retentionDays: days,
          auditDays,
          retentionConfirmed: confirmed,
          copyFrom: copyFrom || undefined,
          reason: '网站新建独立场次',
        },
      );
      setCreated(result.matchId);
      return result;
    });
  };
  if (created) {
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
  }
  return (
    <>
      <Header title="新建比赛" />
      <ol className="platform-steps">
        <li aria-current={stage === 0 ? 'step' : undefined}>
          填写基本信息与期限
        </li>
        <li aria-current={stage === 1 ? 'step' : undefined}>核对并创建草稿</li>
      </ol>
      <form className="form-stack platform-form" onSubmit={submit}>
        {stage === 0 ? (
          <>
            <Field label="比赛名称">
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                required
                maxLength={100}
              />
            </Field>
            <Field label="类型">
              <select
                value={kind}
                onChange={e => {
                  setKind(e.target.value);
                  setDays(e.target.value === 'trial' ? 14 : 44);
                }}
              >
                <option value="official">正式比赛</option>
                <option value="trial">试玩</option>
              </select>
            </Field>
            <Field label="活动说明来源">
              <select
                value={copyFrom}
                onChange={e => setCopyFrom(e.target.value)}
              >
                <option value="">从空白开始</option>
                {data
                  ?.filter(d => d.state !== 'imported_archive')
                  .map(d => (
                    <option key={d.id} value={d.id}>
                      {d.name}（活动说明、七色色值和比赛参数）
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="活动说明">
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                maxLength={2000}
              />
            </Field>
            <Field label="完赛后完整复盘保留天数">
              <input
                type="number"
                min={1}
                max={3650}
                value={days}
                onChange={e => setDays(Number(e.target.value))}
              />
            </Field>
            <Field label="战报与必要审计保留天数">
              <input
                type="number"
                min={days}
                max={3650}
                value={auditDays}
                onChange={e => setAuditDays(Number(e.target.value))}
              />
            </Field>
            <label className="check-label">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={e => setConfirmed(e.target.checked)}
              />
              确认主办方采用上述期限，并向参与者展示
            </label>
          </>
        ) : (
          <section className="platform-detail">
            <h2>{name}</h2>
            <p>
              {kind === 'trial' ? '试玩' : '正式比赛'}，完整复盘 {days}{' '}
              天，战报与审计 {auditDays} 天
            </p>
            <p>
              创建后进入草稿；在管理页面邀请玩家并任命总裁判，再发布准备入口。玩家接受邀请后自动获得本场文明，通讯与事件裁判可按需增设。复制时采用活动说明、七色色值和比赛参数。
            </p>
            <Button onClick={() => setStage(0)}>返回修改</Button>
          </section>
        )}
        <Button
          type="submit"
          className="primary"
          disabled={!name || !confirmed}
        >
          {stage === 0 ? '预览创建' : '确认创建独立草稿'}
        </Button>
      </form>
    </>
  );
}
