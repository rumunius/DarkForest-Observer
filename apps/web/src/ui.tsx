import {
  FLIGHT_NAMES,
  RULES,
  STAGE_NAMES,
  type GameEvent,
} from '@darkforest/contracts';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Button, CutOutline} from './components/cut_frame';
import {Icon} from './components/icon';
import {useApp, useClock} from './state';

/** 在应用内导航并保留修饰键的新标签页语义，避免整页刷新丢失草稿。 */
export function Link({
  to,
  children,
  className = '',
  current = false,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  current?: boolean;
}) {
  const {go, base} = useApp();
  return (
    <a
      href={`${base}${to}`}
      aria-current={current ? 'page' : undefined}
      className={className}
      onClick={event => {
        if (
          event.button === 0 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          go(to);
        }
      }}
    >
      {children}
    </a>
  );
}

/** 展示页面标题、返回入口和可选的上下文操作。 */
export function PageTitle({
  title,
  back,
  aside,
}: {
  title: string;
  back?: string | undefined;
  aside?: ReactNode;
}) {
  return (
    <header className="page-heading">
      {back && (
        <Link className="back-link" to={back}>
          <Icon name="back" size={20} />
          返回
        </Link>
      )}
      <div className="heading-row">
        <h1 tabIndex={-1}>{title}</h1>
        {aside}
      </div>
    </header>
  );
}

/** 为当前无可见内容或无匹配对象的页面提供说明及可选返回操作。 */
export function Empty({
  title,
  children,
  to = '/player',
  action = '返回当前页面',
}: {
  title: string;
  children?: ReactNode;
  to?: string;
  action?: string;
}) {
  return (
    <div className="empty-state">
      <Icon name="current" size={32} />
      <h2>{title}</h2>
      {children && <div className="secondary">{children}</div>}
      <Link className="text-link" to={to}>
        {action}
        <Icon name="arrow" size={18} />
      </Link>
    </div>
  );
}

/** 将表单标签、说明和控件关联到一致的可访问结构。 */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="cut field-control">
        <CutOutline />
        {children}
      </div>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** 编辑六位十进制文本，保留前导零，不将母星口令转成数值。 */
export function CodeField({
  value,
  onChange,
  label = '六位母星口令',
}: {
  value: string;
  onChange: (s: string) => void;
  label?: string;
}) {
  return (
    <Field label={label} hint="请输入6位数字">
      <input
        className="code-input"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="000000"
        spellCheck={false}
      />
    </Field>
  );
}

