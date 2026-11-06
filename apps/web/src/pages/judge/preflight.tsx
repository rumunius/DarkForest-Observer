import {FLIGHT_NAMES} from '@darkforest/contracts';
import {useState} from 'react';
import {judgeCan} from '../../permissions';
import {useApp} from '../../state';
import {
  Button,
  Empty,
  Field,
  Frame,
  Icon,
  Identity,
  Link,
  MiniArms,
  PageTitle,
  Tabs,
} from '../../ui';
import {RosterSettings} from '../parameters';
import {ManagementForm} from './management_form';

/** 绑定母星审核版本与口令核对，防止对过时登记作出裁决。 */
export function HomeworldReview() {
  const {data, operate, busy} = useApp();
  const pending = data.civilizations.filter(c => c.flight === 'pending');
  const [id, setId] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [returning, setReturning] = useState(false);
  const civilization = pending.find(c => c.id === id) ?? pending[0];
  return (
    <>
      <PageTitle title="母星审核" />
      <p className="secondary">
        在QQ与高德地图软件中核对当前版本、照片及母星互不重复的要求。
      </p>
      {!civilization ? (
        <Empty title="当前没有待审核母星" to="/judge" action="返回工作台" />
      ) : (
        <div className="master-detail">
          <div className="master-list">
            {pending.map(item => (
              <button
                className={item.id === civilization.id ? 'selected' : ''}
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
            <Identity id={civilization.id} nickname={civilization.nickname} />
            <p className="secret-code numeric">{civilization.homeworld}</p>
            <p>正在核对第{civilization.homeVersion}次提交的口令。</p>
            <label className="check-label large">
              <input
                type="checkbox"
                checked={confirm}
                onChange={e => setConfirm(e.target.checked)}
              />
              已核对QQ中的当前版本、照片与地点
            </label>
            {confirm && (
              <Button
                className="primary full"
                disabled={busy}
                onClick={() =>
                  void operate(`/judge/homeworld/${civilization.id}/verify`, {
                    expected_version: civilization.homeVersion,
                    expected_code: civilization.homeworld,
                    decision: 'approve',
                  })
                }
              >
                审核通过
                <Icon name="check" size={18} />
              </Button>
            )}
            <button
              className="text-button attention"
              onClick={() => setReturning(!returning)}
            >
              退回修改
            </button>
            {returning && (
              <>
                <Field label="具体退回原因">
                  <textarea
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    rows={3}
                  />
                </Field>
                <Button
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    void operate(`/judge/homeworld/${civilization.id}/verify`, {
                      expected_version: civilization.homeVersion,
                      expected_code: civilization.homeworld,
                      decision: 'reject',
                      reason,
                    })
                  }
                >
                  确认退回修改
                </Button>
              </>
            )}
          </Frame>
        </div>
      )}
    </>
  );
}

/** 核对正式名单和就绪状态后安排未来T0或T1，发码不等于开放攻防。 */
export function PreflightManagement() {
  const {data} = useApp();
  const [time, setTime] = useState('');
  const [mode, setMode] = useState('release');
  const roster = data.civilizations;
  const ready =
    mode === 'release'
      ? roster.every(c => ['staged', 'outfitting', 'ready'].includes(c.flight))
      : roster.every(c => c.flight === 'ready');
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
            {roster.map(civilization => (
              <tr key={civilization.id}>
                <td>
                  <Identity
                    id={civilization.id}
                    nickname={civilization.nickname}
                  />
                </td>
                <td>
                  {['pending', 'unregistered', 'rejected'].includes(
                    civilization.flight,
                  )
                    ? '未审核通过'
                    : '已通过'}
                </td>
                <td>{FLIGHT_NAMES[civilization.flight]}</td>
                <td>
                  <MiniArms arms={civilization.arms} />
                </td>
                <td>
                  <Link to={`/judge/players/${civilization.id}`}>查看</Link>
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
                {id: 'release', label: '安排发码时间'},
                {id: 'start', label: '安排开赛时间'},
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
                path={
                  mode === 'release'
                    ? '/judge/arm-code-release'
                    : '/judge/arm-start'
                }
                payload={{
                  time: new Date(time).getTime(),
                  expected_roster: roster.map(c => c.id),
                }}
                ready={!!time && new Date(time).getTime() > Date.now()}
              >
                <Field label="未来的统一时间">
                  <input
                    type="datetime-local"
                    value={time}
                    onChange={e => setTime(e.target.value)}
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
