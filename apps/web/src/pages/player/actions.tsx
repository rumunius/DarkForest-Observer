import {validCode} from '@darkforest/contracts';
import {useState} from 'react';
import {handleAsync} from '../../data/async_event';
import {canAct} from '../../permissions';
import {useApp} from '../../state';
import {
  Button,
  CodeField,
  ColorEditor,
  Disclosure,
  Empty,
  Icon,
  Link,
  PageTitle,
} from '../../ui';
import {LockedAction} from './action_controls';

/** 按当前玩家可用动作披露目击及资源入口，使用后端返回的限制。 */
export function Actions({sightingOnly = false}: {sightingOnly?: boolean}) {
  const {data} = useApp();
  const sighting = canAct(data, 'sighting');
  return (
    <>
      <PageTitle
        title={sighting ? '目击攻击' : '行动'}
        back={sightingOnly ? '/player/actions' : undefined}
      />
      {sighting ? <ColorEditor /> : <LockedAction />}
      {!sightingOnly && (
        <div className="other-actions">
          <ResourceAction action="broadcast" />
          <ResourceAction action="photon" />
        </div>
      )}
      <Disclosure title="查看目击规则">
        <p>
          必须在比赛开始后亲眼观察目标两臂当前完整配置。同色只能出现一次，合法数量为两条与一条、两条与两条、三条与一条。
        </p>
        <p>
          输入和拖动颜色不会攻击。点击“确认攻击”并在弹窗核对后才提交。不要远程猜码或使用照片录像放大读码。
        </p>
        <Link className="text-link" to="/rules?topic=sighting">
          查看完整规则
          <Icon name="arrow" size={18} />
        </Link>
      </Disclosure>
    </>
  );
}

function ResourceAction({action}: {action: 'broadcast' | 'photon'}) {
  const {data} = useApp();
  const playerState = data.player!;
  const available = canAct(data, action);
  const content = (
    <>
      <Icon name={action} />
      <span>
        {action === 'broadcast' ? '发送广播' : '发射光粒'}
        <small>
          {action === 'broadcast'
            ? `剩余${playerState.broadcasts}次`
            : playerState.photons > 0
              ? `剩余${playerState.photons}枚光粒`
              : '无光粒'}
        </small>
      </span>
      {available ? (
        <Icon name="arrow" size={18} />
      ) : (
        <small className="action-unavailable">不可用</small>
      )}
    </>
  );
  return available ? (
    <Link className="resource-action" to={`/player/actions/${action}`}>
      {content}
    </Link>
  ) : (
    <div className="resource-action unavailable" aria-disabled="true">
      {content}
    </div>
  );
}

/** 提交六位坐标的广播或光粒行动，保留前导零和确认流程。 */
export function CoordinateAction({action}: {action: 'broadcast' | 'photon'}) {
  const {reportError, data, operate, busy, pending} = useApp();
  const [value, setValue] = useState(
    new URLSearchParams(location.search).get('code') ?? '',
  );
  const [done, setDone] = useState(false);
  const title = action === 'broadcast' ? '发送广播' : '发射光粒';
  const duplicate =
    action === 'broadcast' &&
    data.events.some(e => e.kind === 'broadcast' && e.code === value);
  return (
    <>
      <PageTitle title={title} back="/player/actions" />
      {!canAct(data, action) ? (
        <LockedAction />
      ) : done ? (
        <Empty
          title={action === 'broadcast' ? '广播已发布' : '光粒已发射'}
          to="/player/actions"
          action="返回行动"
        />
      ) : (
        <div className="form-stack">
          <div className="resource-summary">
            <Icon name={action} size={32} />
            <p>
              {action === 'broadcast' ? '剩余广播次数' : '可用光粒'}
              <strong className="numeric">
                {action === 'broadcast'
                  ? data.player!.broadcasts
                  : data.player!.photons}
              </strong>
            </p>
          </div>
          <CodeField
            value={value}
            onChange={setValue}
            label="本次提交的六位口令"
          />
          <p className="notice-block">
            {action === 'broadcast'
              ? '广播将公开这组六位口令，并消耗1次广播次数。若它对应某个文明的母星，该文明会获得你的母星口令。'
              : '发射将消耗1枚光粒。发射前不会鉴定这组六位口令是否对应真实母星。'}
          </p>
          {duplicate ? (
            <p className="attention">这组六位口令已被广播。</p>
          ) : (
            validCode(value) && (
              <>
                <Button
                  className="primary full"
                  disabled={busy || !!pending}
                  onClick={handleAsync(async () => {
                    const r = await operate(`/action/${action}`, {code: value});
                    if (r?.status === 'complete') {
                      setDone(true);
                    }
                  }, reportError)}
                >
                  {action === 'broadcast' ? '确认广播' : '发射光粒'}
                  <Icon name="arrow" size={18} />
                </Button>
              </>
            )
          )}
        </div>
      )}
    </>
  );
}