/** 把有效比赛毫秒格式化为赛程显示，计算逻辑仍使用原始时间。 */
export function formatTime(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

/** 按指定UTC或有效比赛时钟显示剩余时间，不自行授权到期操作。 */
export function Timer({
  label,
  deadline,
  clock = 'game',
  large = false,
}: {
  label: string;
  deadline: number;
  clock?: 'utc' | 'game';
  large?: boolean;
}) {
  const now = useClock();
  const {refresh} = useApp();
  const remaining = deadline - now[clock];
  const fired = useRef(false);
  useEffect(() => {
    if (remaining <= 0 && !fired.current) {
      fired.current = true;
      void refresh();
    }
  }, [remaining, refresh]);
  return (
    <div className={`timer ${large ? 'timer-large' : ''}`}>
      <span className="eyebrow">{label}</span>
      <span className="numeric">
        {remaining <= 0 ? '正在更新' : formatTime(remaining)}
      </span>
    </div>
  );
}

/** 展示当前阶段、时钟和暂停摘要，可使用紧凑布局。 */
export function MatchSummary({compact = false}: {compact?: boolean}) {
  const {data} = useApp();
  const now = useClock();
  const match = data.match;
  if (!match) {
    return null;
  }
  const elapsed = Math.min(RULES.regulationMs, Math.max(0, now.game));
  const ended = match.stage === 'ended';
  const stages = [
    {id: 'forest', start: 0, end: RULES.apocalypseMs},
    {id: 'apocalypse', start: RULES.apocalypseMs, end: RULES.transferMs},
    {id: 'transfer', start: RULES.transferMs, end: RULES.cutoffMs},
    {id: 'hunt', start: RULES.cutoffMs, end: RULES.regulationMs},
  ] as const;
  return (
    <div className={`match-block ${compact ? 'compact' : ''}`}>
      <div className={`match-summary ${compact ? 'compact' : ''}`}>
        <span className="phase">
          <i />
          当前阶段：{STAGE_NAMES[match.stage]}
        </span>
        <div className="match-time">
          <strong className="numeric">{formatTime(now.game)}</strong>
        </div>
        {match.paused && (
          <p className="attention">
            {match.verification ? '终局资格确认中' : '比赛已暂停'}
            {match.pauseReason && `：${match.pauseReason}`}
          </p>
        )}
      </div>
      <div className="match-timeline">
        <div className="timeline-caption">
          <span>
            赛程 <span className="numeric">120</span> 分钟
          </span>
          <span>
            {ended
              ? '比赛已结束'
              : `剩余 ${formatTime(RULES.regulationMs - elapsed)}`}
          </span>
        </div>
        <div
          className="timeline-track"
          role="progressbar"
          aria-label="120分钟比赛进度"
          aria-valuemin={0}
          aria-valuemax={120}
          aria-valuenow={Math.floor(elapsed / 60000)}
          aria-valuetext={`${STAGE_NAMES[match.stage]}，${ended ? '比赛已结束' : `剩余${formatTime(RULES.regulationMs - elapsed)}`}${match.paused ? '，已暂停' : ''}`}
        >
          {stages.map(stage => (
            <span
              key={stage.id}
              className={`timeline-segment ${match.stage === stage.id && !ended ? 'current' : ''}`}
              style={{
                width: `${((stage.end - stage.start) / RULES.regulationMs) * 100}%`,
              }}
            >
              <span
                className="timeline-elapsed"
                style={{
                  width: `${Math.min(1, Math.max(0, (elapsed - stage.start) / (stage.end - stage.start))) * 100}%`,
                }}
              />
            </span>
          ))}
          <span
            className={`timeline-marker ${match.paused ? 'paused' : ''}`}
            style={{left: `${(elapsed / RULES.regulationMs) * 100}%`}}
          />
        </div>
        <div className="timeline-legend">
          {stages.map(stage => (
            <span
              key={stage.id}
              aria-current={
                match.stage === stage.id && !ended ? 'step' : undefined
              }
            >
              <span>{STAGE_NAMES[stage.id]}</span>
              <small className="numeric">
                {stage.start / 60000}—{stage.end / 60000}
              </small>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 为状态文字提供一致的语气样式，不把颜色作为唯一含义。 */
export function Status({
  children,
  tone = '',
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`status ${tone}`}>{children}</span>;
}

/** 组合文明编号与可用昵称，保持编号在昵称为空时仍可识别。 */
export function Identity({id, nickname}: {id: string; nickname: string}) {
  return (
    <div className="identity">
      <span className="numeric civilization-id">{id}</span>
      <strong>{nickname || '尚未设置昵称'}</strong>
    </div>
  );
}

/** 展示当前本人飞船与阶段状态，行动入口另按许可矩阵判断。 */
export function PlayerStatus() {
  const {data} = useApp();
  const playerState = data.player;
  const danger =
    playerState &&
    ['eliminated', 'returning', 'preparing', 'issued'].includes(
      playerState.flight,
    );
  const attention = playerState?.flight === 'active' && !playerState.homeAlive;
  return (
    playerState && (
      <Status tone={danger ? 'danger' : attention ? 'attention' : ''}>
        {FLIGHT_NAMES[playerState.flight]}
      </Status>
    )
  );
}

/** 取得并复制授权QQ材料，失败时保留可手工复制正文及反馈。 */
export function CopyText({
  kind,
  text,
  label = '复制消息',
  onCopied,
}: {
  kind?: string;
  text?: string;
  label?: string;
  onCopied?: () => void;
}) {
  const {source} = useApp();
  const [body, setBody] = useState(text ?? '');
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setBody(text ?? '');
    setFeedback('');
  }, [text, kind]);
  const copy = async () => {
    setLoading(true);
    try {
      const value = kind ? await source.template(kind) : (text ?? '');
      setBody(value);
      await navigator.clipboard.writeText(value);
      setFeedback('已复制，请到QQ粘贴发送。');
      onCopied?.();
    } catch {
      setFeedback('请长按下方消息，选择复制。');
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="copy-block">
      <Button onClick={() => void copy()} disabled={loading}>
        <Icon name="copy" size={18} />
        {loading ? '正在获取消息' : label}
      </Button>
      {feedback && (
        <p role="status" className="secondary">
          {feedback}
        </p>
      )}
      {body && (
        <pre className="copy-text" tabIndex={0}>
          {body}
        </pre>
      )}
    </div>
  );
}

/** 展示已发生事件列表及可选详情入口，保持当前受众范围。 */
export function Events({
  events,
  detailsPrefix,
}: {
  events: GameEvent[];
  detailsPrefix?: string;
}) {
  const {data, loadEarlierEvents} = useApp();
  return events.length ? (
    <div className="event-list">
      {events.map(event => (
        <article
          className={`event-row ${['photon', 'singer'].includes(event.kind) ? 'event-danger' : ''}`}
          key={event.id}
        >
          <span className="event-icon">
            <Icon
              name={
                event.kind === 'broadcast'
                  ? 'broadcast'
                  : event.kind === 'photon'
                    ? 'photon'
                    : event.kind === 'sighting'
                      ? 'action'
                      : 'current'
              }
              size={20}
            />
          </span>
          <div className="event-copy">
            {detailsPrefix ? (
              <Link to={`${detailsPrefix}/${event.id}`}>
                <h3>{event.title}</h3>
              </Link>
            ) : (
              <h3>{event.title}</h3>
            )}
            <p>{event.body}</p>
            {event.code && (
              <span className="numeric event-code">{event.code}</span>
            )}
          </div>
          <time
            className="numeric"
            title={new Date(event.utcMs).toLocaleString('zh-CN', {
              timeZone: data.site.timezone,
            })}
          >
            {formatTime(event.gameMs)}
          </time>
        </article>
      ))}
      {data.eventCursor && events.length >= 50 && (
        <Button onClick={() => void loadEarlierEvents()}>加载更早记录</Button>
      )}
    </div>
  ) : (
    <p className="empty-inline">还没有新的赛事事件。</p>
  );
}

/** 以可访问标签切换当前页面筛选，状态由调用方受控管理。 */
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{id: string; label: string; count?: number}>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(tab => (
        <button
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          key={tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="numeric">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** 用原生折叠语义按需展示规则或历史，避免隐藏当前必需任务。 */
export function Disclosure({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="disclosure">
      <summary>
        {title}
        <span aria-hidden="true">＋</span>
      </summary>
      <div>{children}</div>
    </details>
  );
}
export {ArmsView, MiniArms} from './components/bracelet_display';
export {ColorEditor} from './components/color_editor';
export {ConfirmDialog} from './components/confirmation';
export {Button, CutOutline, Frame, notchPath} from './components/cut_frame';
export {Feedback, type FeedbackMessage} from './components/feedback';
export {Icon} from './components/icon';
