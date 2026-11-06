import {judgeCan} from '../../permissions';
import {useApp} from '../../state';
import {Events, Icon, Link, MatchSummary, PageTitle, Status} from '../../ui';

/** 根据当前裁判职责展示赛事摘要与待办，隐藏无权限操作入口。 */
export function Dashboard() {
  const {data, base} = useApp();
  const judge = data.judge!;
  const match = data.match!;
  const cards = [
    {
      label: '正式参赛文明',
      value: match.total,
      to: '/judge/players',
      area: 'players',
    },
    {
      label: '存活文明',
      value: match.survivors,
      to: '/judge/players',
      area: 'players',
    },
    {
      label: '母星待审核',
      value: data.civilizations.filter(c => c.flight === 'pending').length,
      to: '/judge/homeworlds',
      area: 'homeworlds',
    },
    {
      label: '待发送通知',
      value:
        judge.noticePendingCount ??
        judge.notices.filter(n => n.status !== 'sent').length,
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
          <a
            className="text-link"
            href={`${base}/display`}
            target="_blank"
            rel="noreferrer"
          >
            打开观战大屏
            <Icon name="arrow" size={18} />
          </a>
        </div>
      </div>
      <div className="dashboard-metrics">
        {cards
          .filter(c => judgeCan(data, c.area))
          .map(c => (
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
            .filter(n => n.status !== 'sent')
            .slice(0, 4)
            .map(n => (
              <Link
                key={n.id}
                to={`/judge/notices?notice=${n.id}`}
                className="task-row"
              >
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
                剩余可发行配置{' '}
                <strong className="numeric">{350 - judge.issuedCodes}</strong>组
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
