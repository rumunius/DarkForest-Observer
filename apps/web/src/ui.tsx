import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  COLORS,
  FLIGHT_NAMES,
  STAGE_NAMES,
  RULES,
  validArms,
  type Arms,
  type ColorId,
  type GameEvent,
} from '@darkforest/contracts';
import { useApp, useClock } from './state';
import { moveBracelet } from './bracelets';

const paths: Record<string, ReactNode> = {
  current: (
    <>
      <path d="M4 4h16v16H4zM4 10h16M9 10v10" />
    </>
  ),
  action: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  message: (
    <>
      <path d="M3 5h18v14H3zM3 6l9 7 9-7" />
    </>
  ),
  me: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 21v-3a7 7 0 0 1 14 0v3" />
    </>
  ),
  arrow: <path d="m9 5 7 7-7 7M3 12h12" />,
  back: <path d="m14 5-7 7 7 7M7 12h14" />,
  check: <path d="m5 12 4 4L19 6" />,
  copy: (
    <>
      <path d="M8 8h12v13H8zM16 8V3H3v13h5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  planet: (
    <>
      <circle cx="12" cy="12" r="6" />
      <path d="M6 8C-3 12 2 20 14 16s14-11 4-10" />
    </>
  ),
  broadcast: (
    <>
      <path d="M8 8a6 6 0 0 0 0 8m8-8a6 6 0 0 1 0 8M5 4a11 11 0 0 0 0 16m14-16a11 11 0 0 1 0 16" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  photon: (
    <>
      <path d="M12 2v5m0 10v5M2 12h5m10 0h5" />
      <circle cx="12" cy="12" r="5" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  alert: (
    <>
      <path d="m12 3 10 18H2L12 3Zm0 5v6m0 3v1" />
    </>
  ),
  list: <path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1" />,
  settings: (
    <>
      <path d="M3 6h18M3 18h18M8 3v6m8 6v6" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="16" cy="18" r="2" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="m7 3 14 9-14 9V3Z" />,
  logout: <path d="M9 4H3v16h6m6-13 5 5-5 5M8 12h12" />,
};
export function Icon({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="miter"
      strokeLinecap="square"
      aria-hidden="true"
    >
      {paths[name] ?? paths.current}
    </svg>
  );
}

export function notchPath(width: number, height: number, cut: number, inset = 0.5): string {
  return `M ${cut} ${inset} H ${width - inset} V ${height - cut} L ${width - cut} ${height - inset} H ${inset} V ${cut} Z`;
}
/** A closed stroked path draws BOTH diagonal edges; clip-path alone cannot. */
export function CutOutline({ cut = 6 }: { cut?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const update = () => {
      const { width, height } = parent.getBoundingClientRect();
      setSize({ width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  return (
    <svg ref={ref} className="cut-outline" width="100%" height="100%" aria-hidden="true">
      <path className="cut-fill" d={notchPath(size.width, size.height, cut)} />
      <path
        className="cut-focus"
        d={notchPath(size.width + 6, size.height + 6, cut + 2)}
        transform="translate(-3 -3)"
      />
    </svg>
  );
}
export function Frame({
  children,
  className = '',
  cut = 10,
}: {
  children: ReactNode;
  className?: string;
  cut?: number;
}) {
  return (
    <div className={`cut frame ${className}`}>
      <CutOutline cut={cut} />
      <div className="frame-content">{children}</div>
    </div>
  );
}
export function Button({
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`cut button ${className}`} {...props}>
      <CutOutline />
      <span className="button-content">{children}</span>
    </button>
  );
}
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
  const { go, base } = useApp();
  return (
    <a
      href={`${base}${to}`}
      aria-current={current ? 'page' : undefined}
      className={className}
      onClick={(e) => {
        if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          go(to);
        }
      }}
    >
      {children}
    </a>
  );
}
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
    <Field label={label} hint="请输入6位数字，开头的0也需要保留。">
      <input
        className="code-input"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="000000"
        spellCheck={false}
      />
    </Field>
  );
}
export function formatTime(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
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
  const { refresh } = useApp();
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
      <span className="numeric">{remaining <= 0 ? '正在更新' : formatTime(remaining)}</span>
    </div>
  );
}
export function MatchSummary({ compact = false }: { compact?: boolean }) {
  const { data } = useApp();
  const now = useClock();
  const match = data.match;
  if (!match) return null;
  const elapsed = Math.min(RULES.regulationMs, Math.max(0, now.game));
  const ended = match.stage === 'ended';
  const stages = [
    { id: 'forest', start: 0, end: RULES.apocalypseMs },
    { id: 'apocalypse', start: RULES.apocalypseMs, end: RULES.transferMs },
    { id: 'transfer', start: RULES.transferMs, end: RULES.cutoffMs },
    { id: 'hunt', start: RULES.cutoffMs, end: RULES.regulationMs },
  ] as const;
  return (
    <div className={`match-block ${compact ? 'compact' : ''}`}>
      <div className={`match-summary ${compact ? 'compact' : ''}`}>
        <span className="phase">
          <i />
          当前阶段：{STAGE_NAMES[match.stage]}
        </span>
        <div className="match-time">
          <span>有效比赛时间</span>
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
          <span>{ended ? '比赛已结束' : `剩余 ${formatTime(RULES.regulationMs - elapsed)}`}</span>
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
          {stages.map((stage) => (
            <span
              key={stage.id}
              className={`timeline-segment ${match.stage === stage.id && !ended ? 'current' : ''}`}
              style={{ width: `${((stage.end - stage.start) / RULES.regulationMs) * 100}%` }}
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
            style={{ left: `${(elapsed / RULES.regulationMs) * 100}%` }}
          />
        </div>
        <div className="timeline-legend">
          {stages.map((stage) => (
            <span
              key={stage.id}
              aria-current={match.stage === stage.id && !ended ? 'step' : undefined}
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
export function Status({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`status ${tone}`}>{children}</span>;
}
export function Identity({ id, nickname }: { id: string; nickname: string }) {
  return (
    <div className="identity">
      <span className="numeric civilization-id">{id}</span>
      <strong>{nickname || '尚未设置昵称'}</strong>
    </div>
  );
}
export function PlayerStatus() {
  const { data } = useApp();
  const me = data.player;
  return (
    me && (
      <Status tone={me.flight === 'eliminated' ? 'danger' : ''}>{FLIGHT_NAMES[me.flight]}</Status>
    )
  );
}
export function MiniArms({ arms }: { arms: Arms | null }) {
  const { data } = useApp();
  if (!arms) return <span className="muted">无现役配置</span>;
  return (
    <div className="mini-arms" aria-label="两侧手环配置">
      {arms.map((arm, i) => (
        <span className="mini-arm" key={i} aria-label={i ? '另一侧手臂' : '一侧手臂'}>
          {COLORS.filter((c) => arm.includes(c.id)).map((c) => (
            <span
              className="mini-band"
              key={c.id}
              title={c.name}
              aria-label={c.name}
              style={{ backgroundColor: data.site.colors[c.id] }}
            />
          ))}
        </span>
      ))}
    </div>
  );
}
function Hand({ mirror = false }: { mirror?: boolean }) {
  return (
    <svg className="hand" viewBox="0 0 140 260" aria-hidden="true">
      <g transform={mirror ? 'translate(140 0) scale(-1 1)' : undefined}>
        <path
          d="M42 259 40 166 26 141 17 116 18 107 24 104 31 110 40 128 42 67 43 30 48 25 53 29 55 83 58 14 63 9 68 14 69 82 74 19 79 16 84 21 82 87 89 40 94 37 99 42 98 108 98 135 92 164 96 259"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M40 166h52" fill="none" stroke="currentColor" strokeWidth="1" />
      </g>
    </svg>
  );
}
export function ArmsView({
  arms,
  editable = false,
  selected = null,
  onSelect,
  onRemove,
  onPointerDown,
  dragging,
}: {
  arms: Arms;
  editable?: boolean;
  selected?: number | null;
  onSelect?: (arm: number) => void;
  onRemove?: (id: ColorId) => void;
  onPointerDown?: (event: ReactPointerEvent, id: ColorId) => void;
  dragging?: ColorId | null;
}) {
  const { data, names } = useApp();
  return (
    <div className={`arms ${editable ? 'editable-arms' : 'readonly-arms'}`}>
      {arms.map((arm, index) => (
        <div
          key={index}
          className={`arm ${selected === index ? 'selected' : ''}`}
          data-drop-arm={editable ? index : undefined}
          role="group"
          aria-label={index ? '另一侧手臂' : '一侧手臂'}
        >
          {editable ? (
            <button
              className="arm-select cut"
              onClick={() => onSelect?.(index)}
              aria-pressed={selected === index}
            >
              <CutOutline cut={10} />
              <span className="arm-title">
                {index ? '另一侧手臂' : '一侧手臂'}
                <small>
                  {selected === index ? '正在选择' : arm.length ? `${arm.length}条` : '尚未选择'}
                </small>
              </span>
            </button>
          ) : (
            <div className="arm-title">
              {index ? '另一侧手臂' : '一侧手臂'}
              <small>{arm.length}条</small>
            </div>
          )}
          <Hand mirror={index === 1} />
          <div className="arm-bands">
            {COLORS.filter((c) => arm.includes(c.id)).map((c) =>
              editable ? (
                <button
                  key={c.id}
                  data-color={c.id}
                  className={`wrist-band ${dragging === c.id ? 'drag-origin' : ''}`}
                  aria-label={`${c.name}，${index ? '另一侧手臂' : '一侧手臂'}，点击移除`}
                  onPointerDown={(e) => onPointerDown?.(e, c.id)}
                  onClick={() => onRemove?.(c.id)}
                >
                  <span
                    data-swatch={c.id}
                    className="swatch"
                    style={{ backgroundColor: data.site.colors[c.id] }}
                  />
                  {names && <span className="band-name">{c.name}</span>}
                </button>
              ) : (
                <div key={c.id} className="wrist-band">
                  <span
                    className="swatch"
                    style={{ backgroundColor: data.site.colors[c.id] }}
                    role="img"
                    aria-label={c.name}
                  />
                  {names && <span className="band-name">{c.name}</span>}
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
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
  const { source } = useApp();
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
export function Events({ events, detailsPrefix }: { events: GameEvent[]; detailsPrefix?: string }) {
  const { data } = useApp();
  return events.length ? (
    <div className="event-list">
      {events.map((event) => (
        <article className="event-row" key={event.id}>
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
            {event.code && <span className="numeric event-code">{event.code}</span>}
          </div>
          <time
            className="numeric"
            title={new Date(event.utcMs).toLocaleString('zh-CN', { timeZone: data.site.timezone })}
          >
            {formatTime(event.gameMs)}
          </time>
        </article>
      ))}
    </div>
  ) : (
    <p className="empty-inline">还没有新的赛事事件。</p>
  );
}
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          type="button"
          role="tab"
          aria-selected={active === t.id}
          key={t.id}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className="numeric">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
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

export function ColorEditor() {
  const {
    draft,
    setDraft,
    selectedArm,
    setSelectedArm,
    data,
    names,
    reduced,
    busy,
    pending,
    online,
    operate,
  } = useApp();
  const [feedback, setFeedback] = useState('已选择一侧手臂，请选择颜色。');
  const [confirmation, setConfirmation] = useState<Arms | null>(null);
  const [dragging, setDragging] = useState<ColorId | null>(null);
  const [moving, setMoving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const previous = useRef(new Map<string, DOMRect>());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const cancelRef = useRef<() => void>(() => {});
  const suppressClick = useRef(false);
  const locked = busy || !!pending || !online;
  const valid = validArms(draft);
  useEffect(() => {
    setSelectedArm(0);
    root.current?.querySelector<HTMLElement>('.arm-select')?.focus({ preventScroll: true });
  }, [setSelectedArm]);
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    root.current?.querySelectorAll<HTMLElement>('[data-swatch]').forEach((element) => {
      const key = element.dataset.swatch!;
      const rect = element.getBoundingClientRect();
      const old = previous.current.get(key);
      if (
        old &&
        !reduced &&
        !moving &&
        (old.x !== rect.x || old.y !== rect.y || old.width !== rect.width)
      ) {
        element.getAnimations().forEach((a) => a.cancel());
        element.animate(
          [
            {
              transform: `translate(${old.x - rect.x}px,${old.y - rect.y}px) scale(${old.width / rect.width},${old.height / rect.height})`,
            },
            { transform: 'none' },
          ],
          { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' },
        );
      }
      next.set(key, rect);
    });
    previous.current = next;
  }, [draft, reduced, moving]);
  const move = (id: ColorId, target: number | null) => {
    if (locked) return;
    const result = moveBracelet(draftRef.current, id, target);
    if ('error' in result) {
      setFeedback(result.error);
      return;
    }
    const next = result.arms;
    target = result.target;
    if (target !== null) setSelectedArm(target);
    const name = COLORS.find((c) => c.id === id)!.name;
    setDraft(next);
    setFeedback(
      target === null
        ? `${name}已退回色盘。`
        : `${result.overflow ? '原手臂已满，已自动切换。' : ''}${name}已移到${target ? '另一侧手臂' : '一侧手臂'}，共${next[target]!.length}条。`,
    );
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(`[data-color="${id}"]`)
        ?.focus({ preventScroll: true }),
    );
  };
  const click = (id: ColorId, remove = false) => {
    if (suppressClick.current || dragging || locked) return;
    if (remove) move(id, null);
    else if (selectedArm === null) setFeedback('请先选择一侧手臂。');
    else move(id, selectedArm);
  };
  const pointerDown = (event: ReactPointerEvent, id: ColorId) => {
    if (locked || dragging || event.button !== 0 || !event.isPrimary) return;
    const startX = event.clientX,
      startY = event.clientY,
      pointerId = event.pointerId;
    const origin = event.currentTarget as HTMLElement;
    const color = origin.querySelector<HTMLElement>('.swatch')?.getBoundingClientRect();
    let active = false;
    let cancelled = false;
    let x = startX;
    let y = startY;
    const position = () => {
      if (ghost.current) {
        ghost.current.style.left = `${x}px`;
        ghost.current.style.top = `${y - (event.pointerType === 'touch' ? 20 : 0)}px`;
      }
    };
    const lift = () => {
      if (cancelled) return;
      active = true;
      suppressClick.current = true;
      setMoving(true);
      setDragging(id);
      origin.setPointerCapture(pointerId);
      requestAnimationFrame(position);
    };
    const timer = event.pointerType === 'touch' ? window.setTimeout(lift, 180) : undefined;
    const clear = () => {
      if (timer) clearTimeout(timer);
      cancelled = true;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('touchmove', onTouchMove);
      origin.removeEventListener('lostpointercapture', cancel);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      document.removeEventListener('visibilitychange', cancel);
      if (origin.hasPointerCapture(pointerId)) origin.releasePointerCapture(pointerId);
      root.current
        ?.querySelectorAll('.drop-active')
        .forEach((el) => el.classList.remove('drop-active'));
      setDragging(null);
      window.setTimeout(() => {
        suppressClick.current = false;
        setMoving(false);
      }, 0);
    };
    const cancel = () => {
      clear();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    const onTouchMove = (e: TouchEvent) => {
      if (active && e.cancelable) e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      x = e.clientX;
      y = e.clientY;
      const distance = Math.hypot(x - startX, y - startY);
      if (!active && event.pointerType === 'touch' && distance > 8) {
        cancel();
        return;
      }
      if (!active && event.pointerType !== 'touch' && distance > 6) lift();
      if (!active) return;
      e.preventDefault();
      position();
      root.current
        ?.querySelectorAll('.drop-active')
        .forEach((el) => el.classList.remove('drop-active'));
      document
        .elementFromPoint(x, y)
        ?.closest('[data-drop-arm], [data-palette]')
        ?.classList.add('drop-active');
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (active) {
        const target = document
          .elementFromPoint(e.clientX, e.clientY)
          ?.closest<HTMLElement>('[data-drop-arm], [data-palette]');
        if (target?.dataset.dropArm !== undefined) {
          const index = Number(target.dataset.dropArm);
          move(id, index);
        } else if (target?.hasAttribute('data-palette')) move(id, null);
      }
      clear();
    };
    if (color) {
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', cancel);
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      origin.addEventListener('lostpointercapture', cancel);
      document.addEventListener('keydown', onKey);
      window.addEventListener('blur', cancel);
      window.addEventListener('resize', cancel);
      document.addEventListener('visibilitychange', cancel);
      cancelRef.current = cancel;
    }
  };
  useEffect(() => () => cancelRef.current(), []);
  useEffect(() => {
    if (locked) {
      cancelRef.current();
      setConfirmation(null);
    }
  }, [locked]);
  const wrong = data.player?.wrongCount ?? 0;
  return (
    <div ref={root} className={`color-editor ${locked ? 'input-locked' : ''}`}>
      {locked && (
        <p className="attention" role="status">
          {!online ? '连接已中断，保留当前选择。' : '正在确认攻击结果'}
        </p>
      )}
      <ArmsView
        arms={draft}
        editable={!locked}
        selected={selectedArm}
        onSelect={setSelectedArm}
        onRemove={(id) => click(id, true)}
        onPointerDown={pointerDown}
        dragging={dragging}
      />
      <p className="arm-caption">同侧顺序不限，两侧可以交换。</p>
      {!locked && (
        <>
          <div className="palette" data-palette="true" aria-label="共享七色盘">
            {COLORS.map((c) =>
              draft.flat().includes(c.id) ? (
                <span key={c.id} className="palette-space" aria-hidden="true" />
              ) : (
                <button
                  key={c.id}
                  type="button"
                  data-color={c.id}
                  className={`palette-color ${dragging === c.id ? 'drag-origin' : ''}`}
                  aria-label={`${c.name}，色盘，点击移入所选手臂`}
                  onClick={() => click(c.id)}
                  onPointerDown={(e) => pointerDown(e, c.id)}
                >
                  <span
                    className="swatch"
                    data-swatch={c.id}
                    style={{ backgroundColor: data.site.colors[c.id] }}
                  />
                  {names && <span className="color-name">{c.name}</span>}
                </button>
              ),
            )}
          </div>
          <div className="editor-tools">
            <div>
              {draft.flat().length > 0 && (
                <button
                  className="text-button"
                  onClick={() => {
                    setDraft([[], []]);
                    setSelectedArm(0);
                    setFeedback('已清空选择，请为一侧手臂选择颜色。');
                  }}
                >
                  清空选择
                </button>
              )}
            </div>
          </div>
        </>
      )}
      <p className="selection-feedback secondary" aria-live="polite">
        {feedback}
      </p>
      <div className="attack-consequence">
        <p className="secondary">
          提交错误目击码的次数 <strong className="numeric">{wrong}</strong>
        </p>
        <p>
          {wrong === 0
            ? '提交错误的目击码，将禁止目击攻击5分钟。'
            : wrong === 1
              ? '再次提交错误的目击码，有50%的概率永久淘汰，有50%的概率禁止目击攻击15分钟。'
              : '再次提交错误的目击码，将永久淘汰。'}
        </p>
      </div>
      {valid && !locked ? (
        <Button
          className="primary full"
          disabled={!!dragging}
          onClick={() => setConfirmation([[...draft[0]], [...draft[1]]])}
        >
          <Icon name="action" size={20} />
          确认攻击
          <Icon name="arrow" size={20} />
        </Button>
      ) : (
        !locked && (
          <p className="confirm-hint">
            {draft.every((a) => a.length)
              ? '两侧数量应为两条与一条、两条与两条，或三条与一条。'
              : '请选完两侧手臂的颜色。'}
          </p>
        )
      )}
      {confirmation && valid && !locked && (
        <AttackConfirmation
          arms={confirmation}
          wrong={wrong}
          onCancel={() => setConfirmation(null)}
          onConfirm={async () => {
            const arms = confirmation;
            setConfirmation(null);
            const response = await operate('/action/sighting', { arm_a: arms[0], arm_b: arms[1] });
            if (response?.status === 'complete') {
              setDraft([[], []]);
              setSelectedArm(0);
            }
          }}
        />
      )}
      {dragging && (
        <div
          className="drag-ghost"
          ref={ghost}
          style={{ backgroundColor: data.site.colors[dragging] }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function AttackConfirmation({
  arms,
  wrong,
  onCancel,
  onConfirm,
}: {
  arms: Arms;
  wrong: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { data, names } = useApp();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="attack-dialog"
      aria-labelledby="attack-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <Frame>
        <span className="eyebrow">目击攻击 · 最终核对</span>
        <h2 id="attack-confirm-title">确认提交这组手环？</h2>
        {arms.map((arm, index) => (
          <div className="confirmation-arm" key={index}>
            <span>{index ? '另一侧手臂' : '一侧手臂'}</span>
            <div>
              {COLORS.filter((color) => arm.includes(color.id)).map((color) => (
                <span key={color.id}>
                  <span
                    className="mini-band"
                    style={{ backgroundColor: data.site.colors[color.id] }}
                    role="img"
                    aria-label={color.name}
                  />
                  {names && <small>{color.name}</small>}
                </span>
              ))}
            </div>
          </div>
        ))}
        <p className="secondary">请确认这是你在现场亲眼观察到的完整配置。提交后由服务器结算。</p>
        <p className="attention">
          {wrong === 0
            ? '提交错误的目击码，将禁止目击攻击5分钟。'
            : wrong === 1
              ? '再次提交错误的目击码，有50%的概率永久淘汰，有50%的概率禁止目击攻击15分钟。'
              : '再次提交错误的目击码，将永久淘汰。'}
        </p>
        <div className="confirmation-actions">
          <Button autoFocus onClick={onCancel}>
            返回检查
          </Button>
          <Button className="primary" onClick={onConfirm}>
            确认提交攻击
          </Button>
        </div>
      </Frame>
    </dialog>
  );
}
