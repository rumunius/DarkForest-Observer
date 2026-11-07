import {
  COLORS,
  FLIGHT_NAMES,
  validCode,
  type Action,
  type HomeworldSubmission,
} from '@darkforest/contracts';
import {useState} from 'react';
import {handleAsync} from '../../data/async_event';
import {canAct} from '../../permissions';
import {useApp} from '../../state';
import {
  ArmsView,
  Button,
  CodeField,
  CopyText,
  Disclosure,
  Frame,
  Icon,
  Link,
  PageTitle,
  Status,
  Timer,
} from '../../ui';
import {LockedAction} from './action_controls';

/** 提供本人六位母星登记与退回修改流程，保留审核版本约束。 */
export function Homeworld() {
  const {reportError, data, operate, busy} = useApp();
  const playerState = data.player!;
  const [value, setValue] = useState(playerState.homeworld ?? '');
  const [editing, setEditing] = useState(false);
  const pending = playerState.flight === 'pending';
  const editable = canAct(data, 'homeworld-submit') && (!pending || editing);
  return (
    <>
      <PageTitle title="母星登记" back="/player" />
      {playerState.rejection && (
        <p className="attention notice-block">{playerState.rejection}</p>
      )}
      {editable ? (
        <form
          className="form-stack"
          onSubmit={e => {
            e.preventDefault();
          }}
        >
          <p className="secondary">
            选择你的秘密母星，填写高德地图生成的六位位置口令。
          </p>
          <CodeField value={value} onChange={setValue} />
          {validCode(value) && (
            <Button
              className="primary full"
              disabled={busy}
              onClick={handleAsync(async () => {
                const r = await operate('/action/homeworld-submit', {
                  code: value,
                } satisfies HomeworldSubmission);
                if (r?.status === 'complete') {
                  setEditing(false);
                }
              }, reportError)}
            >
              保存母星口令
              <Icon name="arrow" size={18} />
            </Button>
          )}
        </form>
      ) : playerState.homeworld ? (
        <>
          <Frame>
            <div className="card-heading">
              <Icon name="planet" />
              <Status tone={pending ? 'attention' : ''}>
                {pending ? '等待审核' : '母星已登记'}
              </Status>
            </div>
            <span className="eyebrow">已保存的六位口令</span>
            <p className="secret-code numeric">{playerState.homeworld}</p>
            <p className="secondary">第{playerState.homeVersion}次提交</p>
          </Frame>
          {pending && (
            <>
              <h2>发送QQ登记材料</h2>
              <p>
                请复制下方登记消息，发到裁判QQ私聊，并附上母星现场时间水印照片。
              </p>
              <CopyText kind="homeworld" label="复制登记消息" />
              {canAct(data, 'homeworld-submit') && (
                <button
                  className="text-button"
                  onClick={() => setEditing(true)}
                >
                  修改并重新提交口令
                </button>
              )}
            </>
          )}
        </>
      ) : (
        <LockedAction />
      )}
    </>
  );
}

/** 按首航当前步骤展示准备与领码，等待T1前不开放攻防。 */
export function Preflight() {
  const {data, operate, busy} = useApp();
  const playerState = data.player!;
  const match = data.match!;
  const [checked, setChecked] = useState(false);
  const submit = (action: Action) => void operate(`/action/${action}`);
  return (
    <>
      <PageTitle title="首航准备" back="/player" />
      <p className="step-label">{FLIGHT_NAMES[playerState.flight]}</p>
      {canAct(data, 'preflight-depart') ? (
        <>
          <h2>先离开母星</h2>
          <p>请离开母星至少50米。当前尚未佩戴比赛手环，现场移动请正常步行。</p>
          <label className="check-label large">
            <input
              type="checkbox"
              checked={checked}
              onChange={e => setChecked(e.target.checked)}
            />
            我已离开母星至少50米
          </label>
          {checked && (
            <Button
              className="primary full"
              disabled={busy}
              onClick={() => {
                submit('preflight-depart');
                setChecked(false);
              }}
            >
              确认已离开母星
            </Button>
          )}
        </>
      ) : canAct(data, 'preflight-stage') ? (
        <>
          <h2>核对七种手环</h2>
          <div className="material-colors">
            {COLORS.map(c => (
              <span key={c.id}>
                <span
                  className="mini-band"
                  style={{backgroundColor: data.site.colors[c.id]}}
                />
                {c.name}
              </span>
            ))}
          </div>
          <p>请核对七种同款手环各一条，保持全部未佩戴。</p>
          <label className="check-label large">
            <input
              type="checkbox"
              checked={checked}
              onChange={e => setChecked(e.target.checked)}
            />
            七种手环已齐备
          </label>
          {checked && (
            <Button
              className="primary full"
              disabled={busy}
              onClick={() => submit('preflight-stage')}
            >
              准备完成
            </Button>
          )}
        </>
      ) : canAct(data, 'preflight-issue-code') ? (
        <>
          <h2>可以领取首航配置</h2>
          <p>领取后在安全位置按图示佩戴手环，其余收入衣袋，等待统一开赛。</p>
          <Button
            className="primary full"
            disabled={busy}
            onClick={() => submit('preflight-issue-code')}
          >
            领取手环配置
            <Icon name="arrow" size={18} />
          </Button>
        </>
      ) : playerState.flight === 'outfitting' && playerState.arms ? (
        <>
          <h2>需要佩戴的手环</h2>
          <ArmsView arms={playerState.arms} />
          <p>
            请按图示佩戴手环，其余手环收入口袋。同侧顺序不限，两侧可以交换。
          </p>
          {canAct(data, 'preflight-ready') && (
            <Button
              className="primary full"
              disabled={busy}
              onClick={() => submit('preflight-ready')}
            >
              确认穿戴就绪
              <Icon name="check" size={18} />
            </Button>
          )}
        </>
      ) : playerState.flight === 'staged' ? (
        <>
          <h2>准备已完成</h2>
          {match.releaseAt ? (
            <Timer
              label="距离发码"
              clock="utc"
              deadline={match.releaseAt}
              large
            />
          ) : (
            <p>等待裁判安排发码。</p>
          )}
        </>
      ) : playerState.flight === 'ready' ? (
        <>
          <h2>已穿戴就绪</h2>
          {match.startAt ? (
            <Timer
              label="距离正式开赛"
              clock="utc"
              deadline={match.startAt}
              large
            />
          ) : (
            <p>等待裁判安排开赛。</p>
          )}
          <p>等待全场统一开赛，现在还不能目击攻击。</p>
          <Link className="text-link" to="/player/bracelets">
            查看本人手环
            <Icon name="arrow" size={18} />
          </Link>
        </>
      ) : (
        <LockedAction />
      )}
      <Disclosure title="查看已完成的准备">
        <p className="secondary">
          母星口令
          {playerState.homeworld
            ? `已保存为${playerState.homeworld}`
            : '尚未登记'}
          。
        </p>
      </Disclosure>
    </>
  );
}

