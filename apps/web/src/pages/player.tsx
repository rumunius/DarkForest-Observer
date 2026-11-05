import { useEffect, useState, type ReactNode } from 'react';
import {
  COLORS,
  FLIGHT_NAMES,
  RULES,
  STAGE_NAMES,
  validCode,
  type Action,
} from '@darkforest/contracts';
import { useApp } from '../state';
import { DEFAULT_PARAMETERS, duration } from '../rule-text';
import { canAct } from '../permissions';
import {
  ArmsView,
  Button,
  CodeField,
  ColorEditor,
  CutOutline,
  CopyText,
  Disclosure,
  Empty,
  Events,
  Field,
  Frame,
  Icon,
  Identity,
  Link,
  MatchSummary,
  MiniArms,
  PageTitle,
  PlayerStatus,
  Status,
  Tabs,
  Timer,
  formatTime,
} from '../ui';

function LockedAction() {
  const { data } = useApp();
  const me = data.player;
  const match = data.match;
  let reason = '当前没有可以执行的比赛行动。';
  if (match?.stage === 'ended') reason = '比赛已结束，可以查看正式结果和完整复盘。';
  else if (me?.flight === 'eliminated')
    reason = '你已永久淘汰，请摘下全部比赛手环，步行返回裁判室。';
  else if (['returning', 'preparing', 'issued'].includes(me?.flight ?? ''))
    reason = '飞船已被击毁，请继续完成当前重生步骤。';
  else if (match?.verification) reason = '终局资格确认中，请保持QQ群位置共享，等待裁判完成核验。';
  else if (match?.paused) reason = `比赛已暂停。${match.pauseReason}`;
  else if (match?.stage === 'transfer')
    reason = '已进入转场，目击攻击暂停。请加入QQ群位置共享，正常步行前往终局圈。';
  else if (me?.attackLockedUntil && me.attackLockedUntil > (match?.serverUtcMs ?? 0))
    reason = '你暂时不能目击攻击。你仍在出航，可以被其他玩家击毁。';
  return <Empty title="查看当前任务">{reason}</Empty>;
}
function TaskButton({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link className="task-button cut" to={to}>
      <span>{children}</span>
      <Icon name="arrow" size={20} />
      <CutOutline />
    </Link>
  );
}
function Current() {
  const { data } = useApp();
  const me = data.player!;
  const match = data.match!;
  let title = '飞船保持正常出航',
    body = '亲眼观察其他飞船两臂的完整颜色分组，提交目击攻击。',
    to = '/player/actions',
    action = '前往行动';
  let countdown: ReactNode = <Timer label="距离宇宙末日" deadline={RULES.apocalypseMs} large />;
  if (match.stage === 'ended') {
    title = '本场比赛已经结束';
    body = '正式结果与完整战报已开放，所有本场参赛者均可复盘。';
    to = '/results';
    action = '查看比赛结果';
    countdown = null;
  } else if (me.flight === 'eliminated') {
    title = '你已永久淘汰';
    body = '请摘下全部比赛手环，步行返回裁判室。裁判室位置请查看QQ群文件。';
    to = me.observerAllowed ? '/observer' : '/player/eliminated';
    action = me.observerAllowed ? '进入宇宙观测' : '查看淘汰后安排';
    countdown =
      !me.observerAllowed && me.eliminatedAt ? (
        <Timer
          label="距离开放宇宙观测"
          clock="utc"
          deadline={me.eliminatedAt + (data.parameters?.observerWaitSeconds ?? 180) * 1000}
          large
        />
      ) : null;
  } else if (
    me.respawnDeadline !== null &&
    ['returning', 'preparing', 'issued'].includes(me.flight)
  ) {
    title = '飞船已被击毁';
    body = '请摘下全部比赛手环，返回母星完成重生。返航、拍照和重新出航共用同一期限。';
    to = '/player/respawn';
    action = '继续重生';
    countdown = <Timer label="距离重生截止" deadline={me.respawnDeadline} large />;
  } else if (['nickname', 'unregistered', 'pending', 'rejected'].includes(me.flight)) {
    title =
      me.flight === 'nickname'
        ? '为你的文明命名'
        : me.flight === 'pending'
          ? '等待母星审核'
          : me.flight === 'rejected'
            ? '请修改母星登记'
            : '登记你的秘密母星';
    body =
      me.flight === 'pending'
        ? `正在等待裁判审核第${me.homeVersion}次提交的母星口令。请确保已发送对应版本的QQ材料。`
        : '完成当前登记步骤后，再进入首航准备。';
    to = me.flight === 'nickname' ? '/player/identity' : '/player/homeworld';
    action =
      me.flight === 'nickname'
        ? '设置文明昵称'
        : me.flight === 'pending'
          ? '查看登记情况'
          : '登记母星';
    countdown = null;
  } else if (['verified', 'departed', 'staged', 'outfitting', 'ready'].includes(me.flight)) {
    title = FLIGHT_NAMES[me.flight];
    body =
      me.flight === 'ready'
        ? '已穿戴就绪，等待全场统一开赛。现在还不能发动目击攻击。'
        : '依次完成当前准备任务，配置以本次领取结果为准。';
    to = '/player/preflight';
    action = me.flight === 'ready' ? '查看准备情况' : '继续首航准备';
    countdown =
      me.flight === 'ready' && match.startAt ? (
        <Timer label="距离正式开赛" clock="utc" deadline={match.startAt} large />
      ) : me.flight === 'staged' && match.releaseAt ? (
        <Timer label="距离发码" clock="utc" deadline={match.releaseAt} large />
      ) : null;
  } else if (match.verification) {
    title = '终局资格确认中';
    body = '比赛有效时间停在98:00。请持续共享位置，等待裁判核验；核验完成后再恢复目击攻击。';
    to = '/player/endgame';
    action = '查看终局说明';
    countdown = null;
  } else if (match.paused) {
    title = '比赛已暂停';
    body = match.pauseReason || '请等待裁判通知。有效比赛时间与重生期限已冻结。';
    to = '/player/messages';
    action = '查看赛事消息';
    countdown = null;
  } else if (match.stage === 'transfer') {
    title = '步行前往终局圈';
    body = '加入比赛QQ群的实时位置共享。查看QQ群文件中的终局圈图片，使用手机高德地图前往。';
    to = '/player/endgame';
    action = '查看终局要求';
    countdown = <Timer label="距离终局资格截止" deadline={RULES.cutoffMs} large />;
  } else if (match.stage === 'hunt') {
    title = '最后狩猎已开始';
    body = '请持续共享位置，在终局圈内正常步行，亲眼观察后提交目击攻击。';
    action = '目击攻击';
    countdown = <Timer label="比赛剩余有效时间" deadline={RULES.regulationMs} large />;
  } else if (me.attackLockedUntil > match.serverUtcMs) {
    title = '暂时禁止目击攻击';
    body =
      '因为你提交了错误目击码，你被暂时禁止目击攻击。你仍在出航，可以被其他玩家击毁。其他有资格的行动仍可使用。';
    action = '查看其他行动';
    countdown = (
      <Timer label="距离恢复目击攻击" clock="utc" deadline={me.attackLockedUntil} large />
    );
  } else if (!me.homeAlive) {
    title = '母星已毁灭，最后一命';
    body = '你仍在正常出航，再次被击毁将永久淘汰。';
    action = '目击攻击';
    countdown = <Timer label="距离转场" deadline={RULES.transferMs} large />;
  } else if (me.flight === 'absent') {
    title = '本场参赛安排已调整';
    body = '请联系裁判了解安排。';
    to = '/player/help';
    action = '联系裁判';
    countdown = null;
  }
  return (
    <>
      <PageTitle title="当前" aside={<PlayerStatus />} />
      <MatchSummary />
      <section className="current-task">
        {/* <div className="current-task-symbol">
          <Icon name={me.homeAlive ? 'planet' : 'current'} size={40} />
        </div> */}
        <h2>{title}</h2>
        <p>{body}</p>
        {countdown}
        <TaskButton to={to}>{action}</TaskButton>
      </section>
      <div className="related-links">
        <Link to="/player/messages">
          查看消息
          <Icon name="arrow" size={18} />
        </Link>
        <Link to={me.flight === 'active' ? '/player/bracelets' : '/player/help'}>
          {me.flight === 'active' ? '本航次手环' : '联系裁判'}
          <Icon name="arrow" size={18} />
        </Link>
      </div>
      {me.flight === 'active' && (
        <p className="current-footnote">
          母星{me.homeAlive ? '尚存' : '已毁灭'}
          <span>
            已击毁的不同文明数 <strong className="numeric">{me.kills}</strong>
          </span>
        </p>
      )}
    </>
  );
}
function IdentityPage() {
  const { data, operate, busy, go } = useApp();
  const me = data.player!;
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  return (
    <>
      <PageTitle title="文明昵称" back="/player" />
      {!canAct(data, 'nickname') ? (
        <>
          <Identity id={me.id} nickname={me.nickname} />
          <p className="secondary">昵称已固定，需要更正请联系裁判。</p>
        </>
      ) : (
        <div className="form-stack">
          <p>
            你的文明编号 <strong className="numeric">{me.id}</strong>
          </p>
          <Field label="文明昵称" hint="2至8个字符，确认后昵称将固定。">
            <input
              value={value}
              maxLength={8}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              placeholder="为文明命名"
            />
          </Field>
          {[...trimmed].length >= 2 && (
            <>
              <p className="secondary">
                确认后显示为：{me.id}（{trimmed}）
              </p>
              <Button
                className="primary full"
                disabled={busy}
                onClick={async () => {
                  const r = await operate('/player/nickname', { nickname: trimmed });
                  if (r?.status === 'complete') go('/player/homeworld');
                }}
              >
                确认昵称
                <Icon name="arrow" size={18} />
              </Button>
            </>
          )}
        </div>
      )}
    </>
  );
}
function Homeworld() {
  const { data, operate, busy } = useApp();
  const me = data.player!;
  const [value, setValue] = useState(me.homeworld ?? '');
  const [editing, setEditing] = useState(false);
  const pending = me.flight === 'pending';
  const editable = canAct(data, 'homeworld-submit') && (!pending || editing);
  return (
    <>
      <PageTitle title="母星登记" back="/player" />
      {me.rejection && <p className="attention notice-block">{me.rejection}</p>}
      {editable ? (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <p className="secondary">
            选择你的秘密母星，将六位位置口令保存到本场比赛。网站不接收照片。
          </p>
          <CodeField value={value} onChange={setValue} />
          {validCode(value) && (
            <Button
              className="primary full"
              disabled={busy}
              onClick={async () => {
                const r = await operate('/action/homeworld-submit', {
                  code: value,
                } satisfies import('@darkforest/contracts').HomeworldSubmission);
                if (r?.status === 'complete') setEditing(false);
              }}
            >
              保存母星口令
              <Icon name="arrow" size={18} />
            </Button>
          )}
        </form>
      ) : me.homeworld ? (
        <>
          <Frame>
            <div className="card-heading">
              <Icon name="planet" />
              <Status tone={pending ? 'attention' : ''}>
                {pending ? '等待审核' : '母星已登记'}
              </Status>
            </div>
            <span className="eyebrow">已保存的六位口令</span>
            <p className="secret-code numeric">{me.homeworld}</p>
            <p className="secondary">第{me.homeVersion}次提交</p>
          </Frame>
          {pending && (
            <>
              <h2>发送QQ登记材料</h2>
              <p>请复制下方登记消息，发送给裁判并附上当前口令对应的现场照片。复制不代表已发送。</p>
              <CopyText kind="homeworld" label="复制登记消息" />
              {canAct(data, 'homeworld-submit') && (
                <button className="text-button" onClick={() => setEditing(true)}>
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
function Preflight() {
  const { data, operate, busy } = useApp();
  const me = data.player!;
  const match = data.match!;
  const [checked, setChecked] = useState(false);
  const submit = (action: Action) => void operate(`/action/${action}`);
  return (
    <>
      <PageTitle title="首航准备" back="/player" />
      <p className="step-label">{FLIGHT_NAMES[me.flight]}</p>
      {canAct(data, 'preflight-depart') ? (
        <>
          <h2>先离开母星</h2>
          <p>请离开母星至少50米。当前尚未佩戴比赛手环，现场移动请正常步行。</p>
          <label className="check-label large">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
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
            {COLORS.map((c) => (
              <span key={c.id}>
                <span className="mini-band" style={{ backgroundColor: data.site.colors[c.id] }} />
                {c.name}
              </span>
            ))}
          </div>
          <p>请核对七种同款手环各一条，保持全部未佩戴。</p>
          <label className="check-label large">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
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
          <p>领取后按图示佩戴指定手环，其余收入衣袋。领码不代表比赛已经开始。</p>
          <Button
            className="primary full"
            disabled={busy}
            onClick={() => submit('preflight-issue-code')}
          >
            领取手环配置
            <Icon name="arrow" size={18} />
          </Button>
        </>
      ) : me.flight === 'outfitting' && me.arms ? (
        <>
          <h2>需要佩戴的手环</h2>
          <ArmsView arms={me.arms} />
          <p>请按图示佩戴手环，其余手环收入口袋。同侧顺序不限，两侧可以交换。</p>
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
      ) : me.flight === 'staged' ? (
        <>
          <h2>准备已完成</h2>
          {match.releaseAt ? (
            <Timer label="距离发码" clock="utc" deadline={match.releaseAt} large />
          ) : (
            <p>等待裁判安排发码。</p>
          )}
        </>
      ) : me.flight === 'ready' ? (
        <>
          <h2>已穿戴就绪</h2>
          {match.startAt ? (
            <Timer label="距离正式开赛" clock="utc" deadline={match.startAt} large />
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
          母星口令{me.homeworld ? `已保存为${me.homeworld}` : '尚未登记'}。
        </p>
      </Disclosure>
    </>
  );
}
function Respawn() {
  const { data, operate, busy, go } = useApp();
  const me = data.player!;
  const [checked, setChecked] = useState(false);
  if (!me.respawnDeadline || !['returning', 'preparing', 'issued'].includes(me.flight))
    return (
      <>
        <PageTitle title="重生" back="/player" />
        <LockedAction />
      </>
    );
  return (
    <>
      <PageTitle title="重生" back="/player" />
      <Timer label="距离重生截止" deadline={me.respawnDeadline} large />
      <p className="notice-block">
        所有步骤共用此期限，必须在截止前完成出航。保持全部比赛手环未佩戴，换好新配置后再确认出航。
      </p>
      {data.match?.paused ? (
        <LockedAction />
      ) : me.flight === 'returning' ? (
        <>
          <h2>返回母星，发送现场照片</h2>
          <p>请正常步行返回母星，拍摄当前时间水印照片。复制本航次消息，到裁判QQ发送文字和照片。</p>
          <Disclosure title="查看本人母星口令">
            <p className="secret-code numeric">{me.homeworld}</p>
          </Disclosure>
          <CopyText kind="respawn" label="复制重生消息" />
          <label className="check-label large">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
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
      ) : me.flight === 'preparing' ? (
        <>
          <h2>离开母星至少50米</h2>
          <p>继续保持全部手环未佩戴，正常步行离开母星。之后领取全新的两臂配置。</p>
          <label className="check-label large">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
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
        me.arms && (
          <>
            <h2>需要佩戴的手环</h2>
            <ArmsView arms={me.arms} />
            <p>请在安全位置按图示佩戴，其余手环收入衣袋。同侧顺序不限，两侧可以交换。</p>
            {canAct(data, 'launch') && (
              <Button
                className="primary full"
                disabled={busy}
                onClick={async () => {
                  const r = await operate('/action/launch');
                  if (r?.status === 'complete') go('/player');
                }}
              >
                完成出航
                <Icon name="arrow" size={18} />
              </Button>
            )}
          </>
        )
      )}
      {me.attackLockedUntil > (data.match?.serverUtcMs ?? 0) && (
        <Timer label="距离恢复目击攻击" clock="utc" deadline={me.attackLockedUntil} />
      )}
    </>
  );
}
function Actions({ sightingOnly = false }: { sightingOnly?: boolean }) {
  const { data } = useApp();
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
function ResourceAction({ action }: { action: 'broadcast' | 'photon' }) {
  const { data } = useApp();
  const me = data.player!;
  const available = canAct(data, action);
  const content = (
    <>
      <Icon name={action} />
      <span>
        {action === 'broadcast' ? '发送广播' : '发射光粒'}
        <small>
          {action === 'broadcast'
            ? `剩余${me.broadcasts}次`
            : me.photons > 0
              ? `剩余${me.photons}枚光粒`
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
function CoordinateAction({ action }: { action: 'broadcast' | 'photon' }) {
  const { data, operate, busy, pending } = useApp();
  const [value, setValue] = useState(new URLSearchParams(location.search).get('code') ?? '');
  const [done, setDone] = useState(false);
  const title = action === 'broadcast' ? '发送广播' : '发射光粒';
  const duplicate =
    action === 'broadcast' && data.events.some((e) => e.kind === 'broadcast' && e.code === value);
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
                {action === 'broadcast' ? data.player!.broadcasts : data.player!.photons}
              </strong>
            </p>
          </div>
          <CodeField value={value} onChange={setValue} label="本次提交的六位口令" />
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
                  onClick={async () => {
                    const r = await operate(`/action/${action}`, { code: value });
                    if (r?.status === 'complete') setDone(true);
                  }}
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
function Endgame() {
  const { data } = useApp();
  const match = data.match!;
  return (
    <>
      <PageTitle title="终局说明" back="/player" />
      {match.stage === 'transfer' && (
        <Timer label="距离终局资格截止" deadline={RULES.cutoffMs} large />
      )}
      {match.verification && (
        <Frame>
          <h2>终局资格确认中</h2>
          <p>比赛有效时间停在98:00。等待裁判完成资格核验后恢复计时。</p>
        </Frame>
      )}
      <ol className="instruction-list">
        <li>
          <h2>加入QQ群位置共享</h2>
          <p>从比赛时间90:00起，加入比赛QQ群的同一场实时位置共享。</p>
        </li>
        <li>
          <h2>正常步行进入终局圈</h2>
          <p>请查看QQ群文件中的{data.site.endgameFile}，并使用手机高德地图前往。</p>
        </li>
        <li>
          <h2>98:00前到达并持续共享</h2>
          <p>
            在比赛有效时间98:00前进入终局圈，之后保持位置共享。网站无需确认到达，资格由裁判核验。
          </p>
        </li>
      </ol>
      <p className="notice-block">
        最后狩猎期间离开终局圈、停止位置共享或定位违规，裁判将执行永久淘汰。
      </p>
    </>
  );
}
function Eliminated() {
  const { data } = useApp();
  const me = data.player!;
  if (me.flight !== 'eliminated')
    return (
      <>
        <PageTitle title="淘汰后安排" back="/player" />
        <Empty title="你当前没有淘汰安排" />
      </>
    );
  return (
    <>
      <PageTitle title="淘汰后安排" back="/player" />
      <h2>你已永久淘汰</h2>
      <p>{me.eliminationReason}</p>
      <p className="notice-block">
        请摘下全部比赛手环，步行返回裁判室。裁判室位置请查看QQ群文件。曾参加位置共享的玩家可以停止共享。
      </p>
      {me.eliminatedAt && (
        <p className="secondary">
          淘汰生效时间：
          {new Date(me.eliminatedAt).toLocaleTimeString('zh-CN', { timeZone: data.site.timezone })}
        </p>
      )}
      {me.observerAllowed ? (
        <Link className="text-link" to="/observer">
          进入宇宙观测
          <Icon name="arrow" size={18} />
        </Link>
      ) : (
        me.eliminatedAt && (
          <Timer
            label="距离开放宇宙观测"
            clock="utc"
            deadline={me.eliminatedAt + (data.parameters?.observerWaitSeconds ?? 180) * 1000}
            large
          />
        )
      )}
      <p>观战信息仅供已淘汰玩家交流，请勿向仍在比赛中的玩家传递。</p>
      <Link className="text-link" to="/player/records">
        查看本人战绩
        <Icon name="arrow" size={18} />
      </Link>
    </>
  );
}
function Messages() {
  const { data, route, markRead } = useApp();
  const [tab, setTab] = useState('personal');
  const detailId = route.split('/')[3];
  const event = data.events.find((e) => e.id === detailId);
  useEffect(() => {
    if (event) markRead(event.id);
  }, [event?.id, markRead]);
  if (detailId)
    return (
      <>
        <PageTitle title="消息详情" back="/player/messages" />
        {event ? (
          <>
            <Status>{event.audience === 'personal' ? '本人消息' : '公开事件'}</Status>
            <h2>{event.title}</h2>
            <p>{event.body}</p>
            {event.code && <p className="secret-code numeric">{event.code}</p>}
            <p className="secondary">发生于比赛时间{formatTime(event.gameMs)}</p>
            <p className="secondary">来源：赛事系统</p>
          </>
        ) : (
          <Empty title="消息不存在或无查看权限" to="/player/messages" action="返回消息" />
        )}
      </>
    );
  const events = data.events.filter((e) =>
    tab === 'personal'
      ? e.audience === 'personal'
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
          { id: 'personal', label: '本人消息' },
          { id: 'public', label: '公开事件' },
          { id: 'broadcast', label: '宇宙广播' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <Events events={events} detailsPrefix="/player/messages" />
    </>
  );
}
function Intel() {
  const { data } = useApp();
  return (
    <>
      <PageTitle title="母星坐标情报箱" back="/player/messages" />
      {data.intel.length ? (
        data.intel.map((intel) => (
          <Frame key={intel.id}>
            <Identity id={intel.civilization} nickname={intel.nickname} />
            <p className="secret-code numeric">{intel.code}</p>
            <p className="secondary">
              {intel.source}，比赛时间{formatTime(intel.gameMs)}
            </p>
            <CopyText text={intel.code} label="复制六位口令" />
            {canAct(data, 'broadcast') && (
              <Link className="text-link" to={`/player/actions/broadcast?code=${intel.code}`}>
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
function Me() {
  const { data } = useApp();
  const me = data.player!;
  return (
    <>
      <PageTitle title="我的" />
      <div className="profile-heading">
        <Identity id={me.id} nickname={me.nickname} />
        <PlayerStatus />
      </div>
      <div className="stat-lines">
        <div>
          <span>母星状态</span>
          <strong>{me.homeAlive ? '尚存' : '已毁灭'}</strong>
        </div>
        <div>
          <span>当前航次</span>
          <strong className="numeric">{me.flightNumber}</strong>
        </div>
        <div>
          <span>广播额度</span>
          <strong>
            剩余<span className="numeric">{me.broadcasts}</span>次
          </strong>
        </div>
        <div>
          <span>光粒额度</span>
          <strong>
            {me.photons > 0 ? (
              <>
                剩余<span className="numeric">{me.photons}</span>枚
              </>
            ) : (
              '无光粒'
            )}
          </strong>
        </div>
        <div>
          <span>已击毁的不同文明数</span>
          <strong className="numeric">{me.kills}</strong>
        </div>
        <div>
          <span>提交错误目击码的次数</span>
          <strong className="numeric">{me.wrongCount}</strong>
        </div>
      </div>
      {me.arms && (
        <Link className="row-link" to="/player/bracelets">
          <span>
            本航次手环
            <MiniArms arms={me.arms} />
          </span>
          <Icon name="arrow" size={18} />
        </Link>
      )}
      {[
        { to: '/player/homeworld', label: '本人母星' },
        { to: '/player/records', label: '个人战绩' },
        { to: '/rules', label: '比赛规则' },
        { to: '/player/help', label: '联系裁判' },
        { to: '/player/exception', label: '异常申报' },
        { to: '/player/account', label: '账号与设置' },
      ].map((item) => (
        <Link className="row-link" to={item.to} key={item.to}>
          {item.label}
          <Icon name="arrow" size={18} />
        </Link>
      ))}
    </>
  );
}
function Bracelets() {
  const { data } = useApp();
  const me = data.player!;
  return (
    <>
      <PageTitle
        title={
          me.flight === 'outfitting' || me.flight === 'issued' ? '需要佩戴的手环' : '本航次手环'
        }
        back="/player/me"
      />
      <p className="secondary">
        第{me.flightNumber}航次{me.arms ? '' : '，配置已失效'}
      </p>
      {me.arms ? (
        <>
          <ArmsView arms={me.arms} />
          <p>同侧顺序不限，两侧可以交换。未佩戴的其他手环收入口袋。</p>
        </>
      ) : (
        <Empty title="当前没有现役手环配置" to="/player/records" action="查看历史记录">
          被击毁后请摘下全部比赛手环，历史配置不能继续使用。
        </Empty>
      )}
    </>
  );
}
function Records() {
  const { data } = useApp();
  return (
    <>
      <PageTitle title="个人战绩" back="/player/me" />
      <div className="record-number">
        <strong className="numeric">{data.player!.kills}</strong>
        <span>已击毁的不同文明数</span>
      </div>
      <p className="secondary">
        同一文明被多次击毁只计一次。广播、光粒和歌者造成的母星毁灭不计入此数。
      </p>
      <Events
        events={data.events.filter(
          (e) =>
            e.civilizationIds.includes(data.player!.id) &&
            ['sighting', 'respawn', 'notice'].includes(e.kind),
        )}
      />
    </>
  );
}
function Help({ exception = false }: { exception?: boolean }) {
  const { data } = useApp();
  const [kind, setKind] = useState('手环损坏');
  return (
    <>
      <PageTitle title={exception ? '异常申报' : '联系裁判'} back="/player/me" />
      <p>裁判联系方式</p>
      <p className="contact-text">{data.site.judgeContact || '请查看活动QQ群的裁判联系方式。'}</p>
      {data.site.qqGroup && <p className="secondary">比赛QQ群：{data.site.qqGroup}</p>}
      {exception ? (
        <>
          <Field label="需要处理的情况">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {['手环损坏', '网页无法提交', '攻击结果需要复核', '其他现场异常'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          <p>获取本人已保存状态对应的消息，前往裁判QQ说明“{kind}”并补充现场情况。</p>
          <CopyText kind="exception" label="获取并复制申报消息" />
        </>
      ) : (
        <>
          <p>照片通过QQ发送，网站记录审核和裁决结果。现场移动请正常步行。</p>
          <Link className="row-link" to="/player/exception">
            异常申报
            <Icon name="arrow" size={18} />
          </Link>
          <Link className="row-link" to="/rules">
            查看比赛规则
            <Icon name="arrow" size={18} />
          </Link>
        </>
      )}
    </>
  );
}
function Account() {
  const { data, logout, names, setNames, reduced, setReduced, operate, busy, go } = useApp();
  const [quit, setQuit] = useState(false);
  return (
    <>
      <PageTitle title="账号与设置" back="/player/me" />
      <Identity id={data.player!.id} nickname={data.player!.nickname} />
      <div className="preferences">
        <label className="check-label">
          <input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} />
          显示颜色名称
        </label>
        <label className="check-label">
          <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} />
          减少动态效果
        </label>
      </div>
      <Button onClick={() => void logout()} className="full">
        <Icon name="logout" size={18} />
        退出登录
      </Button>
      {canAct(data, 'withdraw') && (
        <div className="danger-zone">
          {quit ? (
            <>
              <p>确认退出后，你的文明将永久淘汰。请摘下全部比赛手环并步行返回裁判室。</p>
              <Button
                className="danger full"
                disabled={busy}
                onClick={async () => {
                  const r = await operate('/action/withdraw');
                  if (r?.status === 'complete') go('/player/eliminated');
                }}
              >
                确认退出比赛
              </Button>
              <button className="text-button" onClick={() => setQuit(false)}>
                继续参加比赛
              </button>
            </>
          ) : (
            <button className="text-button danger" onClick={() => setQuit(true)}>
              退出比赛
            </button>
          )}
        </div>
      )}
    </>
  );
}
export function PlayerPages() {
  const { route } = useApp();
  if (route === '/player') return <Current />;
  if (route === '/player/identity') return <IdentityPage />;
  if (route === '/player/homeworld') return <Homeworld />;
  if (route === '/player/preflight') return <Preflight />;
  if (route === '/player/respawn') return <Respawn />;
  if (route === '/player/actions' || route === '/player/actions/sighting')
    return <Actions sightingOnly={route.endsWith('/sighting')} />;
  if (route === '/player/actions/broadcast' || route === '/player/actions/photon')
    return <CoordinateAction action={route.endsWith('/photon') ? 'photon' : 'broadcast'} />;
  if (route === '/player/endgame') return <Endgame />;
  if (route === '/player/eliminated') return <Eliminated />;
  if (route.startsWith('/player/messages')) return <Messages />;
  if (route === '/player/intel') return <Intel />;
  if (route === '/player/me') return <Me />;
  if (route === '/player/bracelets') return <Bracelets />;
  if (route === '/player/records') return <Records />;
  if (route === '/player/help' || route === '/player/exception')
    return <Help exception={route.endsWith('/exception')} />;
  if (route === '/player/account') return <Account />;
  return <Empty title="页面不存在" />;
}

export function Rules() {
  const { data } = useApp();
  const parameters = data.parameters ?? DEFAULT_PARAMETERS;
  useEffect(() => {
    const topic = new URLSearchParams(location.search).get('topic');
    const id =
      location.hash.slice(1).replace(/^rule-/, 'rules-') || (topic === 'sighting' ? 'rules-1' : '');
    if (id) {
      const frame = requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView({ block: 'start' }),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [data.session?.id]);
  return (
    <>
      <PageTitle
        title="比赛规则"
        back={data.session?.role === 'judge' ? '/judge' : data.session ? '/player/me' : '/'}
      />
      <nav className="rules-directory">
        {[
          '比赛流程',
          '手环与目击',
          '母星与重生',
          '广播与光粒',
          '终局要求',
          '淘汰后观战',
          '排名与现场要求',
        ].map((s, i) => (
          <a key={s} href={`#rules-${i}`}>
            {s}
          </a>
        ))}
      </nav>
      <div className="rules-article">
        <section id="rules-0">
          <h2>比赛流程</h2>
          <p>首航准备与正式开赛分开进行。发码后佩戴并确认就绪，等服务器确认正式开赛后才能攻防。</p>
          <p>
            比赛使用有效比赛时间：0至65分钟为黑暗森林，65至90分钟为宇宙末日，90至98分钟转场。98分钟自动暂停进行终局资格核验，完成后恢复最后狩猎，通常进行至120分钟。完整结算后存活文明不超过一个时可以提前完赛。
          </p>
        </section>
        <section id="rules-1">
          <h2>手环与目击</h2>
          <p>
            在开赛后亲眼辨认目标两臂的当前完整颜色分组，再提交目击。七种颜色各最多使用一次。合法分组为两条与一条、两条与两条、三条与一条；同侧顺序不限，两侧交换等价。
          </p>
          <p>
            第一次提交错误的目击码，禁止目击攻击{duration(parameters.firstLockSeconds)}；第二次有
            {parameters.secondOutPercent}%的概率永久淘汰，有{100 - parameters.secondOutPercent}
            %的概率禁止目击攻击{duration(parameters.secondLockSeconds)}
            ；第三次永久淘汰。错误次数整场累计，重生不清零。暂时禁止目击攻击时仍可被其他人击毁。
          </p>
          <p>
            历史退役码、本人码和服务器可证实的并发抢先击毁不增加错误次数，以服务器结算为准。成功击毁后取得目标已审核母星口令。不得传播当前有效手环码、远程猜码、偷拍或放大照片录像读码。
          </p>
        </section>
        <section id="rules-2">
          <h2>母星与重生</h2>
          <p>
            第一阶段被正常目击击毁且母星尚存时，可以重生。立即摘下全部比赛手环，正常步行返航，拍摄时间水印照片并发给裁判，再离开母星至少50米、领取新配置、佩戴并确认完成出航。
          </p>
          <p>
            返航至出航全部步骤共用被击毁后{duration(parameters.respawnSeconds)}
            与比赛65:00中更早的截止，必须严格早于截止完成。次数不限，旧配置永久失效。返航途中母星毁灭或截止时未完成出航则永久淘汰。错误攻击导致的直接出局不能重生。
          </p>
          <p>
            母星毁灭时若飞船正常出航，继续最后一命。65:00所有母星毁灭，未正常出航的文明同时淘汰。
          </p>
        </section>
        <section id="rules-3">
          <h2>广播与光粒</h2>
          <p>
            第一阶段正常出航时，每个文明最多正式广播两次，可输入任意尚未正式广播的六位数字。广播消耗一次次数并公开口令；若对应某文明的登记母星，该文明私下获得广播者的母星口令。广播发布后，不会告知这组六位口令是否对应母星。
          </p>
          <p>
            每个正式广播的口令每满60秒独立接受{parameters.singerPercent}
            %的歌者首次清理检定，最多清理一次。未来清理时间不公开。
          </p>
          <p>
            技术爆炸获得者秘密得到一枚光粒，正常出航时可以消耗它清理任意六位口令。获得者正在返航时不能发射。65:00起广播和光粒停止，未使用光粒失效。
          </p>
        </section>
        <section id="rules-4">
          <h2>终局要求</h2>
          <p>
            90:00起停止目击，加入比赛QQ群位置共享，正常步行在98:00前进入终局圈。请查看QQ群文件中的
            {data.site.endgameFile}，并自行使用手机高德地图前往。
          </p>
          <p>
            98:00有效时钟自动暂停，由总裁判批量核验资格。网站无需确认入圈或共享。核验完成且至少两人存活时恢复攻击。之后持续共享位置，离圈、停止共享或定位违规将由裁判淘汰。
          </p>
        </section>
        <section id="rules-5">
          <h2>淘汰后观战</h2>
          <p>
            永久淘汰后摘下全部手环，步行返回裁判室，停止攻防、侦察和向活人传递情报。自淘汰生效真实时间起满
            {parameters.observerWaitSeconds}
            秒，经服务器确认后可查看宇宙观测。比赛暂停不会冻结这段等待。
          </p>
          <p>
            观战可以查看当前完整战况和已经发生的赛事信息，只能与已淘汰玩家交流。提案在线下交给裁判决定，不获得任何裁判操作权限。比赛结束后全部本场参赛者可以立即查看完整复盘。
          </p>
        </section>
        <section id="rules-6">
          <h2>排名与现场要求</h2>
          <p>
            生存优先。幸存者按击毁的不同文明数排序；同一文明多次被击毁只计一次。淘汰者按生效时间从晚到早排列，同批淘汰并列。全体淘汰时没有存活冠军。
          </p>
          <p>
            比赛暂停时有效比赛时间和重生期限冻结；个人禁止目击攻击与观战等待按真实时间继续。所有现场移动只可正常步行，不得奔跑、进入限制区域、故意遮挡手环或干扰他人。安全或异常情况及时联系裁判。
          </p>
        </section>
      </div>
      <p className="secondary">
        当前阶段：{data.match ? STAGE_NAMES[data.match.stage] : '以活动安排为准'}
      </p>
    </>
  );
}
