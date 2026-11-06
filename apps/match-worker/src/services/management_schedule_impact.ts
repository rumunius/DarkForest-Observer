import {parseJson} from '../../../../packages/contracts/src/backend';
import {dueUtc} from '../scheduler/events';
import {type Scheduled} from '../storage/store';

import {
  addChange,
  eliminationImpact,
  type ManagementImpactContext,
} from './management_impact_context';
/** 预览原事件取消或补结算，保留原定时刻。 */
export function eventControlImpact(context: ManagementImpactContext): void {
  const {db, body, consequences} = context;

  const event = db.one<Scheduled>(
    'SELECT * FROM scheduled_events WHERE id=?',
    String(body.event_id),
  )!;
  addChange(
    context,
    event.id,
    event.status,
    body.operation === 'cancel' ? 'cancelled' : 'settled（已结算时幂等返回）',
  );
  addChange(
    context,
    '事件原定时刻',
    {clock: event.clock, due: event.due},
    {clock: event.clock, due: event.due},
  );
  consequences.push(
    body.operation === 'cancel'
      ? '不回滚已发生效果；取消后不能用重试重新打开该事件。'
      : '按原ID、原时刻及队列顺序补结算；持续故障将返回失败，已结算事件不会重复执行。',
  );
  if (event.kind === 'song_visit') {
    const payload = (() => {
      try {
        return parseJson(event.payload) as {code?: string};
      } catch {
        return {};
      }
    })();
    const home = payload.code ? db.officialHome(payload.code, true) : undefined;
    if (home && body.operation === 'retry' && event.status === 'pending') {
      addChange(context, `${home.player_id}母星`, '尚存', '毁灭');
      if (
        !['active', 'eliminated'].includes(db.flight(home.player_id).status)
      ) {
        eliminationImpact(context, [home.player_id]);
      }
    }
  }
}

/** 预览独立手动歌者事件及母星和文明变化。 */
export function eventTriggerImpact(context: ManagementImpactContext): void {
  const {engine, db, body, consequences} = context;

  const homeworld = db.officialHome(String(body.code), true);
  addChange(context, '手动歌者事件', '无', {
    clock: 'game',
    due: engine.game(),
    code: body.code,
    target: homeworld?.player_id ?? null,
  });
  if (homeworld) {
    addChange(context, `${homeworld.player_id}母星`, '尚存', '毁灭');
    if (
      !['active', 'eliminated'].includes(db.flight(homeworld.player_id).status)
    ) {
      eliminationImpact(context, [homeworld.player_id]);
    }
  }
  consequences.push(
    '新增独立管理来源ID，不复用已取消事件；同事务完成清理及通知。空坐标和已毁母星按未摧毁现存母星结算。',
  );
}

/** 预览统一发码或开赛时间及确认名单。 */
export function armingImpact(
  context: ManagementImpactContext,
  path: string,
): void {
  const {db, matchState, body, consequences} = context;

  const release = path.endsWith('release');
  addChange(
    context,
    release ? '统一发码UTC' : '统一开赛UTC',
    release ? matchState.release_at : matchState.started_at,
    body.time,
  );
  addChange(context, '正式参赛名单', db.roster(), body.expected_roster);
  consequences.push(
    release
      ? '冻结本场名单和参数；到点开放领码，不提前激活攻防。'
      : '锁定统一开赛及阶段计划，秘密技术爆炸时刻在执行时生成；全部首航在T1统一激活。',
  );
}

/** 预览文明退出正式名单及已发配置退役。 */
export function withdrawalImpact(
  context: ManagementImpactContext,
  path: string,
): void {
  const {db, consequences} = context;

  const id = path.split('/')[3]!;
  addChange(context, `${id}参赛状态`, db.player(id).entry_status, 'absent');
  addChange(
    context,
    '正式名单',
    db.roster(),
    db.roster().filter(p => p !== id),
  );
  consequences.push(
    '当前已发配置永久退役，不能释放回码本；不参与本场后续母星匹配和排名。',
  );
}

/** 预览到期事件及重排唤醒或逐项补结算。 */
export function schedulerImpact(
  context: ManagementImpactContext,
  path: string,
): void {
  const {engine, db, consequences} = context;

  const pending = db.all<Scheduled>(
    "SELECT * FROM scheduled_events WHERE status='pending'",
  );
  const due = pending.filter(event => {
    const utc = dueUtc(engine, event);
    return utc !== null && utc <= engine.now();
  });
  addChange(
    context,
    '到期事件',
    due.map(event => event.id),
    path.endsWith('rearm')
      ? '核查并重新登记最近唤醒'
      : '按顺序逐项结算，遇到故障返回失败',
  );
  consequences.push(
    '保留原事件ID、原定生效时间和已有结算；不重抽既定随机结果。实际处理数量与剩余积压由返回结果提供。',
  );
}

/** 预览结束恢复核对，保持当前暂停。 */
export function recoveryImpact(context: ManagementImpactContext): void {
  const {matchState, consequences} = context;

  addChange(context, '恢复核对状态', matchState.recovery_state, '核对完成');
  consequences.push('结束恢复审查；保持当前暂停，仍需单独确认恢复计时。');
}
