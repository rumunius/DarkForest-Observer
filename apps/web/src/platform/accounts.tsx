import type {MatchEntry, PlatformAccount} from '@darkforest/contracts';
import {useState} from 'react';
import {accountCsv, readAccountCsv} from '../data/csv';
import type {PlatformClient} from '../data/platform';
import {saveDownload} from '../data/platform';
import {HumanData} from '../platform_copy';
import {Button, Field, Icon} from '../ui';
import type {Run} from './shared';
import {Header, accountStates, roles, useRows} from './shared';

/** 管理长期账号池、邀请及导入，与单场文明身份分开。 */
export function Accounts({
  client,
  tick,
  run,
}: {
  client: PlatformClient;
  tick: number;
  run: Run;
}) {
  const {data, error} = useRows<PlatformAccount[]>(
    client,
    '/platform/accounts',
    tick,
  );
  const [name, setName] = useState('');
  const [kind, setKind] = useState('player');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<PlatformAccount | null>(null);
  const [reason, setReason] = useState('');
  const [csv, setCsv] = useState('');
  const [report, setReport] = useState<unknown>(null);
  const [batch, setBatch] = useState(() => crypto.randomUUID());
  const rows = () => accountCsv(csv);
  return (
    <>
      <Header title="长期账号池" />
      <form
        className="form-stack platform-form"
        onSubmit={e => {
          e.preventDefault();
          void run(() =>
            client.mutate<unknown>('/platform/accounts/create', {
              name,
              kind,
              reason: '预注册长期账号',
            }),
          );
        }}
      >
        <Field label="显示名称">
          <input
            required
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={100}
          />
        </Field>
        <Field label="账号类别">
          <select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="player">玩家</option>
            <option value="staff">工作人员</option>
          </select>
        </Field>
        <Button type="submit" disabled={!name}>
          创建并发送邀请
        </Button>
      </form>
      <details>
        <summary>CSV批量导入（每批最多100行）</summary>
        <p>
          请按模板填写姓名、账号类别和账号编号。类别一列用 player 表示玩家，用
          staff 表示工作人员。新账号留空编号；更新已有账号时填写原编号。
        </p>
        <Button
          onClick={() =>
            saveDownload(
              '账号导入模板.csv',
              'name,kind,accountId\r\n示例玩家,player,\r\n',
            )
          }
        >
          下载模板
        </Button>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="选择账号CSV"
          onChange={event => {
            const file = event.target.files?.[0];
            setCsv('');
            setReport(null);
            if (!file) {
              return;
            }
            void run(async () => {
              setCsv(await readAccountCsv(file));
              setBatch(crypto.randomUUID());
            });
          }}
        />
        <Button
          disabled={!csv}
          onClick={() =>
            void run(async () => {
              const value = await client.mutate<unknown>(
                '/platform/accounts/import',
                {
                  rows: rows(),
                  batchId: batch,
                  preview: true,
                },
              );
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
                  client.mutate<unknown>('/platform/accounts/import', {
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
        <input value={search} onChange={e => setSearch(e.target.value)} />
      </Field>
      {error && <p role="alert">{error}</p>}
      <div className="platform-account-list">
        {data
          ?.filter(a => `${a.name} ${a.tags} ${a.id}`.includes(search))
          .map(account => (
            <button
              key={account.id}
              className="platform-account-row"
              onClick={() => setSelected(account)}
            >
              <span>
                <strong>{account.name}</strong>
                <small>
                  {account.kind === 'staff' ? '工作人员' : '玩家'}，
                  {accountStates[account.status]}
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
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </Field>
          <div className="platform-row-actions">
            <Button
              disabled={!reason}
              onClick={() =>
                void run(() =>
                  client.mutate(
                    `/platform/accounts/${selected.status === 'pending' ? 'invite' : 'reset'}`,
                    {
                      accountId: selected.id,
                      expected_version: selected.version,
                      reason,
                    },
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
                      status:
                        selected.status === 'disabled' ? 'active' : 'disabled',
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

/** 展示并调整平台任职，不能移除最后有效所有者或绕过当前版本。 */
export function RoleManager({
  client,
  tick,
  run,
}: {
  client: PlatformClient;
  tick: number;
  run: Run;
}) {
  const {data} = useRows<unknown>(client, '/platform/security', tick);
  const {data: accounts} = useRows<PlatformAccount[]>(
    client,
    '/platform/accounts',
    tick,
  );
  const {data: matches} = useRows<MatchEntry[]>(
    client,
    '/platform/matches',
    tick,
  );
  const [id, setId] = useState('');
  const [role, setRole] = useState('admin');
  const [scope, setScope] = useState('');
  const [reason, setReason] = useState('');
  const account = accounts?.find(a => a.id === id);
  return (
    <>
      <Header title="平台权限与所有权" />
      <Field label="已激活工作人员">
        <select value={id} onChange={e => setId(e.target.value)}>
          <option value="">请选择</option>
          {accounts
            ?.filter(a => a.kind === 'staff' && a.status === 'active')
            .map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="平台角色">
        <select value={role} onChange={e => setRole(e.target.value)}>
          {Object.entries(roles).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      {role === 'archivist' && (
        <Field label="允许管理哪场比赛的资料（30天有效）">
          <select value={scope} onChange={e => setScope(e.target.value)}>
            <option value="">请选择比赛</option>
            {matches?.map(m => (
              <option value={m.id} key={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="原因">
        <input value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
      <div className="platform-row-actions">
        {[true, false].map(enabled => (
          <Button
            key={String(enabled)}
            disabled={
              !account || !reason || (enabled && role === 'archivist' && !scope)
            }
            onClick={() =>
              void run(() =>
                client.mutate(
                  '/platform/roles/update',
                  {
                    accountId: id,
                    role,
                    enabled,
                    expected_version: account?.version,
                    reason,
                    ...(enabled && role === 'archivist'
                      ? {matchId: scope}
                      : {}),
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
