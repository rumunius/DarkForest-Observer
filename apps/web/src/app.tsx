import {handleAsync} from './data/async_event';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {DataSource} from '@darkforest/contracts';
import {AppProvider, useApp} from './state';
import {judgeCan} from './permissions';
import {
  Button,
  Empty,
  Feedback,
  type FeedbackMessage,
  Field,
  Icon,
  Identity,
  Link,
  MatchSummary,
  PageTitle,
} from './ui';
import {PlayerPages, Rules} from './pages/player';
import {Display, ObserverPages, ResultsPages} from './pages/observe';
import {JUDGE_NAV, JudgePages} from './pages/judge';
import {Atmosphere} from './components/atmosphere';
import {
  MatchContextProvider,
  MatchHeading,
  type MatchContext,
} from './components/match_context';

function Stars() {
  return (
    <div className="stars" aria-hidden="true">
      {Array.from({length: 12}, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}
function Landing() {
  const {data} = useApp();
  return (
    <div className="landing">
      <div className="entry-symbol" aria-hidden="true">
        <Icon name="planet" size={46} />
      </div>
      <h1>
        {data.site.title.split('：').map(part => (
          <span key={part}>{part}</span>
        ))}
      </h1>
      <p>{data.site.description}</p>
      <Link to="/login" className="landing-primary">
        <span>玩家登录</span>
        <Icon name="arrow" size={22} />
      </Link>
      <div className="entry-links">
        <Link to="/login?audience=judge">
          裁判入口
          <Icon name="arrow" size={16} />
        </Link>
        <Link to="/rules">
          比赛规则
          <Icon name="arrow" size={16} />
        </Link>
      </div>
      {data.site.qqGroup && <p className="entry-group">{data.site.qqGroup}</p>}
    </div>
  );
}
function Login() {
  const {reportError, source, refresh, go, route} = useApp();
  const [credential, setCredential] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const judge =
    new URLSearchParams(location.search).get('audience') === 'judge' ||
    route.startsWith('/judge');
  return (
    <>
      <PageTitle title={judge ? '裁判登录' : '玩家登录'} back="/" />
      <p className="secondary">
        使用{judge ? '独立裁判' : '本场参赛'}口令进入。支持直接粘贴完整口令。
      </p>
      <form
        className="login-form form-stack"
        onSubmit={handleAsync(async event => {
          event.preventDefault();
          if (!credential.trim() || busy) {
            return;
          }
          setBusy(true);
          setError('');
          try {
            await source.login(credential, judge);
            setCredential('');
            await refresh();
            go(
              judge
                ? '/judge'
                : route.startsWith('/player/')
                  ? route
                  : '/player',
            );
          } catch (e) {
            setError(e instanceof Error ? e.message : '登录未完成，请重试。');
          } finally {
            setBusy(false);
          }
        }, reportError)}
      >
        <Field label={judge ? '裁判口令' : '参赛口令'}>
          <input
            type={show ? 'text' : 'password'}
            value={credential}
            onChange={e => setCredential(e.target.value)}
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <label className="check-label">
          <input
            type="checkbox"
            checked={show}
            onChange={e => setShow(e.target.checked)}
          />
          显示口令
        </label>
        {error && (
          <p className="danger" role="alert">
            {error}
          </p>
        )}
        {credential.trim() && (
          <Button type="submit" className="primary full" disabled={busy}>
            {busy ? '正在登录' : '进入比赛'}
            <Icon name="arrow" size={18} />
          </Button>
        )}
      </form>
      <Link className="text-link" to="/rules">
        查看比赛规则
        <Icon name="arrow" size={18} />
      </Link>
    </>
  );
}
function useFeedbackMessages() {
  const {
    error,
    result,
    pending,
    busy,
    refresh,
    recover,
    clearFeedback,
    data,
    online,
  } = useApp();
  const messages: FeedbackMessage[] = [];
  if (!online || error) {
    messages.push({
      tone: 'error',
      content: (
        <>
          <strong>{!online ? '连接已中断，保留当前草稿。' : error}</strong>
          {data.match && (
            <small>
              上次更新：
              {new Date(data.match.serverUtcMs).toLocaleTimeString('zh-CN', {
                timeZone: data.site.timezone,
              })}
            </small>
          )}
          <button className="text-button" onClick={() => void refresh()}>
            重新连接
          </button>
        </>
      ),
    });
  }
  if (pending) {
    messages.push({
      tone: 'pending',
      content: (
        <>
          <strong>正在确认上一次操作结果</strong>
          <p>请等待结果。</p>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void recover()}
          >
            查询原操作结果
          </button>
        </>
      ),
    });
  }
  if (result?.status === 'complete' && !result.preview) {
    messages.push({
      tone: 'result',
      onClose: clearFeedback,
      content: (
        <>
          <strong>{result.title}</strong>
          <p>{result.message}</p>
          {result.code && /^\d{6}$/.test(result.code) && (
            <strong className="numeric feedback-code">{result.code}</strong>
          )}
        </>
      ),
    });
  }
  return messages;
}
function Navigation() {
  const {data, route, unread} = useApp();
  const judge = data.session?.role === 'judge';
  const observer = route.startsWith('/observer');
  const tabs = judge
    ? [
        ['/judge', '工作台', 'current'],
        ['/judge/notices', '待办', 'message'],
        ['/judge/players', '文明', 'me'],
        ['/judge/more', '更多', 'list'],
      ]
    : observer
      ? [
          ['/observer', '战况', 'current'],
          ['/observer/civilizations', '文明', 'action'],
          ['/observer/events', '事件', 'message'],
          ['/player/me', '我的', 'me'],
        ]
      : [
          ['/player', '面板', 'current'],
          ['/player/actions', '行动', 'action'],
          ['/player/messages', '消息', 'message'],
          ['/player/me', '我的', 'me'],
        ];
  const active = (path: string) => {
    if (!judge && !observer) {
      if (path === '/player/actions') {
        return route.startsWith(path);
      }
      if (path === '/player/messages') {
        return route.startsWith(path) || route === '/player/intel';
      }
      if (path === '/player/me') {
        return [
          '/player/me',
          '/player/bracelets',
          '/player/records',
          '/player/help',
          '/player/exception',
          '/player/account',
        ].includes(route);
      }
      return (
        !route.startsWith('/player/actions') &&
        ![
          '/player/messages',
          '/player/intel',
          '/player/me',
          '/player/bracelets',
          '/player/records',
          '/player/help',
          '/player/exception',
          '/player/account',
        ].some(p => route.startsWith(p))
      );
    }
    return path === (judge ? '/judge' : '/observer')
      ? route === path
      : route.startsWith(path);
  };
  return (
    <nav
      className={`bottom-nav ${judge ? 'judge-bottom-nav' : ''}`}
      aria-label="主导航"
    >
      {tabs.map(([path, label, icon]) => (
        <Link
          to={path!}
          key={path}
          current={active(path!)}
          className={active(path!) ? 'active' : ''}
        >
          <Icon name={icon!} />
          <span>{label}</span>
          {!judge && label === '消息' && unread > 0 && (
            <i
              className="unread-dot"
              aria-label={`有${unread}条未读本人消息`}
            />
          )}
        </Link>
      ))}
    </nav>
  );
}
function Sidebar() {
  const {data, route} = useApp();
  return (
    <aside className="judge-sidebar">
      <Link className="judge-brand" to="/judge">
        黑暗森林<span>赛事管理</span>
      </Link>
      <div className="sidebar-duty">{data.session!.name}</div>
      <nav>
        {JUDGE_NAV.map(group => {
          const items = group.items.filter(([area]) => judgeCan(data, area!));
          return (
            items.length > 0 && (
              <section key={group.group}>
                <p>{group.group}</p>
                {items.map(([area, label, path]) => (
                  <Link
                    key={area}
                    to={path!}
                    className={
                      (
                        path === '/judge'
                          ? route === path
                          : route.startsWith(path!)
                      )
                        ? 'active'
                        : ''
                    }
                  >
                    {label}
                    {area === 'notices' && (
                      <small className="numeric">
                        {data.judge?.notices.filter(n => n.status !== 'sent')
                          .length ?? ''}
                      </small>
                    )}
                  </Link>
                ))}
              </section>
            )
          );
        })}
      </nav>
      <Link className="sidebar-account" to="/judge/account">
        <Icon name="me" size={18} />
        裁判账号
      </Link>
    </aside>
  );
}
function Screen() {
  const {data, route, loading, go, base} = useApp();
  const feedback = useFeedbackMessages();
  const main = useRef<HTMLElement>(null);
  const judge = data.session?.role === 'judge' && route.startsWith('/judge');
  const display = route === '/display';
  const observer = route.startsWith('/observer');
  const results = route.startsWith('/results');
  useEffect(() => {
    const timer = setTimeout(() => {
      const target =
        main.current?.querySelector<HTMLElement>('.color-editor .arm-select') ??
        main.current?.querySelector<HTMLElement>('h1');
      target?.focus({preventScroll: true});
    }, 30);
    return () => clearTimeout(timer);
  }, [route]);
  useEffect(() => {
    if (data.session && (route === '/' || route === '/login')) {
      go(data.session.role === 'judge' ? '/judge' : '/player', true);
    }
  }, [data.session?.id, route, go, data.session]);
  useEffect(() => {
    if (base.startsWith('/m/') && !loading && !data.session) {
      location.replace(
        `/?audience=${route.startsWith('/judge') ? 'staff' : 'player'}`,
      );
    }
  }, [base, loading, data.session, route]);
  const allowedGlobal =
    !!data.player?.observerAllowed || data.session?.role === 'judge';
  let content: ReactNode;
  if (route === '/rules') {
    content = <Rules />;
  } else if (loading) {
    content = (
      <>
        <PageTitle title="黑暗森林" />
        <p className="empty-inline" role="status">
          正在读取比赛状态
        </p>
      </>
    );
  } else if (!data.session && base.startsWith('/m/')) {
    content = <p role="status">正在返回账号登录页</p>;
  } else if (!data.session) {
    content =
      route === '/' ? (
        <Landing />
      ) : route === '/login' ||
        /^\/(player|judge|observer|results)(\/|$)/.test(route) ||
        route === '/display' ? (
        <Login />
      ) : (
        <Empty title="页面不存在" to="/" action="返回进入页" />
      );
  } else if (display) {
    content =
      data.session.role === 'judge' ? (
        <Display />
      ) : (
        <Empty title="请由裁判登录后打开观战大屏" to="/player" />
      );
  } else if (observer) {
    content = allowedGlobal ? (
      <ObserverPages />
    ) : (
      <Empty title="宇宙观测尚未开放">
        永久淘汰满{data.parameters?.observerWaitSeconds ?? 180}
        秒后可以进入宇宙观测。
      </Empty>
    );
  } else if (results) {
    content =
      data.match?.stage === 'ended' ? (
        <ResultsPages />
      ) : (
        <Empty
          title="比赛尚未结束"
          to={data.session.role === 'judge' ? '/judge' : '/player'}
        />
      );
  } else if (route.startsWith('/judge')) {
    content = judge ? (
      data.judge ? (
        <JudgePages />
      ) : (
        <p className="empty-inline">正在读取裁判工作台</p>
      )
    ) : (
      <Empty title="当前账号不能进入裁判后台" />
    );
  } else if (route.startsWith('/player')) {
    content = data.player ? (
      <PlayerPages />
    ) : (
      <Empty title="请返回裁判工作台" to="/judge" action="返回工作台" />
    );
  } else {
    content = (
      <Empty
        title="页面不存在"
        to={data.session.role === 'judge' ? '/judge' : '/player'}
      />
    );
  }
  return (
    <div
      className={`site-shell ${judge ? 'judge-shell' : display ? 'display-shell' : 'player-shell'} ${!data.session ? 'public-shell' : ''}`}
    >
      <Atmosphere />
      {(route === '/' ||
        route === '/player' ||
        route === '/player/bracelets' ||
        display) && <Stars />}
      {judge && <Sidebar />}
      {!judge && !display && data.session && (
        <aside className="player-aside">
          <Link className="site-name" to={observer ? '/observer' : '/player'}>
            黑暗森林
          </Link>
          {data.player && (
            <Identity id={data.player.id} nickname={data.player.nickname} />
          )}
          <MatchSummary compact />
        </aside>
      )}
      <main ref={main} id="main-content" className="main-content">
        {!display && <MatchHeading />}
        <Feedback messages={feedback} />
        <div className="page-content" key={`${route}${location.search}`}>
          {content}
        </div>
      </main>
      {data.session && !display && <Navigation />}
    </div>
  );
}
/** 组合本场状态提供器与页面外壳，所有可见动作仍取决于服务端快照。 */
export function App({
  source,
  base = '',
  preview,
  epoch = 0,
  matchContext,
}: {
  source: DataSource;
  base?: string;
  preview?: ReactNode;
  epoch?: number;
  matchContext?: MatchContext;
}) {
  return (
    <MatchContextProvider value={matchContext ?? null}>
      <AppProvider source={source} base={base} epoch={epoch}>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        {preview}
        <Screen />
      </AppProvider>
    </MatchContextProvider>
  );
}