/** 按有效比赛时间期限展示返航、换码及出航步骤，过期状态由服务器裁决。 */
export function Respawn() {
  const {reportError, data, operate, busy, go} = useApp();
  const playerState = data.player!;
  const [checked, setChecked] = useState(false);
  if (
    !playerState.respawnDeadline ||
    !['returning', 'preparing', 'issued'].includes(playerState.flight)
  ) {
    return (
      <>
        <PageTitle title="重生" back="/player" />
        <LockedAction />
      </>
    );
  }
  return (
    <>
      <PageTitle title="重生" back="/player" />
      <Timer
        label="距离重生截止"
        deadline={playerState.respawnDeadline}
        large
      />
      <p className="notice-block">
        所有步骤共用此期限，必须在截止前完成出航。保持全部比赛手环未佩戴，换好新配置后再确认出航。
      </p>
      {data.match?.paused ? (
        <LockedAction />
      ) : playerState.flight === 'returning' ? (
        <>
          <h2>返回母星，发送现场照片</h2>
          <p>
            请正常步行返回母星，拍摄当前时间水印照片。复制本航次消息，到裁判QQ发送文字和照片。
          </p>
          <Disclosure title="查看本人母星口令">
            <p className="secret-code numeric">{playerState.homeworld}</p>
          </Disclosure>
          <CopyText kind="respawn" label="复制重生消息" />
          <label className="check-label large">
            <input
              type="checkbox"
              checked={checked}
              onChange={e => setChecked(e.target.checked)}
            />
            我已在QQ发送本次现场照片
          </label>
          {checked && canAct(data, 'return-confirm') && (
            <Button
              className="primary full"
              disabled={busy}
              onClick={() => void operate('/action/return-confirm')}
            >
              已发送照片
              <Icon name="arrow" size={18} />
            </Button>
          )}
        </>
      ) : playerState.flight === 'preparing' ? (
        <>
          <h2>离开母星至少50米</h2>
          <p>
            继续保持全部手环未佩戴，正常步行离开母星。之后领取全新的两臂配置。
          </p>
          <label className="check-label large">
            <input
              type="checkbox"
              checked={checked}
              onChange={e => setChecked(e.target.checked)}
            />
            我已离开母星至少50米
          </label>
          {checked && canAct(data, 'issue-code') && (
            <Button
              className="primary full"
              disabled={busy}
              onClick={() => void operate('/action/issue-code')}
            >
              已离开母星，领取新配置
            </Button>
          )}
        </>
      ) : (
        playerState.arms && (
          <>
            <h2>需要佩戴的手环</h2>
            <ArmsView arms={playerState.arms} />
            <p>
              请在安全位置按图示佩戴，其余手环收入衣袋。同侧顺序不限，两侧可以交换。
            </p>
            {canAct(data, 'launch') && (
              <Button
                className="primary full"
                disabled={busy}
                onClick={handleAsync(async () => {
                  const r = await operate('/action/launch');
                  if (r?.status === 'complete') {
                    go('/player');
                  }
                }, reportError)}
              >
                完成出航
                <Icon name="arrow" size={18} />
              </Button>
            )}
          </>
        )
      )}
      {playerState.attackLockedUntil > (data.match?.serverUtcMs ?? 0) && (
        <Timer
          label="距离恢复目击攻击"
          clock="utc"
          deadline={playerState.attackLockedUntil}
        />
      )}
    </>
  );
}
