import {integer} from '../../../../packages/contracts/src/backend';
import {durationMs} from '../../../../packages/contracts/src/commands';
import {techBurstCopy} from '../../../../packages/contracts/src/message_copy';
import {
  recordChange,
  requireCommandArgument,
  requireForestPhase,
  requireHeadJudge,
  requireLivingTarget,
  requireRunningMatch,
} from './command_context';
import {
  forEachCommandPlayer,
  type CommandPlayerContext,
} from './command_player_context';
import {score} from './command_targets';
import {logEvent} from './life';

/** 在资源范围与阶段约束内修改库存，分别记录本人事件及通知。 */
export function changeCommandResources(context: CommandPlayerContext): unknown {
  const {commandContext, engine, db, path, commandArguments, source} = context;

  requireHeadJudge(commandContext);
  requireRunningMatch(commandContext);
  return forEachCommandPlayer(context, id => {
    const playerState = db.player(id);
    const key = path.startsWith('resource') ? commandArguments[1]! : 'photons';
    requireCommandArgument(
      ['tech-level', 'photons', 'broadcasts'].includes(key),
      '资源键不正确',
    );
    const before =
      key === 'tech-level' ? playerState.tech : score(engine, id, key);
    const delta =
      path === 'photon revoke'
        ? 0
        : path.startsWith('resource')
          ? Number(commandArguments[2])
          : 1;
    const after = path === 'resource add' ? before + delta : delta;
    integer(after, 0, key === 'broadcasts' ? 2 : 1);
    if (after > before || path === 'tech grant') {
      requireForestPhase(commandContext);
      requireLivingTarget(commandContext, id);
    }
    if (key === 'tech-level') {
      db.exec(
        'UPDATE players SET tech=?,photons=CASE WHEN ?=0 THEN 0 ELSE photons END WHERE id=?',
        after,
        after,
        id,
      );
    } else if (key === 'photons') {
      db.exec(
        'UPDATE players SET photons=?,tech=CASE WHEN ?=1 THEN 1 ELSE tech END WHERE id=?',
        after,
        after,
        id,
      );
    } else {
      db.exec('UPDATE players SET broadcasts=? WHERE id=?', 2 - after, id);
    }
    const resourceName = {
      'tech-level': '文明技术等级',
      photons: '光粒库存',
      broadcasts: '剩余广播次数',
    }[key]!;
    const title = path === 'tech grant' ? '技术爆炸' : '资源调整';
    const message =
      path === 'tech grant'
        ? techBurstCopy(engine.identity(id))
        : `${engine.identity(id)}的${resourceName}由${before}调整为${after}。`;
    logEvent(
      engine,
      `${source}:resource:${id}`,
      path === 'tech grant' ? 'tech' : 'notice',
      title,
      message,
      'personal',
      [id],
      engine.game(),
      engine.now(),
      id,
    );
    engine.notice(source, id, title, message);
  });
}

/** 按真实UTC调整个人处罚并记录原处罚与新处罚。 */
export function changeCommandPenalties(context: CommandPlayerContext): unknown {
  const {commandContext, engine, db, path, commandArguments} = context;

  requireHeadJudge(commandContext);
  requireRunningMatch(commandContext);
  return forEachCommandPlayer(context, id => {
    const control = db.one<Record<string, SqlStorageValue>>(
      'SELECT * FROM attack_controls WHERE player_id=?',
      id,
    )!;
    if (path === 'penalty wrong-set') {
      db.exec(
        'UPDATE attack_controls SET wrong=? WHERE player_id=?',
        integer(Number(commandArguments[1]), 0, 3),
        id,
      );
    } else {
      const until =
        path === 'penalty clear'
          ? 0
          : engine.now() + durationMs(commandArguments[2]!);
      integer(until);
      db.exec(
        'UPDATE attack_controls SET locked_until=? WHERE player_id=?',
        until,
        id,
      );
    }
    recordChange(
      commandContext,
      `${id}处罚`,
      control,
      db.one<Record<string, SqlStorageValue>>(
        'SELECT * FROM attack_controls WHERE player_id=?',
        id,
      ),
    );
  });
}
