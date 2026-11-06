import {useState} from 'react';
import {useApp} from '../../state';
import {
  Button,
  CopyText,
  Field,
  Frame,
  Icon,
  PageTitle,
  Status,
  Tabs,
  formatTime,
} from '../../ui';
import {RecordPagination} from '../record_pagination';

/** 展示通知队列并分别记录复制、QQ实际发送和异常处置。 */
export function Notices() {
  const {data, operate, busy} = useApp();
  const [channel, setChannel] = useState('private');
  const [filter, setFilter] = useState('todo');
  const [id, setId] = useState(
    new URLSearchParams(location.search).get('notice') ?? '',
  );
  const [reason, setReason] = useState('');
  const [showError, setShowError] = useState(false);
  const queue = new Map(data.judge!.notices.map(n => [n.id, n]));
  for (const task of data.judge!.noticeTasks ?? []) {
    queue.set(task.id, task);
  }
  const notices = [...queue.values()]
    .filter(
      n =>
        n.channel === channel &&
        (filter === 'todo'
          ? n.status !== 'sent'
          : filter === 'all' || n.status === filter),
    )
    .sort(
      (a, b) =>
        Number(a.status === 'sent') - Number(b.status === 'sent') ||
        (b.priority ?? 0) - (a.priority ?? 0) ||
        a.gameMs - b.gameMs,
    );
  const n = notices.find(n => n.id === id) ?? notices[0];
  const statusNames = {
    pending: '待发送',
    copied: '已复制',
    sent: '已发送',
    error: '需要处理',
  };
  return (
    <>
      <PageTitle title="通知待办" />
      <p className="secondary">
        全场尚有
        {data.judge!.noticePendingCount ??
          notices.filter(n => n.status !== 'sent').length}
        条通知未发送；优先处理淘汰、失联和母星毁灭提醒。
      </p>
      <RecordPagination kind="notices" />
      <Tabs
        tabs={[
          {id: 'private', label: '玩家私聊'},
          {id: 'group', label: '群公告'},
        ]}
        active={channel}
        onChange={setChannel}
      />
      <Field label="处理状态">
        <select value={filter} onChange={e => setFilter(e.target.value)}>
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
            {notices.map(item => (
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
              <Status tone={n.status !== 'sent' ? 'attention' : ''}>
                {statusNames[n.status]}
              </Status>
            </div>
            <p>收件人：{n.target}</p>
            <p className="secondary">
              最近处理人：{n.operator || '尚未处理'}，第{n.version}版
            </p>
            {n.copiedUtcMs && (
              <p className="secondary">
                复制：{n.copiedBy}，
                {new Date(n.copiedUtcMs).toLocaleString('zh-CN')}
              </p>
            )}
            {n.sentUtcMs && (
              <p className="secondary">
                发送：{n.sentBy}，
                {new Date(n.sentUtcMs).toLocaleString('zh-CN')}
              </p>
            )}
            {n.error && <p className="attention">发送异常：{n.error}</p>}
            <CopyText
              text={n.body}
              label="复制消息"
              onCopied={() => {
                if (n.status !== 'sent') {
                  void operate(`/judge/notices/${n.id}/copied`, {
                    expected_version: n.version,
                  });
                }
              }}
            />
            {n.status !== 'sent' && (
              <>
                <p>在QQ实际发送后，再记录发送状态。</p>
                <Button
                  className="primary full"
                  disabled={busy}
                  onClick={() =>
                    void operate(`/judge/notices/${n.id}/sent`, {
                      expected_version: n.version,
                    })
                  }
                >
                  标记已发送
                  <Icon name="check" size={18} />
                </Button>
                <button
                  className="text-button"
                  onClick={() => setShowError(!showError)}
                >
                  记录发送异常
                </button>
                {showError && (
                  <>
                    <Field label="异常原因">
                      <textarea
                        value={reason}
                        onChange={e => setReason(e.target.value)}
                      />
                    </Field>
                    <Button
                      disabled={busy || !reason.trim()}
                      onClick={() =>
                        void operate(`/judge/notices/${n.id}/error`, {
                          expected_version: n.version,
                          reason,
                        })
                      }
                    >
                      保存发送异常
                    </Button>
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
