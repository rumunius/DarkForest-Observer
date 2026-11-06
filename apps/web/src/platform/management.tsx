import type {
  MatchEntry,
  MatchMember,
  PlatformAccount,
} from '@darkforest/contracts';
import {useEffect, useRef, useState} from 'react';
import type {PlatformClient} from '../data/platform';
import {HumanData, PHASE_NAMES} from '../platform_copy';
import {Button, ConfirmDialog, Feedback, Field, Icon} from '../ui';
import {AcceptInvitation} from './matches';
import type {Run} from './shared';
import {
  Header,
  Label,
  platformFeedbackMessages,
  states,
  useRows,
} from './shared';

const membershipStates: Record<MatchMember['state'], string> = {
  invited: '待接受',
  accepted: '已接受',
  bound: '已确认本场身份',
  revoked: '任职已结束',
};

/** 管理本场成员、裁判岗位和发布条件，变更前取得真实预览。 */
export function ManageMatch({
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
  const {data, error} = useRows<{
    match: MatchEntry;
    current: {
      members: MatchMember[];
      assignments: Array<{
        seat_id: string;
        epoch: number;
        ended_utc: number | null;
      }>;
      seatVersions?: Array<{id: string; version: number}>;
      phase: string;
      revision: number;
      players: number;
    };
  }>(client, `/matches/${id}/manage`, tick);
  const platformAdmin =
    client.session?.roles.some(r => ['owner', 'admin'].includes(r)) ?? false;
  const {data: accounts} = useRows<PlatformAccount[]>(
    client,
    platformAdmin ? '/platform/accounts' : `/matches/${id}/eligible`,
    tick,
  );
  const [inviteAccount, setInviteAccount] = useState('');
  const [judgeAccount, setJudgeAccount] = useState('');
  const [seat, setSeat] = useState('J01');
  const [reason, setReason] = useState('');
  const [removal, setRemoval] = useState<{
    member: MatchMember;
    revision: number;
  } | null>(null);
  const [preview, setPreview] = useState<{
    previewToken: string;
    payload: Record<string, unknown>;
    details: unknown;
  } | null>(null);
  if (!data) {
    return <p role="status">{error || '正在读取本场最新状态'}</p>;
  }
  const matchEntry = data.match;
  const epoch =
    data.current.seatVersions?.find(s => s.id === seat)?.version ??
    data.current.assignments.find(
      a => a.seat_id === seat && a.ended_utc === null,
    )?.epoch ??
    0;
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
      <Header title={matchEntry.name}>
        <Label>
          {matchEntry.kind === 'trial' ? '试玩' : '正式比赛'}，
          {states[matchEntry.state]}
        </Label>
      </Header>
      <p>
        本场正式名单 {data.current.players} 人。
        {PHASE_NAMES[data.current.phase] ?? '正在读取比赛阶段'}。
      </p>
      <div className="platform-row-actions">
        {data.current.members.find(
          m => m.account_id === client.session?.account.id,
        )?.state === 'invited' && (
          <AcceptInvitation
            client={client}
            id={id}
            run={run}
            accepted={false}
          />
        )}
        {matchEntry.state === 'available' &&
          data.current.members.some(
            m =>
              m.account_id === client.session?.account.id &&
              m.state === 'bound',
          ) && <a href={`/m/${id}/judge`}>进入本人裁判工作台</a>}
        {data.current.phase === 'ended' && (
          <a href={`/m/${id}/history?audience=staff`}>查看赛后资料</a>
        )}
        <a href={`/manage/matches/new?copy=${id}`}>以此设置再建一场</a>
      </div>
      <section className="platform-detail">
        <h2>邀请账号</h2>
        <Field label="从长期池选择">
          <select
            value={inviteAccount}
            onChange={e => setInviteAccount(e.target.value)}
          >
            <option value="">请选择</option>
            {accounts
              ?.filter(a => a.status !== 'disabled')
              .map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}，{a.kind === 'staff' ? '工作人员' : '玩家'}，
                  {a.id.slice(0, 8)}
                </option>
              ))}
          </select>
        </Field>
        {!platformAdmin && (
          <Field label="新成员长期账号编号">
            <input
              value={inviteAccount}
              onChange={e => setInviteAccount(e.target.value)}
            />
          </Field>
        )}
        <Button
          disabled={!inviteAccount}
          onClick={() =>
            void run(() =>
              client.mutate<unknown>(`/matches/${id}/members/invite`, {
                accountId: inviteAccount,
                reason: '邀请账号加入本场比赛',
              }),
            )
          }
        >
          邀请到本场
        </Button>
        <p>
          对方需用自己的账号接受邀请。玩家接受时自动确认本场文明；总裁判在场内选择正式名单。
        </p>
      </section>
      <section className="platform-detail">
        <h2>裁判设置</h2>
        <Field label="裁判账号">
          <select
            value={judgeAccount}
            onChange={e => {
              setJudgeAccount(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">请选择已接受邀请的工作人员</option>
            {accounts
              ?.filter(
                a =>
                  a.kind === 'staff' &&
                  a.status === 'active' &&
                  data.current.members.some(
                    m =>
                      m.account_id === a.id &&
                      (m.state === 'accepted' || m.state === 'bound'),
                  ),
              )
              .map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}，{a.id.slice(0, 8)}
                </option>
              ))}
          </select>
        </Field>
        <Field label="裁判岗位">
          <select
            value={seat}
            onChange={e => {
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
            onChange={e => {
              setReason(e.target.value);
              setPreview(null);
            }}
          />
        </Field>
        <Button
          disabled={!judgeAccount || !reason.trim()}
          onClick={() =>
            void run(async () => {
              const result = await client.request<{previewToken: string}>(
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
                void run(async () => {
                  setPreview(null);
                  return client.request<unknown>(
                    `/matches/${id}/staff/assign`,
                    {
                      ...preview.payload,
                      request_id: crypto.randomUUID(),
                      preview_token: preview.previewToken,
                    },
                  );
                })
              }
            >
              确认交接 {matchEntry.name}，{seat}
            </Button>
          </section>
        )}
      </section>
      <section className="platform-detail">
        <h2>本场成员</h2>
        {data.current.members.map(m => (
          <div key={m.account_id} className="platform-member-row">
            <p>
              <strong>{m.name}</strong>，{m.local_id ?? '尚未确认本场身份'}，
              {membershipStates[m.state]}
            </p>
            {matchEntry.state === 'draft' && (
              <button
                type="button"
                className="icon-button"
                aria-label={`移除成员 ${m.name}`}
                title={`移除成员 ${m.name}`}
                onClick={() =>
                  setRemoval({member: m, revision: data.current.revision})
                }
              >
                <Icon name="close" size={20} />
              </button>
            )}
          </div>
        ))}
      </section>
      {removal && matchEntry.state === 'draft' && (
        <ConfirmDialog
          title="移除本场成员？"
          confirmLabel="确认移除"
          onCancel={() => setRemoval(null)}
          onConfirm={() => {
            const {member, revision} = removal;
            setRemoval(null);
            void run(() =>
              client.mutate<unknown>(`/matches/${id}/members/remove`, {
                accountId: member.account_id,
                expectedRevision: revision,
                reason: '发布准备入口前移除本场成员',
              }),
            );
          }}
        >
          <p>
            将 <strong>{removal.member.name}</strong> 移出“{matchEntry.name}”。
          </p>
          <p className="secondary">
            {removal.member.local_id
              ? `本场身份 ${removal.member.local_id} 将释放，可重新分配。`
              : '本场邀请将撤销。'}{' '}
            长期账号和其他比赛不受影响，之后可重新邀请。
          </p>
        </ConfirmDialog>
      )}
      {matchEntry.state === 'draft' && (
        <Button
          onClick={() =>
            void run(() =>
              client.mutate<unknown>(`/matches/${id}/publish`, {
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

/** 加载本场平台管理会话与反馈，未确认结果不能作为成功继续。 */
export function MatchManagement({
  client,
  id,
}: {
  client: PlatformClient;
  id: string;
}) {
  const [tick, setTick] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    void client
      .load()
      .then(() => setReady(true))
      .catch((error: unknown) =>
        setError(
          error instanceof Error ? error.message : '暂时无法读取账号信息。',
        ),
      );
  }, [client]);
  const run: Run = async work => {
    if (running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('正在提交操作，请稍候。');
    try {
      const result = await work();
      await client.completeOperation(result, () =>
        setNotice('操作正在处理中，请稍候。'),
      );
      setNotice('操作已完成。');
    } catch (e) {
      setNotice('');
      setError(e instanceof Error ? e.message : '操作未完成，请查询原操作。');
    } finally {
      setTick(t => t + 1);
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <main className="platform-history">
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
      <fieldset
        className="platform-action-scope"
        disabled={busy}
        aria-busy={busy}
      >
        {ready ? (
          <>
            <Button onClick={() => setTick(t => t + 1)}>刷新本场成员</Button>
            <ManageMatch client={client} id={id} tick={tick} run={run} />
          </>
        ) : (
          <p>正在读取本场管理权限</p>
        )}
      </fieldset>
    </main>
  );
}
