import {
  integer,
  nickname,
  object,
  scalarText,
} from '../../../../packages/contracts/src/backend';
import {HUNT_START_COPY} from '../../../../packages/contracts/src/message_copy';
import {TIMES} from '../domain/rules';
import {requireThat} from '../storage/store';
import type {JudgeMutationContext} from './judge_action_context';
import {closePause} from './judge_clock';
import {autoFinish, eliminate, retire} from './life';
import {restorePlayer} from './player_correction';
/** 完成整批截止淘汰并关闭暂停后，再进行一次提前完赛判定。 */
export function finalizeHunt(context: JudgeMutationContext): void {
  const {raw, engine, matchState, db, now, source, game} = context;
  for (const rawOut of raw.eliminations as unknown[]) {
    const out = object(rawOut);
    eliminate(
      engine,
      String(out.id),
      String(out.reason),
      'hunt_cutoff',
      TIMES.cutoff,
      matchState.paused_at!,
      'hunt_cutoff',
    );
  }
  db.exec('UPDATE matches SET hunt_finalized=?', now);
  closePause(engine, now);
  autoFinish(engine, TIMES.cutoff, matchState.paused_at!, source);
  if (db.match().phase !== 'ended') {
    engine.notice(source, 'group', '最后狩猎开始', HUNT_START_COPY, game);
  }
}

/** 撤销或登记裁判UTC攻击限制，保持原来源和期限。 */
export function updateAttackRestriction(context: JudgeMutationContext): void {
  const {raw, db, id, now, reason, actor} = context;
  if (raw.revoke) {
    db.exec(
      'UPDATE admin_effects SET active=0 WHERE id=?',
      scalarText(raw.revoke),
    );
  } else {
    db.exec(
      'INSERT INTO admin_effects VALUES(?,?,?,?,?,?,1)',
      `FX-${id}`,
      String(raw.target),
      now,
      now + integer(raw.seconds) * 1000,
      reason,
      actor.name,
    );
  }
}

/** 重新发行或激活当前航次配置，激活仍核对预留状态。 */
export function correctEquipment(context: JudgeMutationContext): void {
  const {raw, engine, game, now, id, prepared, db} = context;
  const target = String(raw.target);
  if (raw.mode === 'reissue') {
    retire(engine, target, 'equipment_correction', game, now);
    engine.issue(target, id, prepared);
    db.exec("UPDATE flights SET status='issued' WHERE player_id=?", target);
  } else if (raw.mode === 'activate') {
    requireThat(
      db.all<Record<string, SqlStorageValue>>(
        "UPDATE sighting_codes SET status='active',activated_utc=?,activated_game=? WHERE id=? AND status='reserved' RETURNING id",
        now,
        game,
        db.flight(target).code_id,
      ).length === 1,
      'CODE_STATE_CONFLICT',
      '请重新核对当前配置。',
    );
    db.exec("UPDATE flights SET status='active' WHERE player_id=?", target);
  }
}

/** 在预览已核对的事务内更正文明确认字段或恢复资格。 */
export function correctPlayerState(context: JudgeMutationContext): void {
  const {raw, db, engine, id, source, prepared} = context;
  const target = String(raw.target);
  if (raw.field === 'nickname') {
    db.exec(
      'UPDATE players SET nickname=? WHERE id=?',
      nickname(raw.value),
      target,
    );
  } else if (raw.field === 'photons') {
    db.exec(
      'UPDATE players SET photons=?,tech=CASE WHEN ?=1 THEN 1 ELSE tech END WHERE id=?',
      Number(raw.value),
      Number(raw.value),
      target,
    );
  } else if (raw.field === 'broadcasts') {
    db.exec(
      'UPDATE players SET broadcasts=? WHERE id=?',
      2 - Number(raw.value),
      target,
    );
  } else {
    restorePlayer(engine, target, id, source, prepared);
  }
}
