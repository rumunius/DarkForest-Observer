import { useState } from 'react';
import { useApp } from '../state';
import { judgeCan } from '../permissions';
import { Disclosure, Field, Frame, formatTime } from '../ui';
import { ManagementForm } from './judge';

const names: Record<string, string> = {
  song_visit: '歌者清理',
  tech_burst: '技术爆炸',
  judge_delayed_command: '延迟公告',
  judge_command_task: '裁判定时任务',
  code_release: '统一发码',
  match_start: '统一开赛',
  respawn_timeout: '重生到期',
  apocalypse: '宇宙末日',
  transfer_start: '转场',
  hunt_cutoff: '终局核验',
  regulation_end: '常规完赛',
};
export function ScheduledEvents() {
  const { data } = useApp();
  const [selected, setSelected] = useState('');
  const [code, setCode] = useState('');
  if (!judgeCan(data, 'system')) return null;
  const events = data.judge?.scheduledEvents ?? [];
  const event =
    events.find((event) => event.id === selected) ??
    events.find((event) => event.lastError && event.status === 'pending') ??
    events[0];
  return (
    <section>
      <h2>赛事计划与故障处置</h2>
      <p className="secondary">
        未来计划仅供总裁判核查。故障时先暂停，核对原因后取消或重试；已取消事件不能重开。
      </p>
      {data.judge?.scheduler.error && (
        <p role="alert" className="attention notice-block">
          {data.judge.scheduler.error}
        </p>
      )}
      <Field label="选择计划事件">
        <select value={event?.id ?? ''} onChange={(e) => setSelected(e.target.value)}>
          {events.map((event) => (
            <option key={event.id} value={event.id}>
              {names[event.kind] ?? event.kind}，
              {event.status === 'pending'
                ? '待执行'
                : event.status === 'settled'
                  ? '已结算'
                  : '已取消'}{' '}
              ，编号 {event.id}
            </option>
          ))}
        </select>
      </Field>
      {event && (
        <Frame>
          <h3>{names[event.kind] ?? event.kind}</h3>
          <p>
            原定生效时间：
            {event.clock === 'game'
              ? `有效时间 ${formatTime(event.due)}`
              : new Date(event.due).toLocaleString('zh-CN')}
          </p>
          <p>执行尝试：{event.attempts}次</p>
          {event.lastAttemptUtcMs && (
            <p>最近尝试：{new Date(event.lastAttemptUtcMs).toLocaleString('zh-CN')}</p>
          )}
          {event.lastError && <p className="attention">{event.lastError}</p>}
          <Disclosure title="事件详情">
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(event, null, 2)}
            </pre>
          </Disclosure>
          {event.status === 'pending' && (
            <>
              <ManagementForm
                key={`${event.id}:retry`}
                title="重试原事件"
                path="/judge/event-control"
                payload={{ event_id: event.id, operation: 'retry' }}
              />
              {['song_visit', 'tech_burst', 'judge_delayed_command'].includes(event.kind) &&
                data.match?.paused && (
                  <ManagementForm
                    key={`${event.id}:cancel`}
                    title="取消待执行事件"
                    path="/judge/event-control"
                    payload={{ event_id: event.id, operation: 'cancel' }}
                  />
                )}
            </>
          )}
        </Frame>
      )}
      {data.match?.paused && data.match.stage === 'forest' && (
        <ManagementForm
          title="手动歌者清理"
          path="/judge/event-trigger"
          payload={{ kind: 'song_visit', code }}
          ready={/^\d{6}$/.test(code)}
        >
          <Field label="清理坐标（六位数字）">
            <input
              inputMode="numeric"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        </ManagementForm>
      )}
    </section>
  );
}
