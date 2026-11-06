import {
  nickname,
  parseJson,
  scalarText,
} from '../../../../packages/contracts/src/backend';
import {observerAllowed} from '../projections/snapshot';
import {correctionTarget} from './attack_correction';

import {
  addChange,
  issuanceImpact,
  restorationImpact,
  type ManagementImpactContext,
} from './management_impact_context';

/** 预览文明昵称、资源或恢复资格的更正。 */
export function correctionImpact(context: ManagementImpactContext): void {
  const {db, target, body} = context;

  const playerState = db.player(target);
  if (body.field === 'restore') {
    restorationImpact(context, target);
  } else if (body.field === 'nickname') {
    addChange(
      context,
      `${target}昵称`,
      playerState.nickname,
      nickname(body.value),
    );
  } else if (body.field === 'photons') {
    addChange(
      context,
      `${target}光粒`,
      playerState.photons,
      Number(body.value),
    );
    addChange(
      context,
      `${target}技术升级`,
      playerState.tech,
      Number(body.value) === 1 ? 1 : playerState.tech,
    );
  } else {
    addChange(
      context,
      `${target}剩余广播`,
      2 - playerState.broadcasts,
      Number(body.value),
    );
  }
}

/** 预览实物替换、重新发码或激活对航次的影响。 */
export function equipmentImpact(context: ManagementImpactContext): void {
  const {db, target, body, consequences} = context;

  const flight = db.flight(target);
  addChange(
    context,
    `${target}当前配置`,
    flight.code_id,
    body.mode === 'reissue' ? '新配置（执行时随机签发）' : flight.code_id,
  );
  addChange(
    context,
    `${target}航次`,
    flight.voyage,
    body.mode === 'reissue' ? flight.voyage + 1 : flight.voyage,
  );
  addChange(
    context,
    `${target}飞船`,
    flight.status,
    body.mode === 'replace'
      ? flight.status
      : body.mode === 'activate'
        ? 'active'
        : 'issued',
  );
  if (body.mode === 'reissue') {
    issuanceImpact(context);
  } else {
    consequences.push(
      body.mode === 'replace'
        ? '仅记录同色同款实物替换，当前码、航次及容量均保持原值。'
        : '激活当前保留配置；暂停、阶段和个人禁攻仍分别判定。',
    );
  }
}

/** 预览攻击撤销、处罚回退及相关文明恢复。 */
export function attackCorrectionImpact(context: ManagementImpactContext): void {
  const {engine, db, body, consequences} = context;

  const attack = correctionTarget(engine, body.attack_id);
  const before = parseJson(attack.before_json!) as {
    wrong: number;
    lockedUntil: number;
    actorHomeDestroyed: number | null;
  };
  addChange(context, '攻击记录有效性', !!attack.valid, false);
  if (attack.wrong_index !== null) {
    const control = db.one<{wrong: number; locked_until: number}>(
      'SELECT * FROM attack_controls WHERE player_id=?',
      attack.actor,
    )!;
    addChange(
      context,
      `${attack.actor}错误提交累计`,
      control.wrong,
      before.wrong,
    );
    addChange(
      context,
      `${attack.actor}禁攻截止UTC`,
      control.locked_until,
      before.lockedUntil,
    );
    if (
      db.home(attack.actor)?.source ===
      `action:${attack.actor}:${attack.request_id}`
    ) {
      addChange(
        context,
        `${attack.actor}母星毁灭时刻`,
        db.home(attack.actor)?.destroyed_game,
        before.actorHomeDestroyed,
      );
    }
  }
  const restored =
    attack.classification === 'hit'
      ? attack.target
      : db.flight(attack.actor).status === 'eliminated'
        ? attack.actor
        : null;
  if (restored) {
    addChange(context, `${restored}飞船`, db.flight(restored).status, 'issued');
    addChange(
      context,
      `${restored}有效淘汰记录数`,
      db.one<{count: number}>(
        'SELECT COUNT(*) AS count FROM eliminations WHERE player_id=? AND valid=1',
        restored,
      )!.count,
      0,
    );
    addChange(
      context,
      `${restored}赛中观战`,
      observerAllowed(engine, db.player(restored)),
      false,
    );
    addChange(
      context,
      `${restored}重生期限`,
      db.flight(restored).deadline,
      null,
    );
    issuanceImpact(context);
    consequences.push(
      '取消该文明的旧重生超时任务，赛中观战立即关闭，新增攻击更正通知。',
    );
  }
  const count = (exclude: boolean) =>
    db.one<{count: number}>(
      `SELECT COUNT(DISTINCT target) AS count FROM attacks WHERE actor=? AND classification='hit' AND valid=1${exclude ? ' AND id<>?' : ''}`,
      attack.actor,
      ...(exclude ? [attack.id] : []),
    )!.count;
  addChange(context, `${attack.actor}去重击毁`, count(false), count(true));
  consequences.push(
    '保留原攻击、既定抽签及已发通知，写入独立更正记录；已泄露情报无法收回。',
  );
}

/** 预览按真实UTC计时的临时目击限制。 */
export function effectImpact(context: ManagementImpactContext): void {
  const {engine, db, target, body, consequences} = context;

  if (body.revoke) {
    const effect = db.one<Record<string, SqlStorageValue>>(
      'SELECT target,starts,ends,active FROM admin_effects WHERE id=?',
      scalarText(body.revoke),
    )!;
    addChange(context, scalarText(body.revoke), effect, {...effect, active: 0});
  } else {
    addChange(context, '临时禁止目击', '无该项效果', {
      target,
      starts: engine.now(),
      ends: engine.now() + Number(body.seconds) * 1000,
    });
  }
  consequences.push('按真实UTC计时；不冻结比赛、不解除个人处罚或阶段限制。');
}

/** 预览管理限制与实际观战资格的差别。 */
export function observerImpact(context: ManagementImpactContext): void {
  const {engine, db, target, body, consequences} = context;

  addChange(
    context,
    `${target}观战管理限制`,
    !!db.player(target).observer_revoked,
    !body.allowed,
  );
  addChange(
    context,
    `${target}当前赛中观战资格`,
    observerAllowed(engine, db.player(target)),
    observerAllowed(engine, {
      ...db.player(target),
      observer_revoked: body.allowed ? 0 : 1,
    }),
  );
  consequences.push(
    '解除管理限制仍须满足永久淘汰及真实UTC等待，不会提前授予观战资格。',
  );
}
