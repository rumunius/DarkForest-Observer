import {
  integer,
  nickname,
  text,
} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  commandSpec,
  durationMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {techBurstCopy} from '../../../../packages/contracts/src/message_copy';
import {Fault, permission, requireThat} from '../storage/store';
import type {CommandContext} from './command_context';
import {
  requireLivingTarget,
  validateCommandArguments,
  recordChange,
  requireForestPhase,
  requireHeadJudge,
  invokeJudgeAction,
  requireCommandArgument,
  recordPopulationDependency,
  requireRunningMatch,
  saveCommandObject,
  selectTargets,
  recordTableDependency,
  renderCommandTemplate,
  commandValue,
} from './command_context';
import {score} from './command_targets';
import {destroyHome, eliminate, logEvent} from './life';
import {restorePlayer} from './player_correction';

/** Execute player commands inside the caller's existing preview or commit transaction. */
export function handlePlayerAction(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  const spec = commandSpec(commandNode)!;

  permission(commandContext.actor, spec.permission);

  validateCommandArguments(commandNode);

  const engine = commandContext.engine;

  const db = engine.db;

  const matchState = db.match();

  const path = spec.path;

  const commandArguments = commandNode.words
    .slice(path.split(' ').length)
    .map(v => commandValue(v, commandContext));

  const source = `judge:${commandContext.actor.id}:${commandContext.id}:${commandContext.work}`;

  const chosen = (index = 0, pool = false) =>
    selectTargets(commandContext, commandArguments[index]!, pool);

  const each = (action: (id: string) => void, pool = false) => {
    const ids = chosen(0, pool);
    for (const id of ids) {
      if (++commandContext.work > COMMAND_LIMITS.work) {
        throw new Fault(
          413,
          'COMMAND_BUDGET',
          '一次提交的操作过多，请缩小范围，或添加 --mode sequential 分步执行。',
        );
      }
      const before = {
        player: db.player(id),
        flight: db.flight(id),
        home: db.home(id) ?? null,
      };
      action(id);
      recordChange(commandContext, id, before, {
        player: db.player(id),
        flight: db.flight(id),
        home: db.home(id) ?? null,
      });
    }
    if (!ids.length) {
      commandContext.notes.push('0人，无变化。');
    }
    return ids;
  };

  if (path === 'clock pause' || path === 'clock resume') {
    return invokeJudgeAction(
      commandContext,
      path.endsWith('pause') ? '/judge/pause' : '/judge/resume',
      {},
    );
  }

  if (path === 'player eliminate' || path === 'hunt eliminate') {
    requireHeadJudge(commandContext);
    requireRunningMatch(commandContext);
    recordPopulationDependency(commandContext);
    return each(id => {
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
      eliminate(
        engine,
        id,
        reason,
        source,
        engine.game(),
        engine.now(),
        source,
      );
    });
  }

  if (path === 'player restore') {
    requireHeadJudge(commandContext);
    requireRunningMatch(commandContext);
    recordPopulationDependency(commandContext);
    recordTableDependency(commandContext, 'sighting_codes');
    return each(id =>
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

  if (path === 'player rename') {
    return each(id => {
      const name = nickname(
        renderCommandTemplate(commandContext, commandArguments[1]!, id),
      );
      requireCommandArgument(
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM players WHERE nickname=? AND id<>?',
          name,
          id,
        ),
        '昵称已被使用',
      );
      db.exec('UPDATE players SET nickname=? WHERE id=?', name, id);
    });
  }

  if (
    [
      'resource set',
      'resource add',
      'photon grant',
      'photon revoke',
      'tech grant',
    ].includes(path)
  ) {
    requireHeadJudge(commandContext);
    requireRunningMatch(commandContext);
    return each(id => {
      const playerState = db.player(id);
      const key = path.startsWith('resource')
        ? commandArguments[1]!
        : 'photons';
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

  if (path.startsWith('penalty ')) {
    requireHeadJudge(commandContext);
    requireRunningMatch(commandContext);
    return each(id => {
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

  if (path === 'tag add' || path === 'tag remove') {
    return each(id => {
      const tag = text(commandArguments[1], 1024);
      if (path === 'tag add') {
        db.exec('INSERT OR IGNORE INTO command_tags VALUES(?,?)', id, tag);
      } else {
        db.exec(
          'DELETE FROM command_tags WHERE player_id=? AND tag=?',
          id,
          tag,
        );
      }
      recordChange(
        commandContext,
        id + '标签',
        path.endsWith('add') ? '未添加' : '已添加',
        tag,
      );
    }, true);
  }

  if (path === 'preflight note') {
    return each(id => {
      saveCommandObject(commandContext, 'preflight', {
        target: id,
        note: commandArguments[1],
      });
    }, true);
  }

  if (path === 'observer revoke' || path === 'observer restore') {
    requireHeadJudge(commandContext);
    return each(id => {
      db.exec(
        'UPDATE players SET observer_revoked=? WHERE id=?',
        path.endsWith('revoke') ? 1 : 0,
        id,
      );
    });
  }

  if (path === 'homeworld destroy' || path === 'homeworld restore') {
    requireHeadJudge(commandContext);
    requireForestPhase(commandContext);
    recordPopulationDependency(commandContext);
    return each(id => {
      const homeworld = db.home(id);
      requireThat(
        homeworld?.status === 'verified',
        'HOME_NOT_VERIFIED',
        '目标尚无已审核母星。',
      );
      if (path.endsWith('destroy')) {
        if (
          destroyHome(
            engine,
            id,
            `${source}:${id}`,
            engine.game(),
            engine.now(),
          )
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

  throw new Fault(400, 'UNKNOWN_COMMAND', '命令没有执行处理器：' + path);
}
