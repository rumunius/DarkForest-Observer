import {accountPermissions, type Actor} from '../storage/store';
import {DUTIES} from './accounts';

import {
  addChange,
  type ManagementImpactContext,
} from './management_impact_context';
/** 预览账号版本、权限及会话撤销，不暴露凭据。 */
export function accountImpact(context: ManagementImpactContext): void {
  const {engine, db, target, body, consequences} = context;

  const accountActor = db.one<Actor>(
    'SELECT * FROM accounts WHERE id=?',
    target,
  )!;
  addChange(
    context,
    `${target}账号版本`,
    accountActor.version,
    accountActor.version + 1,
  );
  if (body.operation === 'disable' || body.operation === 'enable') {
    addChange(
      context,
      `${target}账号可用`,
      !!accountActor.enabled,
      body.operation === 'enable',
    );
  } else if (body.operation === 'duty') {
    addChange(
      context,
      `${target}职责权限`,
      accountPermissions(accountActor),
      DUTIES[body.duty as keyof typeof DUTIES],
    );
  } else {
    addChange(
      context,
      `${target}登录口令`,
      '现有口令',
      '生成新口令并废止旧口令',
    );
  }
  addChange(
    context,
    `${target}有效会话`,
    db.one<{count: number}>(
      'SELECT COUNT(*) AS count FROM sessions WHERE account_id=? AND revoked=0 AND expires>?',
      target,
      engine.now(),
    )!.count,
    0,
  );
  consequences.push(
    '撤销该账号的旧会话及管理预览；账号停用不会自动淘汰文明，赛事裁决须单独执行。口令不进入预览或普通审计。',
  );
}

/** 预览战报事实及新版本，不重新开赛。 */
export function reportImpact(context: ManagementImpactContext): void {
  const {db, target, body, consequences} = context;

  const row =
    body.field === 'attack_valid'
      ? db.one<Record<string, SqlStorageValue>>(
          'SELECT valid,actor,target FROM attacks WHERE id=?',
          target,
        )
      : body.field === 'nickname'
        ? {nickname: db.player(target).nickname}
        : db.all<Record<string, SqlStorageValue>>(
            'SELECT seq,valid FROM eliminations WHERE player_id=?',
            target,
          );
  addChange(context, `${target}战报事实`, row, {
    field: body.field,
    value: body.value,
  });
  addChange(
    context,
    '战报版本',
    body.expected_version,
    Number(body.expected_version) + 1,
  );
  consequences.push(
    '重算排名并保存新版本，保留旧战报及更正原因；不重新开赛或复用历史手环码。',
  );
}

/** 读取拟公开的权威统计，执行时仍重新计算。 */
export function statisticImpact(context: ManagementImpactContext): void {
  const {engine, db, body, consequences} = context;

  const value =
    body.statistic === 'alive_homeworlds'
      ? db.one<{count: number}>(
          "SELECT COUNT(*) AS count FROM homeworlds WHERE status='verified' AND destroyed_game IS NULL AND player_id IN (SELECT player_id FROM roster_members)",
        )!.count
      : body.statistic === 'unused_photoids'
        ? db.one<{count: number}>(
            "SELECT COALESCE(SUM(p.photons),0) AS count FROM players p JOIN flights f ON f.player_id=p.id WHERE p.entry_status='registered' AND f.status!='eliminated' AND p.id IN (SELECT player_id FROM roster_members)",
          )!.count
        : db.one<{count: number}>(
            "SELECT COUNT(*) AS count FROM attacks WHERE classification='hit' AND valid=1 AND game_ms>?",
            engine.game() - 600000,
          )!.count;
  addChange(context, '拟公开的实时统计', '尚未发布本次统计', {
    statistic: body.statistic,
    value,
  });
  consequences.push(
    '执行时重新读取权威统计；产生群公告待办，不消耗正式广播额度或安排歌者。',
  );
}

/** 预览已公布事件的重播待办，不执行事件效果。 */
export function replayImpact(context: ManagementImpactContext): void {
  const {db, body, consequences} = context;

  const rows = db.all<Record<string, SqlStorageValue>>(
    'SELECT id,title,body,code FROM event_log WHERE audience=? ORDER BY seq DESC LIMIT ?',
    'public',
    Number(body.count),
  );
  addChange(context, '拟重播的公开事件', '未创建本次重播待办', rows);
  consequences.push('只为已公布事件创建重播通知，不再次执行事件效果。');
}

/** 预览公告或延迟消息及独立通知待办。 */
export function announcementImpact(context: ManagementImpactContext): void {
  const {target, body, consequences} = context;

  addChange(context, '消息或公开统计', '尚未发布本次消息', {
    target,
    message: body.message ?? null,
    statistic: body.statistic ?? null,
    replayCount: body.count ?? null,
    delaySeconds: body.seconds ?? 0,
  });
  consequences.push(
    '生成独立公告或通知待办，不消耗玩家广播额度、不安排歌者；复制与QQ发送仍须分别记录。',
  );
}
