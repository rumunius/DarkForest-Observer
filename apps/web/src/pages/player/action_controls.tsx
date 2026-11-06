import {type ReactNode} from 'react';
import {useApp} from '../../state';
import {CutOutline, Empty, Icon, Link} from '../../ui';

/** 解释当前行动尚不可用的状态，不为无权限动作提供可提交入口。 */
export function LockedAction() {
  const {data} = useApp();
  const me = data.player;
  const match = data.match;
  let reason = '当前没有可以执行的比赛行动。';
  if (match?.stage === 'ended') {
    reason = '比赛已结束，可以查看正式结果和完整复盘。';
  } else if (me?.flight === 'eliminated') {
    reason = '你已永久淘汰，请在安全位置摘下全部比赛手环，步行返回中控室。';
  } else if (['returning', 'preparing', 'issued'].includes(me?.flight ?? '')) {
    reason = '飞船已被击毁，请继续完成当前重生步骤。';
  } else if (match?.verification) {
    reason = '终局资格确认中，请保持QQ群位置共享，等待裁判完成核验。';
  } else if (match?.paused) {
    reason = `比赛已暂停。${match.pauseReason}`;
  } else if (match?.stage === 'transfer') {
    reason =
      '已进入转场，目击攻击暂停。请加入QQ群位置共享，正常步行前往终局圈。';
  } else if (
    me?.attackLockedUntil &&
    me.attackLockedUntil > (match?.serverUtcMs ?? 0)
  ) {
    reason = '暂时禁止目击攻击，请查看恢复时间。';
  }
  return <Empty title="查看当前任务">{reason}</Empty>;
}

/** 为当前步骤提供保持应用导航语义的任务入口。 */
export function TaskButton({to, children}: {to: string; children: ReactNode}) {
  return (
    <Link className="task-button cut" to={to}>
      <span>{children}</span>
      <Icon name="arrow" size={20} />
      <CutOutline />
    </Link>
  );
}
