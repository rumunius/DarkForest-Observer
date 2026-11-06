import {useEffect, useState} from 'react';
import {personalMessage} from '../../data/messages';
import {canAct} from '../../permissions';
import {useApp} from '../../state';
import {
  CopyText,
  Empty,
  Events,
  formatTime,
  Frame,
  Icon,
  Identity,
  Link,
  PageTitle,
  Status,
  Tabs,
} from '../../ui';

/** 展示本人可见的赛事消息和阅读状态，QQ实际发送另外记录。 */
export function Messages() {
  const {data, route, markRead} = useApp();
  const [tab, setTab] = useState('personal');
  const detailId = route.split('/')[3];
  const event = data.events.find(e => e.id === detailId);
  useEffect(() => {
    if (event) {
      markRead(event.id);
    } else if (!detailId && tab === 'personal') {
      data.events
        .filter(item =>
          personalMessage(item, data.player?.id ?? data.session?.id),
        )
        .forEach(item => markRead(item.id));
    }
  }, [
    event,
    detailId,
    tab,
    data.events,
    data.player?.id,
    data.session?.id,
    markRead,
  ]);
  if (detailId) {
    return (
      <>
        <PageTitle title="消息详情" back="/player/messages" />
        {event ? (
          <>
            <Status>
              {event.audience === 'personal' ? '本人消息' : '公开事件'}
            </Status>
            <h2>{event.title}</h2>
            <p className="message-body">{event.body}</p>
            {event.code && <p className="secret-code numeric">{event.code}</p>}
            <p className="secondary">
              发生于比赛时间{formatTime(event.gameMs)}
            </p>
          </>
        ) : (
          <Empty
            title="消息不存在或无查看权限"
            to="/player/messages"
            action="返回消息"
          />
        )}
      </>
    );
  }
  const events = data.events.filter(e =>
    tab === 'personal'
      ? personalMessage(e, data.player?.id ?? data.session?.id)
      : tab === 'broadcast'
        ? e.kind === 'broadcast'
        : e.audience === 'public',
  );
  return (
    <>
      <PageTitle title="消息" />
      <Link className="row-link" to="/player/intel">
        母星坐标情报箱
        <Icon name="arrow" size={18} />
      </Link>
      <Tabs
        tabs={[
          {id: 'personal', label: '本人消息'},
          {id: 'public', label: '公开事件'},
          {id: 'broadcast', label: '宇宙广播'},
        ]}
        active={tab}
        onChange={setTab}
      />
      <Events events={events} detailsPrefix="/player/messages" />
    </>
  );
}

/** 展示本人获准取得的秘密情报及其来源，不推断未披露信息。 */
export function Intel() {
  const {data} = useApp();
  return (
    <>
      <PageTitle title="母星坐标情报箱" back="/player/messages" />
      {data.intel.length ? (
        data.intel.map(intel => (
          <Frame key={intel.id}>
            <Identity id={intel.civilization} nickname={intel.nickname} />
            <p className="secret-code numeric">{intel.code}</p>
            <p className="secondary">
              {intel.source}，比赛时间{formatTime(intel.gameMs)}
            </p>
            <CopyText text={intel.code} label="复制六位口令" />
            {canAct(data, 'broadcast') && (
              <Link
                className="text-link"
                to={`/player/actions/broadcast?code=${intel.code}`}
              >
                用于广播
                <Icon name="arrow" size={18} />
              </Link>
            )}
          </Frame>
        ))
      ) : (
        <p className="empty-inline">尚未获得母星情报。</p>
      )}
    </>
  );
}
