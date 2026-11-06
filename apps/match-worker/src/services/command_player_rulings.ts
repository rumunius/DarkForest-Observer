import {requireThat} from '../storage/store';
import {
  recordPopulationDependency,
  recordTableDependency,
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
import {destroyHome, eliminate, logEvent} from './life';
import {restorePlayer} from './player_correction';

/** 核对裁判、阶段和存活目标，再按原来源批量记录淘汰。 */
export function eliminateCommandPlayers(
  context: CommandPlayerContext,
): unknown {
  const {commandContext, engine, matchState, path, commandArguments, source} =
    context;

  requireHeadJudge(commandContext);
  requireRunningMatch(commandContext);
  recordPopulationDependency(commandContext);
  return forEachCommandPlayer(context, id => {
    requireLivingTarget(commandContext, id);
    const reason = commandArguments[1] ?? 'judge_intervention';
    requireCommandArgument(
      (path === 'hunt eliminate'
        ? ['left_zone', 'sharing_stopped', 'location_violation']
        : ['judge_intervention', 'serious-violation', 'withdrawal']
      ).includes(reason),
      '未知淘汰原因',
    );
    if (path === 'hunt eliminate') {
      requireThat(
        matchState.phase === 'hunt' &&
          matchState.hunt_finalized !== null &&
          matchState.paused_at === null,
        'HUNT_NOT_RUNNING',
        '最后狩猎尚未开始。',
      );
    }
    eliminate(engine, id, reason, source, engine.game(), engine.now(), source);
  });
}

/** 核对人口与码本依赖，使用新配置恢复文明资格。 */
export function restoreCommandPlayers(context: CommandPlayerContext): unknown {
  const {commandContext, engine, source} = context;

  requireHeadJudge(commandContext);
  requireRunningMatch(commandContext);
  recordPopulationDependency(commandContext);
  recordTableDependency(commandContext, 'sighting_codes');
  return forEachCommandPlayer(context, id =>
    restorePlayer(
      engine,
      id,
      `${commandContext.id}-${commandContext.work}-${id}`,
      `${source}:${id}`,
      commandContext.prepared,
      true,
    ),
  );
}

/** 设置观战管理限制，实际资格仍由既有投影检查。 */
export function changeCommandObservation(
  context: CommandPlayerContext,
): unknown {
  const {commandContext, db, path} = context;

  requireHeadJudge(commandContext);
  return forEachCommandPlayer(context, id => {
    db.exec(
      'UPDATE players SET observer_revoked=? WHERE id=?',
      path.endsWith('revoke') ? 1 : 0,
      id,
    );
  });
}

/** 通过领域母星操作及原通知处理摧毁或恢复，保留人口依赖。 */
export function changeCommandHomeworlds(
  context: CommandPlayerContext,
): unknown {
  const {commandContext, engine, db, path, source} = context;

  requireHeadJudge(commandContext);
  requireForestPhase(commandContext);
  recordPopulationDependency(commandContext);
  return forEachCommandPlayer(context, id => {
    const homeworld = db.home(id);
    requireThat(
      homeworld?.status === 'verified',
      'HOME_NOT_VERIFIED',
      '目标尚无已审核母星。',
    );
    if (path.endsWith('destroy')) {
      if (
        destroyHome(engine, id, `${source}:${id}`, engine.game(), engine.now())
      ) {
        logEvent(
          engine,
          `${source}:home:${id}`,
          'review',
          '裁判母星毁灭',
          `文明${engine.identity(id)}的母星${homeworld.code}已被摧毁。`,
          'public',
          [id],
          engine.game(),
          engine.now(),
          null,
          homeworld.code,
        );
        engine.notice(
          `${source}:home`,
          'group',
          '母星毁灭',
          `文明${engine.identity(id)}的母星${homeworld.code}已被摧毁。`,
        );
      }
    } else {
      db.exec(
        'UPDATE homeworlds SET destroyed_game=NULL WHERE player_id=?',
        id,
      );
      engine.notice(
        source,
        id,
        '母星恢复',
        `文明${engine.identity(id)}，你的母星${homeworld.code}已恢复。请打开本人官网查看状态和后续行动。`,
      );
    }
  });
}
