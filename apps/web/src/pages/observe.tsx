import { useEffect, useState } from 'react';
import { FLIGHT_NAMES, STAGE_NAMES, type Civilization } from '@darkforest/contracts';
import { useApp } from '../state';
import { OBSERVER_AGREEMENT_COPY } from '../../../../packages/contracts/src/message-copy';
import {
  ArmsView,
  Button,
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

export function CivilizationList({
  prefix,
  onlyAlive = false,
}: {
  prefix: string;
  onlyAlive?: boolean;
}) {
  const { data } = useApp();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const list = data.civilizations.filter(
    (c) =>
      (!onlyAlive || c.flight !== 'eliminated') &&
      `${c.id}${c.nickname}`.toLowerCase().includes(search.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'alive' ? c.flight !== 'eliminated' : c.flight === 'eliminated')),
  );
  return (
    <>
      <div className="list-filters">
        <Field label="查找文明">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="文明编号或昵称"
          />
        </Field>
        {!onlyAlive && (
          <Field label="文明状态">
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">全部状态</option>
              <option value="alive">仍然存活</option>
              <option value="eliminated">永久淘汰</option>
            </select>
          </Field>
        )}
      </div>
      <div className="civilization-list">
        {list.map((c) => (
          <Link to={`${prefix}/${c.id}`} className="civilization-row" key={c.id}>
            <Identity id={c.id} nickname={c.nickname} />
            <div className="civilization-state">
              <span>{FLIGHT_NAMES[c.flight]}</span>
              <small>母星{c.homeAlive ? '尚存' : '已毁灭'}</small>
            </div>
            <MiniArms arms={c.arms} />
            <Icon name="arrow" size={18} />
          </Link>
        ))}
      </div>
      {!list.length && <p className="empty-inline">没有符合条件的文明。</p>}
    </>
  );
}
export function CivilizationDetail({
  civilization: c,
  back,
  title = '文明详情',
}: {
  civilization: Civilization | undefined;
  back: string;
  title?: string;
}) {
  const { data } = useApp();
  const [tab, setTab] = useState('current');
  return (
    <>
      <PageTitle title={title} back={back} />
      {!c ? (
        <Empty title="文明不存在或无查看权限" to={back} />
      ) : (
        <>
          <div className="profile-heading">
            <Identity id={c.id} nickname={c.nickname} />
            <Status tone={c.flight === 'eliminated' ? 'danger' : ''}>
              {FLIGHT_NAMES[c.flight]}
            </Status>
          </div>
          <Tabs
            tabs={[
              { id: 'current', label: '当前状态' },
              { id: 'voyages', label: '航次记录' },
              { id: 'events', label: '相关事件' },
            ]}
            active={tab}
            onChange={setTab}
          />
          {tab === 'current' ? (
            <>
              <div className="detail-stats">
                <div>
                  <span>已审核母星口令</span>
                  <strong className="numeric">{c.homeworld ?? '未登记'}</strong>
                  <small>母星{c.homeAlive ? '尚存' : '已毁灭'}</small>
                </div>
                <div>
                  <span>已击毁的不同文明数</span>
                  <strong className="numeric">{c.kills}</strong>
                </div>
                <div>
                  <span>剩余广播次数</span>
                  <strong className="numeric">{c.broadcasts}</strong>
                </div>
                <div>
                  <span>光粒库存</span>
                  <strong className="numeric">{c.photons}</strong>
                </div>
              </div>
              {c.respawnDeadline && <Timer label="距离重生截止" deadline={c.respawnDeadline} />}
              {c.arms ? (
                <>
                  <h2>本航次手环</h2>
                  <ArmsView arms={c.arms} />
                </>
              ) : (
                <p className="secondary">当前没有可用的手环配置。</p>
              )}
            </>
          ) : tab === 'voyages' ? (
            <div className="voyage-list">
              {c.voyages.map((v) => (
                <Frame key={v.number}>
                  <div className="heading-row">
                    <h2>第{v.number}航次</h2>
                    <Status>{v.endMs === null ? '使用中' : '已失效'}</Status>
                  </div>
                  <MiniArms arms={v.arms} />
                  <p className="secondary">
                    生效时间{formatTime(v.startMs)}
                    {v.endMs !== null && `，失效时间${formatTime(v.endMs)}`}
                  </p>
                </Frame>
              ))}
            </div>
          ) : (
            <Events
              events={data.events
                .filter((e) => e.civilizationIds.includes(c.id))
                .map((e) => (e.actor ? { ...e, body: `${e.body} 发起者：${e.actor}` } : e))}
            />
          )}
        </>
      )}
    </>
  );
}
function Overview() {
  const { data } = useApp();
  const match = data.match!;
  return (
    <>
      <PageTitle title="宇宙观测" aside={<Status>四维观察者</Status>} />
      <MatchSummary />
      <p className="observer-intro">
        你的意识已进入四维世界。你可以观察宇宙、与其他四维文明交流，并向裁判提出高维干涉建议。
      </p>
      <div className="overview-stats">
        <Link to="/observer/civilizations">
          <strong className="numeric">{match.survivors}</strong>
          <span>存活文明</span>
          <Icon name="arrow" size={18} />
        </Link>
        <Link to="/observer/civilizations">
          <strong className="numeric">{match.total - match.survivors}</strong>
          <span>已淘汰文明</span>
          <Icon name="arrow" size={18} />
        </Link>
        <Link to="/observer/civilizations">
          <strong className="numeric">{match.homeworldsAlive}</strong>
          <span>尚存母星</span>
          <Icon name="arrow" size={18} />
        </Link>
      </div>
      <h2>最近发生</h2>
      <Events
        events={data.events
          .slice(0, 5)
          .map((e) => (e.actor ? { ...e, body: `${e.body} 发起者：${e.actor}` } : e))}
      />
      <p className="notice-block">{OBSERVER_AGREEMENT_COPY}</p>
    </>
  );
}
export function EventExplorer({ title = '赛事事件', back }: { title?: string; back?: string }) {
  const { data } = useApp();
  const [type, setType] = useState('all');
  const [civilization, setCivilization] = useState('');
  const events = data.events.filter(
    (e) =>
      (type === 'all' || e.kind === type) &&
      (!civilization ||
        e.civilizationIds.some((id) => id.toLowerCase().includes(civilization.toLowerCase()))),
  );
  return (
    <>
      <PageTitle title={title} {...(back ? { back } : {})} />
      <Disclosure title="筛选赛事事件">
        <div className="list-filters">
          <Field label="事件类别">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {[
                ['all', '全部事件'],
                ['sighting', '目击攻击'],
                ['broadcast', '广播'],
                ['photon', '光粒'],
                ['singer', '歌者'],
                ['respawn', '重生'],
                ['tech', '技术爆炸'],
                ['stage', '阶段变化'],
              ].map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="相关文明">
            <input
              value={civilization}
              placeholder="例如C07"
              onChange={(e) => setCivilization(e.target.value)}
            />
          </Field>
        </div>
      </Disclosure>
      <Events
        events={events.map((e) => (e.actor ? { ...e, body: `${e.body} 发起者：${e.actor}` } : e))}
      />
    </>
  );
}
export function ObserverPages() {
  const { route, data } = useApp();
  const id = route.split('/')[3];
  if (route === '/observer') return <Overview />;
  if (route === '/observer/events') return <EventExplorer />;
  if (route === '/observer/civilizations')
    return (
      <>
        <PageTitle title="文明" />
        <CivilizationList prefix="/observer/civilizations" />
      </>
    );
  if (route.startsWith('/observer/civilizations/') && id)
    return (
      <CivilizationDetail
        civilization={data.civilizations.find((c) => c.id === id)}
        back="/observer/civilizations"
      />
    );
  return <Empty title="页面不存在" to="/observer" />;
}
export function ResultsPages() {
  const { data, route } = useApp();
  const results = data.results;
  if (!results)
    return (
      <>
        <PageTitle title="比赛结果" />
        <Empty title="当前尚无正式结果" to={data.session?.role === 'judge' ? '/judge' : '/player'}>
          比赛结束后可以查看结果和完整战报。
        </Empty>
      </>
    );
  if (route === '/results/events') return <EventExplorer title="完整战报" back="/results" />;
  if (route.startsWith('/results/civilizations/'))
    return (
      <CivilizationDetail
        civilization={data.civilizations.find((c) => c.id === route.split('/')[3])}
        back="/results"
        title="文明复盘"
      />
    );
  return (
    <>
      <PageTitle
        title="比赛结果"
        back={data.session?.role === 'judge' ? '/judge' : '/player'}
        aside={<span className="secondary">报告第{results.version}版</span>}
      />
      <div className="result-hero">
        <span className="eyebrow">{results.champions.length ? '本场冠军' : '比赛已结束'}</span>
        <h2>
          {results.champions.length
            ? results.champions
                .map((id) => data.civilizations.find((c) => c.id === id)?.nickname ?? id)
                .join('、')
            : '本场没有存活冠军'}
        </h2>
        {results.champions.map((id) => (
          <span className="numeric champion-id" key={id}>
            {id}
          </span>
        ))}
        <p>{results.reason}</p>
      </div>
      <Link className="row-link" to="/results/events">
        完整赛事战报
        <Icon name="arrow" size={20} />
      </Link>
      <h2>完整名次</h2>
      <div className="standings">
        {results.standings.map((c) => (
          <Link to={`/results/civilizations/${c.id}`} key={c.id} className="standing">
            <span className="rank numeric">
              {c.tied ? '并列' : ''}
              {c.rank}
            </span>
            <Identity id={c.id} nickname={c.nickname} />
            <span>
              {c.flight === 'eliminated' ? '已淘汰' : '存活'}
              <small>击毁{c.kills}个不同文明</small>
            </span>
            <Icon name="arrow" size={18} />
          </Link>
        ))}
      </div>
    </>
  );
}
export function Display() {
  const { data, reduced } = useApp();
  const [tab, setTab] = useState('overview');
  const [page, setPage] = useState(0);
  const [auto, setAuto] = useState(false);
  const [seconds, setSeconds] = useState(12);
  const match = data.match!;
  const count = Math.max(1, Math.ceil(data.civilizations.length / 8));
  useEffect(() => {
    if (!auto || reduced || document.hidden) return;
    const timer = setInterval(() => setPage((p) => (p + 1) % count), seconds * 1000);
    return () => clearInterval(timer);
  }, [auto, seconds, reduced, count]);
  return (
    <div className="display-content">
      <header className="display-header">
        <h1>宇宙观测</h1>
        <MatchSummary compact />
        <span className="display-survivors">
          <strong className="numeric">{match.survivors}</strong> 个文明存活
        </span>
      </header>
      <Tabs
        tabs={[
          { id: 'overview', label: '全场概况' },
          { id: 'civilizations', label: '文明状态' },
          { id: 'events', label: '赛事事件' },
          ...(match.stage === 'ended' ? [{ id: 'results', label: '比赛结果' }] : []),
        ]}
        active={tab}
        onChange={(t) => {
          setTab(t);
          setPage(0);
        }}
      />
      {tab === 'overview' ? (
        <>
          <div className="display-numbers">
            <div>
              <strong className="numeric">{match.survivors}</strong>
              <span>存活文明</span>
            </div>
            <div>
              <strong className="numeric">{match.total - match.survivors}</strong>
              <span>已淘汰文明</span>
            </div>
            <div>
              <strong className="numeric">{match.homeworldsAlive}</strong>
              <span>尚存母星</span>
            </div>
          </div>
          <Events events={data.events.filter((e) => e.audience !== 'personal').slice(0, 3)} />
        </>
      ) : tab === 'events' ? (
        <Events
          events={data.events
            .slice(page * 5, page * 5 + 5)
            .map((e) => (e.actor ? { ...e, body: `${e.body} 发起者：${e.actor}` } : e))}
        />
      ) : tab === 'results' ? (
        <div className="display-result">
          <h2>
            {data.results?.champions.length
              ? data.results.champions
                  .map((id) => data.civilizations.find((c) => c.id === id)?.nickname)
                  .join('、')
              : '本场没有存活冠军'}
          </h2>
          <p>{data.results?.reason}</p>
        </div>
      ) : (
        <div className="display-grid">
          {data.civilizations.slice(page * 8, page * 8 + 8).map((c) => (
            <Frame key={c.id}>
              <Identity id={c.id} nickname={c.nickname} />
              <Status>{FLIGHT_NAMES[c.flight]}</Status>
              <p>母星{c.homeAlive ? '尚存' : '已毁灭'}</p>
              <MiniArms arms={c.arms} />
            </Frame>
          ))}
        </div>
      )}
      {['civilizations', 'events'].includes(tab) && (
        <div className="pagination">
          <Button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
            上一页
          </Button>
          <span>第{page + 1}页</span>
          <Button
            onClick={() => setPage((p) => p + 1)}
            disabled={
              (page + 1) * (tab === 'events' ? 5 : 8) >=
              (tab === 'events' ? data.events.length : data.civilizations.length)
            }
          >
            下一页
          </Button>
          {!reduced && (
            <label className="check-label">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              自动轮播
            </label>
          )}
          {auto && (
            <label>
              每页{' '}
              <select
                aria-label="轮播停留秒数"
                value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
              >
                <option value={12}>12秒</option>
                <option value={20}>20秒</option>
                <option value={30}>30秒</option>
              </select>
            </label>
          )}
        </div>
      )}
      <footer className="display-footer">
        <span>{STAGE_NAMES[match.stage]}，仅展示已发生赛事</span>
        <time>
          最近更新{' '}
          {new Date(match.serverUtcMs).toLocaleTimeString('zh-CN', {
            timeZone: data.site.timezone,
          })}
        </time>
      </footer>
    </div>
  );
}
