import {useState} from 'react';
import {useApp} from '../../state';
import {Field, Frame, PageTitle, Status, Timer} from '../../ui';
import {ManagementForm} from './management_form';

/** 展示和管理带UTC期限的临时效果，个人处罚和阶段限制分别生效。 */
export function Effects() {
  const {data} = useApp();
  const [target, setTarget] = useState('@a');
  const [seconds, setSeconds] = useState('60');
  const durationSeconds = Number(seconds);
  const validDuration =
    Number.isSafeInteger(durationSeconds) &&
    durationSeconds >= 1 &&
    durationSeconds <= 86400;
  return (
    <>
      <PageTitle title="临时效果" />
      <p>
        临时禁止目击攻击不冻结比赛时间，也不解除其他阶段限制或个人错误提交处罚。
      </p>
      {data.judge!.effects.map(effect => (
        <Frame key={effect.id}>
          <div className="heading-row">
            <h2>{effect.target}</h2>
            <Status>{effect.active ? '正在生效' : '已结束'}</Status>
          </div>
          <p>{effect.reason}</p>
          <p className="secondary">操作者：{effect.operator}</p>
          {effect.active && (
            <>
              <Timer
                label="效果剩余真实时间"
                deadline={effect.untilUtcMs}
                clock="utc"
              />
              <ManagementForm
                title="撤销本条效果"
                path="/judge/effects"
                payload={{revoke: effect.id}}
                change="仅撤销这条效果，其他限制仍按各自规则生效"
              />
            </>
          )}
        </Frame>
      ))}
      <ManagementForm
        title="建立临时禁止目击攻击"
        path="/judge/effects"
        payload={{target, seconds: durationSeconds}}
        ready={!!target && validDuration}
      >
        <Field label="目标范围">
          <select value={target} onChange={e => setTarget(e.target.value)}>
            <option value="@a">全场正式参赛者</option>
            {data.civilizations.map(c => (
              <option key={c.id} value={c.id}>
                {c.id}（{c.nickname}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="持续秒数，按真实时间">
          <input
            type="number"
            min={1}
            max={86400}
            step={1}
            value={seconds}
            onChange={e => setSeconds(e.target.value)}
          />
        </Field>
      </ManagementForm>
    </>
  );
}
