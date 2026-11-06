import {judgeCan} from '../permissions';
import {useApp} from '../state';
import {Empty, Icon, Link, PageTitle} from '../ui';
import {AuditEntries} from './judge/audit';
import {ClockManagement, EndgameManagement} from './judge/clock';
import {Dashboard} from './judge/dashboard';
import {Effects} from './judge/effects';
import {JUDGE_NAV} from './judge/navigation';
import {Notices} from './judge/notices';
import {
  AttackReview,
  Equipment,
  PlayerManagement,
} from './judge/player_management';
import {HomeworldReview, PreflightManagement} from './judge/preflight';
import {ResultsManagement} from './judge/results';
import {JudgeAccount, Settings} from './judge/settings';
import {Commands, SystemStatus} from './judge/system';
import {CivilizationList, EventExplorer} from './observe';
import {ScheduledEvents} from './scheduled_events';
export {ManagementForm} from './judge/management_form';

/** 按本场路径与职责分派裁判页面，不因直接访问地址绕过页面门禁。 */
export function JudgePages() {
  const {route, data} = useApp();
  const area =
    route === '/judge' ? 'overview' : (route.split('/')[2] ?? 'overview');
  if (area === 'more') {
    return (
      <>
        <PageTitle title="更多赛事管理" />
        {JUDGE_NAV.map(g => (
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
  }
  if (!judgeCan(data, area === 'commands' ? 'overview' : area)) {
    return (
      <>
        <PageTitle title="当前职责无此权限" />
        <Empty
          title="当前账号不能执行这项操作"
          to="/judge"
          action="返回工作台"
        />
      </>
    );
  }
  if (route === '/judge') {
    return <Dashboard />;
  }
  if (area === 'homeworlds') {
    return <HomeworldReview />;
  }
  if (area === 'preflight') {
    return <PreflightManagement />;
  }
  if (area === 'notices') {
    return <Notices />;
  }
  if (area === 'players') {
    const id = route.split('/')[3];
    const c = data.civilizations.find(c => c.id === id);
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
  if (area === 'endgame') {
    return <EndgameManagement />;
  }
  if (area === 'clock') {
    return <ClockManagement />;
  }
  if (area === 'events') {
    return (
      <>
        <ScheduledEvents />
        <EventExplorer />
      </>
    );
  }
  if (area === 'effects') {
    return <Effects />;
  }
  if (area === 'attacks') {
    return <AttackReview />;
  }
  if (area === 'equipment') {
    return <Equipment />;
  }
  if (area === 'commands') {
    return <Commands />;
  }
  if (area === 'system') {
    return <SystemStatus />;
  }
  if (area === 'audit') {
    return (
      <>
        <PageTitle title="操作记录" />
        <AuditEntries />
      </>
    );
  }
  if (area === 'settings') {
    return <Settings />;
  }
  if (area === 'results') {
    return <ResultsManagement />;
  }
  if (area === 'account') {
    return <JudgeAccount />;
  }
  return <Empty title="页面不存在" to="/judge" />;
}
export {JUDGE_NAV} from './judge/navigation';
