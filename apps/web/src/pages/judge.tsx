import { useState, type ReactNode } from 'react';
import {
  COLORS,
  FLIGHT_NAMES,
  STAGE_NAMES,
  type Civilization,
  type ManagementPreview,
  type SiteConfig,
} from '@darkforest/contracts';
import { DEFAULT_SITE } from '../config';
import { useApp } from '../state';
import { judgeCan } from '../permissions';
import {
  Button,
  CopyText,
  Disclosure,
  Empty,
  Events,
  Field,
  Frame,
  Icon,
  Identity,
  Link,
  MatchSummary,
  MiniArms,
  PageTitle,
  Status,
  Tabs,
  Timer,
  formatTime,
} from '../ui';
import { CivilizationDetail, CivilizationList, EventExplorer } from './observe';
import { ParametersSettings, RosterSettings } from './parameters';
import { AccountsManagement } from './accounts';
import { ReportCorrection } from './report-correction';
import { RecordPagination } from './record-pagination';
import { RecoveryTools } from './recovery';
import { ScheduledEvents } from './scheduled-events';

export const JUDGE_NAV = [
  {
    group: '赛事工作',
    items: [
      ['overview', '工作台', '/judge'],
      ['homeworlds', '母星审核', '/judge/homeworlds'],
      ['preflight', '开赛准备', '/judge/preflight'],
      ['notices', '通知待办', '/judge/notices'],
      ['endgame', '终局执裁', '/judge/endgame'],
    ],
  },
  {
    group: '状态与记录',
    items: [
      ['players', '文明管理', '/judge/players'],
      ['events', '赛事事件', '/judge/events'],
      ['attacks', '攻击复核', '/judge/attacks'],
      ['results', '比赛结果', '/judge/results'],
    ],
  },
  {
    group: '比赛管理',
    items: [
      ['clock', '比赛时间', '/judge/clock'],
      ['equipment', '手环处理', '/judge/equipment'],
      ['effects', '临时效果', '/judge/effects'],
      ['commands', '指令控制台', '/judge/commands'],
    ],
  },
  {
    group: '系统管理',
    items: [
      ['system', '系统状态', '/judge/system'],
      ['audit', '操作记录', '/judge/audit'],
      ['settings', '活动设置', '/judge/settings'],
      ['account', '裁判账号', '/judge/account'],
    ],
  },
];
export function ManagementForm({
  title,
  path,
  payload = {},
  children,
  change,
  ready = true,
  reasonRequired = true,
  current,
}: {
  title: string;
  path: string;
  payload?: Record<string, unknown>;
  children?: ReactNode;
  change?: string;
  ready?: boolean;
  reasonRequired?: boolean;
  current?: string;
}) {
  const { operate, busy, data } = useApp();
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ManagementPreview | null>(null);
  const [stamp, setStamp] = useState('');
  const fingerprint = JSON.stringify({ payload, reason });
  const usable = ready && (!reasonRequired || !!reason.trim());
  const currentPreview = preview && stamp === fingerprint ? preview : null;
  return (
    <div className="management-form">
      <h2>{title}</h2>
      {current && <p className="secondary">当前：{current}</p>}
      {children}
      {reasonRequired && (
        <Field label="操作原因">
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="填写本次操作的具体原因"
          />
        </Field>
      )}
      {usable && !currentPreview && (
        <Button
          disabled={busy}
          onClick={async () => {
            const r = await operate('/judge/manage/preview', {
              path,
              ...payload,
              reason,
              change: change ?? title,
              expected_revision: data.match!.revision,
            });
            if (r?.preview) {
              setPreview(r.preview);
              setStamp(fingerprint);
            }
          }}
        >
          预览操作影响
          <Icon name="arrow" size={18} />
        </Button>
      )}
      {currentPreview && (
        <Frame className="preview-result">
          <h3>确认本次影响</h3>
          {currentPreview.changes.map((c, i) => (
            <div key={i} className="change-row">
              <strong>{c.target}</strong>
              <span>{c.before}</span>
              <Icon name="arrow" size={16} />
              <span>{c.after}</span>
            </div>
          ))}
          {currentPreview.consequences.map((c) => (
            <p className="secondary" key={c}>
              {c}
            </p>
          ))}
          <Button
            className="primary full"
            disabled={busy}
            onClick={async () => {
              const r = await operate(path, {
                ...payload,
                reason,
                preview_token: currentPreview.token,
                expected_revision: currentPreview.revision,
              });
              if (r?.status === 'complete') setPreview(null);
            }}
          >
            确认执行：{title}
          </Button>
          <button className="text-button" onClick={() => setPreview(null)}>
            取消本次预览
          </button>
        </Frame>
      )}
    </div>
  );
}
function Dashboard() {
  const { data, base } = useApp();
  const judge = data.judge!;
  const match = data.match!;
  const cards = [
    { label: '正式参赛文明', value: match.total, to: '/judge/players', area: 'players' },
    { label: '存活文明', value: match.survivors, to: '/judge/players', area: 'players' },
    {
      label: '母星待审核',
      value: data.civilizations.filter((c) => c.flight === 'pending').length,
      to: '/judge/homeworlds',
      area: 'homeworlds',
    },
    {
      label: '待发送通知',
      value: judge.noticePendingCount ?? judge.notices.filter((n) => n.status !== 'sent').length,
      to: '/judge/notices',
      area: 'notices',
    },
  ];
  return (
    <>
      <PageTitle title="工作台" aside={<Status>{data.session!.name}</Status>} />
      {judge.scheduler.error && (
        <p role="alert" className="attention notice-block">
          {judge.scheduler.error} 请先暂停比赛，再到赛事事件页处理。
        </p>
      )}
      <div className="judge-status-heading">
        <MatchSummary />
        <div className="judge-quick">
          {judgeCan(data, 'clock') && (
            <Link className="text-link" to="/judge/clock">
              <Icon name="pause" size={18} />
              {match.paused ? '处理比赛暂停' : '暂停比赛'}
            </Link>
          )}
          <a className="text-link" href={`${base}/display`} target="_blank" rel="noreferrer">
            打开观战大屏
            <Icon name="arrow" size={18} />
          </a>
        </div>
      </div>
      <div className="dashboard-metrics">
        {cards
          .filter((c) => judgeCan(data, c.area))
          .map((c) => (
            <Link className="metric" key={c.label} to={c.to}>
              <span>{c.label}</span>
              <strong className="numeric">{c.value}</strong>
              <Icon name="arrow" size={18} />
            </Link>
          ))}
      </div>
      <div className="judge-columns">
        <section>
          <div className="section-title">
            <h2>需要处理</h2>
            <Link className="text-link" to="/judge/notices">
              查看待办
              <Icon name="arrow" size={16} />
            </Link>
          </div>
          {match.verification && judgeCan(data, 'endgame') && (
            <Link className="urgent-task" to="/judge/endgame">
              <Icon name="alert" />
              <div>
                <strong>终局资格核验中</strong>
                <p>有效比赛时间已冻结，请一次提交整批核验名单。</p>
              </div>
              <Icon name="arrow" size={18} />
            </Link>
          )}
          {(judge.noticeTasks ?? judge.notices)
            .filter((n) => n.status !== 'sent')
            .slice(0, 4)
            .map((n) => (
              <Link key={n.id} to={`/judge/notices?notice=${n.id}`} className="task-row">
                <span className="task-index">
                  <Icon name="message" size={20} />
                </span>
                <div>
                  <strong>{n.title}</strong>
                  <p>{n.target}</p>
                </div>
                <Status tone="attention">
                  {n.status === 'copied' ? '已复制，未发送' : '待发送'}
                </Status>
              </Link>
            ))}
          {judgeCan(data, 'equipment') && (
            <Link className="row-link" to="/judge/equipment">
              <span>
                剩余可发行配置 <strong className="numeric">{350 - judge.issuedCodes}</strong>组
              </span>
              <Icon name="arrow" size={18} />
            </Link>
          )}
          {judgeCan(data, 'system') && judge.scheduler.backlog > 0 && (
            <Link className="row-link attention" to="/judge/system">
              有{judge.scheduler.backlog}个到期事件尚未结算
              <Icon name="arrow" size={18} />
            </Link>
          )}
        </section>
        <section>
          <div className="section-title">
            <h2>最近赛事</h2>
            <Link className="text-link" to="/judge/events">
              全部事件
              <Icon name="arrow" size={16} />
            </Link>
          </div>
          <Events events={data.events.slice(0, 4)} />
        </section>
      </div>
    </>
  );
}
function HomeworldReview() {
  const { data, operate, busy } = useApp();
  const pending = data.civilizations.filter((c) => c.flight === 'pending');
  const [id, setId] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [returning, setReturning] = useState(false);
  const c = pending.find((c) => c.id === id) ?? pending[0];
  return (
    <>
      <PageTitle title="母星审核" />
      <p className="secondary">在QQ与高德地图软件中核对当前版本、照片及母星互不重复的要求。</p>
      {!c ? (
        <Empty title="当前没有待审核母星" to="/judge" action="返回工作台" />
      ) : (
        <div className="master-detail">
          <div className="master-list">
            {pending.map((item) => (
              <button
                className={item.id === c.id ? 'selected' : ''}
                key={item.id}
                onClick={() => {
                  setId(item.id);
                  setConfirm(false);
                  setReturning(false);
                  setReason('');
                }}
              >
                <Identity id={item.id} nickname={item.nickname} />
                <span className="numeric">{item.homeworld}</span>
                <small>第{item.homeVersion}次提交</small>
              </button>
            ))}
          </div>
          <Frame>
            <Identity id={c.id} nickname={c.nickname} />
            <p className="secret-code numeric">{c.homeworld}</p>
            <p>正在核对第{c.homeVersion}次提交的口令。</p>
            <label className="check-label large">
              <input
                type="checkbox"
                checked={confirm}
                onChange={(e) => setConfirm(e.target.checked)}
              />
              已核对QQ中的当前版本、照片与地点
            </label>
            {confirm && (
              <Button
                className="primary full"
                disabled={busy}
                onClick={() =>
                  void operate(`/judge/homeworld/${c.id}/verify`, {
                    expected_version: c.homeVersion,
                    expected_code: c.homeworld,
                    decision: 'approve',
                  })
                }
              >
                审核通过
                <Icon name="check" size={18} />
              </Button>
            )}
            <button className="text-button attention" onClick={() => setReturning(!returning)}>
              退回修改
            </button>
            {returning && (
              <>
                <Field label="具体退回原因">
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
                </Field>
                {reason.trim() && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void operate(`/judge/homeworld/${c.id}/verify`, {
                        expected_version: c.homeVersion,
                        expected_code: c.homeworld,
                        decision: 'reject',
                        reason,
                      })
                    }
                  >
                    确认退回修改
                  </Button>
                )}
              </>
            )}
          </Frame>
        </div>
      )}
    </>
  );
}
function PreflightManagement() {
  const { data } = useApp();
  const [time, setTime] = useState('');
  const [mode, setMode] = useState('release');
  const roster = data.civilizations;
  const ready =
    mode === 'release'
      ? roster.every((c) => ['staged', 'outfitting', 'ready'].includes(c.flight))
      : roster.every((c) => c.flight === 'ready');
  return (
    <>
      <PageTitle title="开赛准备" />
      <RosterSettings />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>文明</th>
              <th>母星登记</th>
              <th>当前准备状态</th>
              <th>已发行配置</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((c) => (
              <tr key={c.id}>
                <td>
                  <Identity id={c.id} nickname={c.nickname} />
                </td>
                <td>
                  {['pending', 'unregistered', 'rejected'].includes(c.flight)
                    ? '未审核通过'
                    : '已通过'}
                </td>
                <td>{FLIGHT_NAMES[c.flight]}</td>
                <td>
                  <MiniArms arms={c.arms} />
                </td>
                <td>
                  <Link to={`/judge/players/${c.id}`}>查看</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {judgeCan(data, 'clock') &&
        ['setup', 'outfitting', 'countdown'].includes(data.match!.stage) && (
          <>
            <Tabs
              tabs={[
                { id: 'release', label: '安排发码时间' },
                { id: 'start', label: '安排开赛时间' },
              ]}
              active={mode}
              onChange={setMode}
            />
            {!ready ? (
              <p className="notice-block">
                {mode === 'release'
                  ? '尚有正式玩家未完成准备，请先核对名单。'
                  : '尚有正式玩家未穿戴就绪，请先完成核对。'}
              </p>
            ) : (
              <ManagementForm
                title={mode === 'release' ? '安排发码' : '安排开赛'}
                path={mode === 'release' ? '/judge/arm-code-release' : '/judge/arm-start'}
                payload={{
                  time: new Date(time).getTime(),
                  expected_roster: roster.map((c) => c.id),
                }}
                ready={!!time && new Date(time).getTime() > Date.now()}
              >
                <Field label="未来的统一时间">
                  <input
                    type="datetime-local"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </Field>
                <p>本次正式名单共{roster.length}人。发码不等于正式开赛。</p>
              </ManagementForm>
            )}
          </>
        )}
    </>
  );
}
function Notices() {
  const { data, operate, busy } = useApp();
  const [channel, setChannel] = useState('private');
  const [filter, setFilter] = useState('todo');
  const [id, setId] = useState(new URLSearchParams(location.search).get('notice') ?? '');
  const [reason, setReason] = useState('');
  const [showError, setShowError] = useState(false);
  const queue = new Map(data.judge!.notices.map((n) => [n.id, n]));
  for (const task of data.judge!.noticeTasks ?? []) queue.set(task.id, task);
  const notices = [...queue.values()]
    .filter(
      (n) =>
        n.channel === channel &&
        (filter === 'todo' ? n.status !== 'sent' : filter === 'all' || n.status === filter),
    )
    .sort(
      (a, b) =>
        Number(a.status === 'sent') - Number(b.status === 'sent') ||
        (b.priority ?? 0) - (a.priority ?? 0) ||
        a.gameMs - b.gameMs,
    );
  const n = notices.find((n) => n.id === id) ?? notices[0];
  const statusNames = { pending: '待发送', copied: '已复制', sent: '已发送', error: '需要处理' };
  return (
    <>
      <PageTitle title="通知待办" />
      <p className="secondary">
        全场尚有
        {data.judge!.noticePendingCount ?? notices.filter((n) => n.status !== 'sent').length}
        条通知未发送；优先处理淘汰、失联和母星毁灭提醒。
      </p>
      <RecordPagination kind="notices" />
      <Tabs
        tabs={[
          { id: 'private', label: '玩家私聊' },
          { id: 'group', label: '群公告' },
        ]}
        active={channel}
        onChange={setChannel}
      />
      <Field label="处理状态">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="todo">全部未发送</option>
          <option value="all">全部通知</option>
          {Object.entries(statusNames).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      {!n ? (
        <p className="empty-inline">当前通知已全部处理。</p>
      ) : (
        <div className="master-detail">
          <div className="master-list">
            {notices.map((item) => (
              <button
                className={item.id === n.id ? 'selected' : ''}
                key={item.id}
                onClick={() => {
                  setId(item.id);
                  setShowError(false);
                }}
              >
                <strong>{item.title}</strong>
                <span>{item.target}</span>
                <small>
                  {statusNames[item.status]}，比赛时间{formatTime(item.gameMs)}
                </small>
              </button>
            ))}
          </div>
          <Frame>
            <div className="heading-row">
              <h2>{n.title}</h2>
              <Status tone={n.status !== 'sent' ? 'attention' : ''}>{statusNames[n.status]}</Status>
            </div>
            <p>收件人：{n.target}</p>
            <p className="secondary">
              最近处理人：{n.operator || '尚未处理'}，第{n.version}版
            </p>
            {n.copiedUtcMs && (
              <p className="secondary">
                复制：{n.copiedBy}，{new Date(n.copiedUtcMs).toLocaleString('zh-CN')}
              </p>
            )}
            {n.sentUtcMs && (
              <p className="secondary">
                发送：{n.sentBy}，{new Date(n.sentUtcMs).toLocaleString('zh-CN')}
              </p>
            )}
            {n.error && <p className="attention">发送异常：{n.error}</p>}
            <CopyText
              text={n.body}
              label="复制消息"
              onCopied={() => {
                if (n.status !== 'sent')
                  void operate(`/judge/notices/${n.id}/copied`, { expected_version: n.version });
              }}
            />
            {n.status !== 'sent' && (
              <>
                <p>在QQ实际发送后，再记录发送状态。</p>
                <Button
                  className="primary full"
                  disabled={busy}
                  onClick={() =>
                    void operate(`/judge/notices/${n.id}/sent`, { expected_version: n.version })
                  }
                >
                  标记已发送
                  <Icon name="check" size={18} />
                </Button>
                <button className="text-button" onClick={() => setShowError(!showError)}>
                  记录发送异常
                </button>
                {showError && (
                  <>
                    <Field label="异常原因">
                      <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
                    </Field>
                    {reason.trim() && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void operate(`/judge/notices/${n.id}/error`, {
                            expected_version: n.version,
                            reason,
                          })
                        }
                      >
                        保存发送异常
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
          </Frame>
        </div>
      )}
    </>
  );
}
function PlayerManagement({ c }: { c: Civilization }) {
  const { data } = useApp();
  const [operation, setOperation] = useState('nickname');
  const [value, setValue] = useState('');
  return (
    <>
      <CivilizationDetail civilization={c} back="/judge/players" title="文明管理详情" />
      {judgeCan(data, 'commands') && (
        <Disclosure title="裁判管理操作">
          <Field label="拟变更内容">
            <select value={operation} onChange={(e) => setOperation(e.target.value)}>
              <option value="nickname">更正文明昵称</option>
              <option value="photons">修正光粒库存</option>
              <option value="broadcasts">修正广播次数</option>
              <option value="restore">恢复参赛资格</option>
              <option value="eliminate">记录严重违规淘汰</option>
              <option value="absence">登记赛前缺席</option>
            </select>
          </Field>
          <ManagementForm
            title={
              operation === 'restore'
                ? '恢复参赛资格'
                : operation === 'eliminate'
                  ? '记录严重违规淘汰'
                  : operation === 'absence'
                    ? '登记赛前缺席'
                    : '修正文明确认信息'
            }
            path={
              operation === 'absence'
                ? `/judge/roster/${c.id}/withdraw`
                : operation === 'restore'
                  ? '/judge/player-restore'
                  : operation === 'eliminate'
                    ? '/judge/player-eliminate'
                    : '/judge/correction'
            }
            payload={
              ['restore', 'eliminate'].includes(operation)
                ? { target: c.id }
                : { target: c.id, field: operation, value }
            }
            ready={['restore', 'absence', 'eliminate'].includes(operation) || !!value.trim()}
            current={`${c.id}（${c.nickname}），${FLIGHT_NAMES[c.flight]}`}
          >
            {!['restore', 'absence', 'eliminate'].includes(operation) && (
              <Field label="拟变更值">
                <input value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            )}
            <p className="secondary">
              恢复资格前先暂停并核对人工淘汰记录。原出航文明将领取全新配置，核对佩戴后由裁判激活；已传播的情报保留审计说明。
            </p>
          </ManagementForm>
        </Disclosure>
      )}
    </>
  );
}
function EndgameManagement() {
  const { data } = useApp();
  const [selections, setSelections] = useState<Record<string, string>>({});
  const match = data.match!;
  const living = data.civilizations.filter((c) => c.flight !== 'eliminated');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('left_zone');
  return (
    <>
      <PageTitle title="终局执裁" />
      <MatchSummary />
      {match.verification ? (
        <>
          <p>
            请在QQ核对每个人截至98:00的共享与入圈资格。勾选只形成裁决草稿，最后一次提交整批名单。
          </p>
          <div className="endgame-roster">
            {living.map((c) => (
              <div className="endgame-row" key={c.id}>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={c.id in selections}
                    onChange={(e) =>
                      setSelections((previous) => {
                        const next = { ...previous };
                        if (e.target.checked) next[c.id] = 'no_share_at_cutoff';
                        else delete next[c.id];
                        return next;
                      })
                    }
                  />
                  <Identity id={c.id} nickname={c.nickname} />
                </label>
                {c.id in selections ? (
                  <select
                    aria-label={`${c.id}淘汰原因`}
                    value={selections[c.id]}
                    onChange={(e) => setSelections({ ...selections, [c.id]: e.target.value })}
                  >
                    <option value="no_share_at_cutoff">未按时加入位置共享</option>
                    <option value="outside_at_cutoff">截止时未进入终局圈</option>
                  </select>
                ) : (
                  <span className="secondary">本次保留</span>
                )}
              </div>
            ))}
          </div>
          <ManagementForm
            title="完成终局资格核验"
            path="/judge/hunt-finalize"
            payload={{
              eliminations: Object.entries(selections).map(([id, reason]) => ({ id, reason })),
            }}
            change={`批量淘汰${Object.keys(selections).length}人，预计保留${living.length - Object.keys(selections).length}人`}
          >
            <p className="notice-block">
              预计保留{living.length - Object.keys(selections).length}
              名文明。至少2人时开始最后狩猎；仅余1人或无人存活时直接完赛。允许提交空淘汰名单。
            </p>
          </ManagementForm>
        </>
      ) : match.stage === 'hunt' ? (
        <>
          <h2>终局持续执裁</h2>
          <Field label="需要处理的文明">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">选择文明</option>
              {living.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id}（{c.nickname}）
                </option>
              ))}
            </select>
          </Field>
          <ManagementForm
            title="确认终局淘汰"
            path="/judge/hunt-eliminate"
            payload={{ target, reason_code: reason }}
            ready={!!target}
          >
            <Field label="裁决原因">
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="left_zone">离开终局圈</option>
                <option value="sharing_stopped">停止位置共享</option>
                <option value="location_violation">定位违规</option>
              </select>
            </Field>
          </ManagementForm>
        </>
      ) : (
        <Empty title="终局执裁尚未开始" to="/judge">
          90分钟起核对存活文明，98分钟进入统一资格核验。
        </Empty>
      )}
    </>
  );
}
function ClockManagement() {
  const { data } = useApp();
  const match = data.match!;
  return (
    <>
      <PageTitle title="比赛时间" />
      <MatchSummary />
      <p className="secondary">
        当前真实时间：
        {new Date(match.serverUtcMs).toLocaleString('zh-CN', { timeZone: data.site.timezone })}
      </p>
      <p>全场暂停冻结有效比赛时间和重生期限。个人禁止目击攻击、淘汰后观战等待仍按真实时间继续。</p>
      {match.verification ? (
        <Frame>
          <h2>请先完成终局资格核验</h2>
          <p>核验暂停不能用普通恢复操作结束。</p>
          <Link className="text-link" to="/judge/endgame">
            前往终局执裁
            <Icon name="arrow" size={18} />
          </Link>
        </Frame>
      ) : match.stage === 'ended' ? (
        <p>比赛已经结束。</p>
      ) : (
        <ManagementForm
          title={match.paused ? '恢复比赛' : '暂停比赛'}
          path={match.paused ? '/judge/resume' : '/judge/pause'}
          current={`${STAGE_NAMES[match.stage]}，${match.paused ? '已暂停' : '计时中'}`}
          change={
            match.paused
              ? '恢复有效比赛时间，重新核验所有行动权限'
              : '冻结有效比赛时间和重生期限，暂停普通战局操作'
          }
        />
      )}
      <h2>计时操作记录</h2>
      <AuditEntries />
    </>
  );
}
function AuditEntries() {
  const { data } = useApp();
  const [search, setSearch] = useState('');
  return (
    <div className="audit-list">
      <Field label="检索操作记录">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="操作者、文明、动作或原因"
        />
      </Field>
      <RecordPagination kind="audits" />
      {data
        .judge!.audits.filter((a) =>
          `${a.title} ${a.operator} ${a.target ?? ''} ${a.reason}`.includes(search),
        )
        .map((a) => (
          <Disclosure key={a.id} title={`${a.title}，${formatTime(a.gameMs)}`}>
            <p>操作者：{a.operator}</p>
            <p>原因：{a.reason}</p>
            {a.target && (
              <p>
                对象：{a.target}；
                {a.status === 'previewed'
                  ? '操作预览'
                  : a.status === 'failed'
                    ? '执行失败'
                    : '执行记录'}
              </p>
            )}
            {a.utcMs && (
              <p className="secondary">记录时间：{new Date(a.utcMs).toLocaleString('zh-CN')}</p>
            )}
            <div className="change-row">
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{a.before}</pre>
              <Icon name="arrow" size={18} />
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{a.after}</pre>
            </div>
            <p className="muted">记录编号：{a.id}</p>
          </Disclosure>
        ))}
    </div>
  );
}
function Effects() {
  const { data } = useApp();
  const [target, setTarget] = useState('@a');
  const [seconds, setSeconds] = useState('60');
  return (
    <>
      <PageTitle title="临时效果" />
      <p>临时禁止目击攻击不冻结比赛时间，也不解除其他阶段限制或个人错误提交处罚。</p>
      {data.judge!.effects.map((e) => (
        <Frame key={e.id}>
          <div className="heading-row">
            <h2>{e.target}</h2>
            <Status>{e.active ? '正在生效' : '已结束'}</Status>
          </div>
          <p>{e.reason}</p>
          <p className="secondary">操作者：{e.operator}</p>
          {e.active && (
            <>
              <Timer label="效果剩余真实时间" deadline={e.untilUtcMs} clock="utc" />
              <ManagementForm
                title="撤销本条效果"
                path="/judge/effects"
                payload={{ revoke: e.id }}
                change="仅撤销这条效果，其他限制仍按各自规则生效"
              />
            </>
          )}
        </Frame>
      ))}
      <ManagementForm
        title="建立临时禁止目击攻击"
        path="/judge/effects"
        payload={{ target, seconds: Number(seconds) }}
        ready={!!target && Number(seconds) > 0}
      >
        <Field label="目标范围">
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="@a">全场正式参赛者</option>
            {data.civilizations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}（{c.nickname}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="持续秒数，按真实时间">
          <input
            type="number"
            min={1}
            max={3600}
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
          />
        </Field>
      </ManagementForm>
    </>
  );
}
function AttackReview() {
  const { data } = useApp();
  const [id, setId] = useState('C07');
  const [selectedAttack, setSelectedAttack] = useState('');
  const c = data.civilizations.find((c) => c.id === id);
  const attacks = data.judge?.attacks?.filter((a) => a.actor === id) ?? [];
  const attack = attacks.find((a) => a.id === selectedAttack) ?? attacks[0];
  return (
    <>
      <PageTitle title="攻击复核" />
      <RecordPagination kind="attacks" />
      <Field label="选择文明">
        <select value={id} onChange={(e) => setId(e.target.value)}>
          {data.civilizations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}（{c.nickname}）
            </option>
          ))}
        </select>
      </Field>
      {c && (
        <>
          <div className="stat-lines">
            <div>
              <span>提交错误目击码的次数</span>
              <strong>{c.wrongCount}</strong>
            </div>
            <div>
              <span>当前飞船状态</span>
              <strong>{FLIGHT_NAMES[c.flight]}</strong>
            </div>
          </div>
          <Events
            events={data.events.filter(
              (e) => e.kind === 'sighting' && e.civilizationIds.includes(id),
            )}
          />
          {judgeCan(data, 'commands') && attack && (
            <>
              <Field label="需要更正的攻击">
                <select
                  value={attack.id}
                  onChange={(event) => setSelectedAttack(event.target.value)}
                >
                  {attacks.map((a) => (
                    <option value={a.id} key={a.id}>
                      {new Date(a.utcMs).toLocaleTimeString('zh-CN', {
                        timeZone: data.site.timezone,
                      })}
                      ，{a.target ? `击毁${a.target}` : '未产生击毁'}
                      {a.valid ? '' : '，已更正'}
                    </option>
                  ))}
                </select>
              </Field>
              {attack.roll !== null && <p>第二次错误提交的抽签值：{attack.roll}</p>}
              <ManagementForm
                title="有技术证据的攻击纠错"
                path="/judge/attack-correction"
                payload={{ attack_id: attack.id }}
                ready={attack.valid}
                change="复核原攻击、关联航次、战绩、淘汰、排名、观战与通知，不重抽既定随机结果"
              >
                <p className="notice-block">
                  仅在有充分技术故障证据时执行。原记录保留，已发生的情报传播写入审计说明。
                </p>
              </ManagementForm>
            </>
          )}
        </>
      )}
    </>
  );
}
function Equipment() {
  const { data } = useApp();
  const [id, setId] = useState('C07');
  const [mode, setMode] = useState('replace');
  const c = data.civilizations.find((c) => c.id === id);
  return (
    <>
      <PageTitle title="手环处理" />
      <div className="dashboard-metrics">
        <div className="metric">
          <span>已发行配置</span>
          <strong className="numeric">{data.judge!.issuedCodes}</strong>
        </div>
        <div className="metric">
          <span>尚可发行配置</span>
          <strong className="numeric">{350 - data.judge!.issuedCodes}</strong>
        </div>
      </div>
      <p>所有已发行配置在本场永久占用，历史配置不复用。</p>
      <Field label="需要处理的文明">
        <select value={id} onChange={(e) => setId(e.target.value)}>
          {data.civilizations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}（{c.nickname}）
            </option>
          ))}
        </select>
      </Field>
      {c?.arms && (
        <>
          <h2>当前有效配置</h2>
          <MiniArms arms={c.arms} />
        </>
      )}
      <Tabs
        tabs={[
          { id: 'replace', label: '同色同款替换' },
          ...(judgeCan(data, 'commands') ? [{ id: 'reissue', label: '异常注销换码' }] : []),
        ]}
        active={mode}
        onChange={setMode}
      />
      {c?.flight === 'issued' && data.match!.paused ? (
        <ManagementForm
          title="确认穿戴并恢复出航"
          path="/judge/equipment-correction"
          payload={{ target: id, mode: 'activate' }}
          change="核对新配置穿戴后，恢复该文明出航"
        />
      ) : mode === 'replace' ? (
        <ManagementForm
          title="记录手环替换"
          path="/judge/equipment-correction"
          payload={{ target: id, mode: 'replace' }}
          change="只替换同色同款实物手环，当前配置保持有效"
        />
      ) : !data.match!.paused ? (
        <Empty title="请先暂停比赛" to="/judge/clock" action="前往比赛时间">
          异常换码依次核对旧配置、注销、换发与新佩戴，最后才恢复比赛。
        </Empty>
      ) : (
        <ManagementForm
          title="注销旧配置并申请新配置"
          path="/judge/equipment-correction"
          payload={{ target: id, mode: 'reissue' }}
          change="旧配置永久退役，从剩余配置中换发，等待核对新佩戴后恢复"
        />
      )}
    </>
  );
}
const COMMANDS = [
  ['/inspect C07', '查询文明状态'],
  ['/history C07', '查询航次与历史'],
  ['/events list', '查询赛事事件'],
  ['/clock status', '查询比赛时钟'],
  ['/codebook status', '查询手环发行情况'],
  ['/clock pause', '暂停比赛'],
  ['/clock resume', '恢复比赛'],
  ['/pause_attack @a 60', '全场暂时禁止目击60秒'],
  ['/player grant C07 photoid 1', '修正文明光粒库存'],
  ['/player revive C07', '恢复参赛资格'],
  ['/event retry EVT-1024', '重新结算指定事件'],
  ['/announce @a "请联系裁判"', '发送全场公告'],
  ['/schedule 90 /announce @a "请留意赛事通知"', '延迟发送公告'],
];
function Commands() {
  const { data, operate, busy } = useApp();
  const [command, setCommand] = useState('');
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ManagementPreview | null>(null);
  const [stamp, setStamp] = useState('');
  const query = /^\/(inspect|history|events list|clock status|codebook status|help)(\s|$)/.test(
    command,
  );
  return (
    <>
      <PageTitle title="指令控制台" />
      <Disclosure title="查询命令与参数提示">
        <Field label="搜索操作">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="例如暂停、文明、事件"
          />
        </Field>
        <div className="command-help">
          {COMMANDS.filter(([cmd, label]) => `${cmd}${label}`.includes(search)).map(
            ([cmd, label]) => (
              <button
                key={cmd}
                onClick={() => {
                  setCommand(cmd!);
                  setPreview(null);
                }}
              >
                <strong>{label}</strong>
                <code>{cmd}</code>
              </button>
            ),
          )}
        </div>
        <p>
          目标：C07为指定文明，@a为全场参赛者，@alive为存活文明，@dead为淘汰者。随机目标在执行时确定。
        </p>
      </Disclosure>
      <Field label="输入赛事指令">
        <textarea
          className="command-input"
          value={command}
          onChange={(e) => {
            setCommand(e.target.value);
            setPreview(null);
          }}
          rows={3}
          placeholder="/inspect C07"
          spellCheck={false}
        />
      </Field>
      {!query && (
        <Field label="本次执行原因">
          <input
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setPreview(null);
            }}
          />
        </Field>
      )}
      {command.trim() && (query || reason.trim()) && !preview && (
        <Button
          className="primary"
          disabled={busy}
          onClick={async () => {
            const r = await operate(query ? '/judge/command/execute' : '/judge/command/preview', {
              command,
              reason,
              expected_revision: data.match!.revision,
            });
            if (r?.preview) {
              setPreview(r.preview);
              setStamp(`${command}|${reason}`);
            }
          }}
        >
          {query ? '执行查询' : '预览指令影响'}
          <Icon name="arrow" size={18} />
        </Button>
      )}
      {preview && stamp === `${command}|${reason}` && (
        <Frame>
          <h2>指令影响预览</h2>
          <code className="command-preview">{command}</code>
          {preview.changes.map((c, i) => (
            <p key={i}>
              {c.target}：{c.before} → {c.after}
            </p>
          ))}
          {preview.consequences.map((c) => (
            <p className="secondary" key={c}>
              {c}
            </p>
          ))}
          <Button
            className="primary full"
            disabled={busy}
            onClick={async () => {
              const r = await operate('/judge/command/execute', {
                command,
                reason,
                preview_token: preview.token,
                expected_revision: preview.revision,
              });
              if (r?.status === 'complete') setPreview(null);
            }}
          >
            确认执行
          </Button>
        </Frame>
      )}
      <h2>执行历史</h2>
      <AuditEntries />
    </>
  );
}
function SystemStatus() {
  const { data } = useApp();
  const s = data.judge!.scheduler;
  return (
    <>
      <PageTitle title="系统状态" />
      <RecoveryTools />
      <div className="stat-lines">
        <div>
          <span>最近一次成功处理时间</span>
          <strong>{new Date(s.lastSuccessUtcMs).toLocaleTimeString('zh-CN')}</strong>
        </div>
        <div>
          <span>下次自动处理时间</span>
          <strong>
            {s.nextWakeUtcMs
              ? new Date(s.nextWakeUtcMs).toLocaleTimeString('zh-CN')
              : '暂无待执行计划'}
          </strong>
        </div>
        <div>
          <span>已到期但尚未处理的事件</span>
          <strong>{s.backlog}个事件</strong>
        </div>
        <div>
          <span>最近错误</span>
          <strong>{s.error || '没有已记录错误'}</strong>
        </div>
      </div>
      <ManagementForm
        title="重新安排自动处理时间"
        path="/judge/scheduler/rearm"
        change="根据已保存的赛事计划，重新安排下次自动处理时间"
      />
      <ManagementForm
        title="结算到期事件"
        path="/judge/events/settle-due"
        change={`重新核对并结算${s.backlog}个到期事件，保留原事件编号`}
      />
    </>
  );
}
function Settings() {
  const { data, operate, busy } = useApp();
  const [site, setSite] = useState<SiteConfig>(structuredClone(data.site));
  const [preview, setPreview] = useState(false);
  const [reason, setReason] = useState('');
  const change = (
    key: 'title' | 'description' | 'qqGroup' | 'judgeContact' | 'endgameFile',
    value: string,
  ) => {
    setSite({ ...site, [key]: value });
    setPreview(false);
  };
  const colorsValid = COLORS.every((c) => /^#[0-9a-f]{6}$/i.test(site.colors[c.id]));
  return (
    <>
      <PageTitle title="活动设置" />
      <RosterSettings />
      <ParametersSettings />
      <div className="settings-grid">
        <section>
          {(
            [
              ['title', '活动名称'],
              ['description', '参与说明'],
              ['qqGroup', 'QQ群名称与号码'],
              ['judgeContact', '裁判联系方式'],
              ['endgameFile', 'QQ群终局图片文件名称'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <input value={site[key]} onChange={(e) => change(key, e.target.value)} />
            </Field>
          ))}
        </section>
        <section>
          <h2>手环颜色</h2>
          <p className="secondary">七个颜色身份及顺序固定，只调整全站显示色值。</p>
          <div className="color-settings">
            {COLORS.map((c) => (
              <div className="color-setting" key={c.id}>
                <label>
                  <input
                    type="color"
                    aria-label={`${c.name}取色`}
                    value={
                      /^#[0-9a-f]{6}$/i.test(site.colors[c.id]) ? site.colors[c.id] : '#000000'
                    }
                    onChange={(e) => {
                      setSite({ ...site, colors: { ...site.colors, [c.id]: e.target.value } });
                      setPreview(false);
                    }}
                  />
                  <span>{c.name}</span>
                </label>
                <input
                  aria-label={`${c.name}十六进制色值`}
                  value={site.colors[c.id]}
                  maxLength={7}
                  onChange={(e) => {
                    setSite({ ...site, colors: { ...site.colors, [c.id]: e.target.value } });
                    setPreview(false);
                  }}
                />
              </div>
            ))}
          </div>
          <button
            className="text-button"
            onClick={() => {
              setSite({ ...site, colors: { ...DEFAULT_SITE.colors } });
              setPreview(false);
            }}
          >
            重置为初始色值
          </button>
        </section>
      </div>
      <Field label="变更原因">
        <textarea
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setPreview(false);
          }}
        />
      </Field>
      {colorsValid && reason.trim() && site.title.trim() && (
        <Button onClick={() => setPreview(true)}>预览并核对设置</Button>
      )}
      {preview && (
        <Frame>
          <h2>设置变更预览</h2>
          <p>{site.title}</p>
          <div className="material-colors">
            {COLORS.map((c) => (
              <span key={c.id}>
                <span className="mini-band" style={{ backgroundColor: site.colors[c.id] }} />
                {c.name}
              </span>
            ))}
          </div>
          <p>
            保存后，颜色配置版本将从第{data.site.version}
            版更新，覆盖首航、目击、本人手环、观战、历史与大屏展示。比赛中变更会记录操作者及原因。
          </p>
          <Button
            className="primary full"
            disabled={busy}
            onClick={async () => {
              const r = await operate('/judge/site-config', {
                site,
                expected_version: data.site.version,
                reason,
              });
              if (r?.status === 'complete') setPreview(false);
            }}
          >
            确认保存活动设置
          </Button>
        </Frame>
      )}
    </>
  );
}
function ResultsManagement() {
  const { data, source } = useApp();
  const [kind, setKind] = useState('report');
  const [exportError, setExportError] = useState('');
  const exportData = async () => {
    if (source.exportData) {
      try {
        const file = await source.exportData(kind);
        const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = file.fileName;
        link.click();
        URL.revokeObjectURL(url);
        setExportError('');
      } catch (error) {
        setExportError(error instanceof Error ? error.message : '导出失败，请稍后重试。');
      }
      return;
    }
    const object =
      kind === 'report'
        ? {
            version: data.results?.version,
            reason: data.results?.reason,
            standings: data.results?.standings.map((c) => ({
              id: c.id,
              nickname: c.nickname,
              rank: c.rank,
              kills: c.kills,
            })),
            events: data.events.filter((e) => e.audience === 'public'),
          }
        : { audits: data.judge?.audits };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(object, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = kind === 'report' ? '正式战报.json' : '裁判操作记录.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <PageTitle title="比赛结果管理" />
      <ReportCorrection />
      {data.match!.stage === 'ended' ? (
        <>
          <h2>{data.results?.reason ?? '比赛已结束'}</h2>
          <Link className="text-link" to="/results">
            查看正式结果与完整复盘
            <Icon name="arrow" size={18} />
          </Link>
          <Field label="导出内容">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="report">正式战报，不含秘密历史与内部审计</option>
              <option value="audit">裁判操作记录，仅限授权人员</option>
            </select>
          </Field>
          <Button onClick={() => void exportData()}>
            导出{kind === 'report' ? '正式战报' : '裁判操作记录'}
          </Button>
        </>
      ) : (
        <Empty title="当前尚未正式完赛" to="/judge">
          比赛结束后可查看并导出正式结果。
        </Empty>
      )}
      {judgeCan(data, 'system') && (
        <>
          <p className="attention" role="status">
            {exportError}
          </p>
          <Button
            onClick={async () => {
              try {
                const file = await source.exportData?.('backup');
                if (!file) return;
                const url = URL.createObjectURL(
                  new Blob([file.text], { type: 'application/json' }),
                );
                const link = document.createElement('a');
                link.href = url;
                link.download = file.fileName;
                link.click();
                URL.revokeObjectURL(url);
                setExportError('');
              } catch (error) {
                setExportError(error instanceof Error ? error.message : '导出失败，请稍后重试。');
              }
            }}
          >
            导出加密备份
          </Button>
        </>
      )}
    </>
  );
}
function JudgeAccount() {
  const { data, logout } = useApp();
  return (
    <>
      <PageTitle title="裁判账号" />
      <AccountsManagement />
      <h2>{data.session!.name}</h2>
      <p className="secondary">当前账号可以使用以下功能。</p>
      <div className="permission-list">
        {JUDGE_NAV.flatMap((g) => g.items)
          .filter(([area]) => judgeCan(data, area!))
          .map(([area, label]) => (
            <span key={area}>
              <Icon name="check" size={16} />
              {label}
            </span>
          ))}
      </div>
      <Button onClick={() => void logout()}>
        <Icon name="logout" size={18} />
        退出登录
      </Button>
    </>
  );
}
export function JudgePages() {
  const { route, data } = useApp();
  const area = route === '/judge' ? 'overview' : (route.split('/')[2] ?? 'overview');
  if (area === 'more')
    return (
      <>
        <PageTitle title="更多赛事管理" />
        {JUDGE_NAV.map((g) => (
          <section key={g.group}>
            <h2>{g.group}</h2>
            {g.items
              .filter(([permission]) => judgeCan(data, permission!))
              .map(([, label, to]) => (
                <Link className="row-link" key={to} to={to!}>
                  {label}
                  <Icon name="arrow" size={18} />
                </Link>
              ))}
          </section>
        ))}
      </>
    );
  if (!judgeCan(data, area))
    return (
      <>
        <PageTitle title="当前职责无此权限" />
        <Empty title="当前账号不能执行这项操作" to="/judge" action="返回工作台" />
      </>
    );
  if (route === '/judge') return <Dashboard />;
  if (area === 'homeworlds') return <HomeworldReview />;
  if (area === 'preflight') return <PreflightManagement />;
  if (area === 'notices') return <Notices />;
  if (area === 'players') {
    const id = route.split('/')[3];
    const c = data.civilizations.find((c) => c.id === id);
    return id ? (
      c ? (
        <PlayerManagement c={c} />
      ) : (
        <Empty title="文明不存在" to="/judge/players" />
      )
    ) : (
      <>
        <PageTitle title="文明管理" />
        <CivilizationList prefix="/judge/players" />
      </>
    );
  }
  if (area === 'endgame') return <EndgameManagement />;
  if (area === 'clock') return <ClockManagement />;
  if (area === 'events')
    return (
      <>
        <ScheduledEvents />
        <EventExplorer />
      </>
    );
  if (area === 'effects') return <Effects />;
  if (area === 'attacks') return <AttackReview />;
  if (area === 'equipment') return <Equipment />;
  if (area === 'commands') return <Commands />;
  if (area === 'system') return <SystemStatus />;
  if (area === 'audit')
    return (
      <>
        <PageTitle title="操作记录" />
        <AuditEntries />
      </>
    );
  if (area === 'settings') return <Settings />;
  if (area === 'results') return <ResultsManagement />;
  if (area === 'account') return <JudgeAccount />;
  return <Empty title="页面不存在" to="/judge" />;
}
