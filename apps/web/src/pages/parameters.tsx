import {useState} from 'react';
import type {RuleParameters} from '@darkforest/contracts';
import {useApp} from '../state';
import {Field} from '../ui';
import {ManagementForm} from './judge';
const controls: Array<{
  key: keyof RuleParameters;
  label: string;
  min: number;
  max: number;
}> = [
  {key: 'singerPercent', label: '歌者每分钟清扫概率（%）', min: 0, max: 100},
  {
    key: 'firstLockSeconds',
    label: '第一次提交错误目击码后禁止攻击的时长（秒）',
    min: 1,
    max: 86400,
  },
  {
    key: 'secondLockSeconds',
    label: '第二次提交错误目击码后禁止攻击的时长（秒）',
    min: 1,
    max: 86400,
  },
  {
    key: 'secondOutPercent',
    label: '第二次提交错误目击码后淘汰的概率（%）',
    min: 0,
    max: 100,
  },
  {key: 'respawnSeconds', label: '完成重生的总时限（秒）', min: 1, max: 86400},
  {
    key: 'observerWaitSeconds',
    label: '永久淘汰后等待观战的时长（秒）',
    min: 0,
    max: 86400,
  },
  {
    key: 'sightingIntervalMs',
    label: '两次目击提交的最短间隔（毫秒）',
    min: 1,
    max: 60000,
  },
  {
    key: 'sightingsPerMinute',
    label: '每分钟最多提交目击的次数',
    min: 1,
    max: 120,
  },
];
/** 编辑赛前规则参数并预览；锁定状态以服务端为准。 */
export function ParametersSettings() {
  const {data} = useApp();
  const config = data.judge?.parameters;
  const [draft, setDraft] = useState<RuleParameters | null>(null);
  if (!config) {
    return null;
  }
  const values = draft ?? config.values;
  const valid = controls.every(
    ({key, min, max}) =>
      Number.isSafeInteger(values[key]) &&
      values[key] >= min &&
      values[key] <= max,
  );
  return (
    <section>
      <h2>比赛参数</h2>
      <p className="secondary">锁定统一发码时间后，比赛参数保持不变。</p>
      {controls.map(({key, label, min, max}) => (
        <Field key={key} label={label}>
          <input
            type="number"
            min={min}
            max={max}
            step={1}
            value={values[key]}
            disabled={config.locked}
            onChange={event =>
              setDraft({...values, [key]: Number(event.target.value)})
            }
          />
        </Field>
      ))}
      {config.locked ? (
        <p>本场参数已锁定。</p>
      ) : (
        <ManagementForm
          title="保存比赛参数"
          path="/judge/parameters"
          payload={{values, expected_version: config.version}}
          ready={valid}
        />
      )}
    </section>
  );
}
/** 编辑正式参赛名单，账号池与本场正式文明资格保持区分。 */
export function RosterSettings() {
  const {data} = useApp();
  const config = data.judge?.roster;
  const [members, setMembers] = useState<string[] | null>(null);
  if (!config) {
    return null;
  }
  const selected = members ?? config.members;
  const n = selected.length;
  const techCount = Math.min(
    Math.max(1, Math.round(n / 3)),
    Math.floor((n - 1) / 2),
  );
  return (
    <section>
      <h2>参赛人数与正式名单</h2>
      <p>
        参赛人数 N：{n}人。预注册账号共{config.accounts.length}
        个，本场技术爆炸共
        {n >= 2 ? techCount : '待确认'}次。
      </p>
      <div className="permission-list">
        {config.accounts.map(a => (
          <label className="check-label" key={a.id}>
            <input
              type="checkbox"
              checked={selected.includes(a.id)}
              disabled={config.locked || !a.eligible}
              onChange={event =>
                setMembers(
                  event.target.checked
                    ? [...selected, a.id].sort()
                    : selected.filter(id => id !== a.id),
                )
              }
            />
            {a.nickname ? `${a.id}（${a.nickname}）` : a.id}
          </label>
        ))}
      </div>
      {config.locked ? (
        <p>本场正式名单已锁定。</p>
      ) : (
        <ManagementForm
          title="保存正式名单"
          path="/judge/roster"
          payload={{members: selected}}
          ready={n >= 2 && n <= 350}
        />
      )}
    </section>
  );
}
