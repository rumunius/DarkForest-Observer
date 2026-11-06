import {FLIGHT_NAMES, RULES} from '@darkforest/contracts';
import {useState, type ReactNode} from 'react';
import {handleAsync} from '../../data/async_event';
import {canAct} from '../../permissions';
import {useApp} from '../../state';
import {
  Button,
  Field,
  Icon,
  Identity,
  Link,
  MatchSummary,
  PageTitle,
  PlayerStatus,
  Timer,
} from '../../ui';
import {TaskButton} from './action_controls';

/** 按本人飞船和比赛阶段逐步披露当前任务与必要反馈。 */
export function Current() {
  const {data} = useApp();
  const me = data.player!;
  const match = data.match!;
  let title = '飞船保持正常出航';
  let body = '亲眼观察其他飞船两臂的完整颜色分组，提交目击攻击。';
  let to = '/player/actions';
  let action = '前往行动';
  let countdown: ReactNode = (
    <Timer label="距离宇宙末日" deadline={RULES.apocalypseMs} large />
  );
  if (match.stage === 'ended') {
    title = '本场比赛已经结束';
    body = '正式结果与完整战报已开放，所有本场参赛者均可复盘。';
    to = '/results';
    action = '查看比赛结果';
    countdown = null;
  } else if (me.flight === 'eliminated') {
    title = '你已永久淘汰';
    body =
      '你的三维文明已经永久毁灭，但意识仍残留在更高的维度。请在安全位置摘下全部比赛手环，尽快步行返回中控室。';
    to = me.observerAllowed ? '/observer' : '/player/eliminated';
    action = me.observerAllowed ? '进入宇宙观测' : '查看淘汰后安排';
    countdown =
      !me.observerAllowed && me.eliminatedAt ? (
        <Timer
          label="距离开放宇宙观测"
          clock="utc"
          deadline={
            me.eliminatedAt +
            (data.parameters?.observerWaitSeconds ?? 180) * 1000
          }
          large
        />
      ) : null;
  } else if (
    me.respawnDeadline !== null &&
    ['returning', 'preparing', 'issued'].includes(me.flight)
  ) {
    title = '飞船已被击毁';
    body = '请在安全位置摘下全部比赛手环，正常步行返回母星，在截止前完成重生。';
    to = '/player/respawn';
    action = '继续重生';
    countdown = (
      <Timer label="距离重生截止" deadline={me.respawnDeadline} large />
    );
  } else if (
    ['nickname', 'unregistered', 'pending', 'rejected'].includes(me.flight)
  ) {
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
        ? `裁判正在审核第${me.homeVersion}次提交的母星登记。请将登记消息和现场时间水印照片发给裁判。`
        : '完成当前登记步骤后，再进入首航准备。';
    to = me.flight === 'nickname' ? '/player/identity' : '/player/homeworld';
    action =
      me.flight === 'nickname'
        ? '设置文明昵称'
        : me.flight === 'pending'
          ? '查看登记情况'
          : '登记母星';
    countdown = null;
  } else if (
    ['verified', 'departed', 'staged', 'outfitting', 'ready'].includes(
      me.flight,
    )
  ) {
    title = FLIGHT_NAMES[me.flight];
    body =
      me.flight === 'ready'
        ? '全体文明穿戴就绪后统一开赛，请等待倒计时。'
        : '完成首航准备，等待统一开赛。';
    to = '/player/preflight';
    action = me.flight === 'ready' ? '查看准备情况' : '继续首航准备';
    countdown =
      me.flight === 'ready' && match.startAt ? (
        <Timer
          label="距离正式开赛"
          clock="utc"
          deadline={match.startAt}
          large
        />
      ) : me.flight === 'staged' && match.releaseAt ? (
        <Timer label="距离发码" clock="utc" deadline={match.releaseAt} large />
      ) : null;
  } else if (match.verification) {
    title = '终局资格确认中';
    body = '比赛计时已暂停。请持续共享位置，等待裁判完成终局资格核验。';
    to = '/player/endgame';
    action = '查看终局说明';
    countdown = null;
  } else if (match.paused) {
    title = '比赛已暂停';
    body = match.pauseReason || '比赛和重生倒计时已暂停，请等待裁判通知。';
    to = '/player/messages';
    action = '查看赛事消息';
    countdown = null;
  } else if (match.stage === 'transfer') {
    title = '步行前往终局圈';
    body =
      '加入比赛QQ群的实时位置共享。查看QQ群文件中的终局圈图片，使用手机高德地图前往。';
    to = '/player/endgame';
    action = '查看终局要求';
    countdown = (
      <Timer label="距离终局资格截止" deadline={RULES.cutoffMs} large />
    );
  } else if (match.stage === 'hunt') {
    title = '最后狩猎已开始';
    body = '请持续共享位置，在终局圈内正常步行，亲眼观察后提交目击攻击。';
    action = '目击攻击';
    countdown = (
      <Timer label="比赛剩余有效时间" deadline={RULES.regulationMs} large />
    );
  } else if (me.attackLockedUntil > match.serverUtcMs) {
    title = '暂时禁止目击攻击';
    body = '本次提交的手环颜色有误，暂时禁止目击攻击。';
    action = '查看其他行动';
    countdown = (
      <Timer
        label="距离恢复目击攻击"
        clock="utc"
        deadline={me.attackLockedUntil}
        large
      />
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
        <Link
          to={me.flight === 'active' ? '/player/bracelets' : '/player/help'}
        >
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

/** 展示本人文明身份和可用信息，不公开其他文明的秘密。 */
export function IdentityPage() {
  const {reportError, data, operate, busy, go} = useApp();
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
              onChange={e => setValue(e.target.value)}
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
                onClick={handleAsync(async () => {
                  const r = await operate('/player/nickname', {
                    nickname: trimmed,
                  });
                  if (r?.status === 'complete') {
                    go('/player/homeworld');
                  }
                }, reportError)}
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
