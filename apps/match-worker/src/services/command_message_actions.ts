import {integer} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  commandSpec,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {Fault, permission} from '../storage/store';
import type {CommandContext} from './command_context';
import {
  validateCommandArguments,
  recordChange,
  recordDependency,
  emitCommandMessage,
  requireHeadJudge,
  invokeJudgeAction,
  requireCommandArgument,
  saveCommandObject,
  selectTargets,
  recordTableDependency,
  commandValue,
} from './command_context';
import {statistic} from './command_query';
import {judgeAction} from './judge';

/** Execute message commands inside the caller's existing preview or commit transaction. */
export function handleMessageAction(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  const spec = commandSpec(commandNode)!;

  permission(commandContext.actor, spec.permission);

  validateCommandArguments(commandNode);

  const engine = commandContext.engine;

  const db = engine.db;

  const path = spec.path;

  const commandArguments = commandNode.words
    .slice(path.split(' ').length)
    .map(v => commandValue(v, commandContext));

  const chosen = (index = 0, pool = false) =>
    selectTargets(commandContext, commandArguments[index]!, pool);

  if (path === 'reveal') {
    const ids = chosen();
    let stats: unknown;
    if (commandNode.block) {
      requireCommandArgument(
        commandArguments[1] === 'run' &&
          commandNode.block.length === 1 &&
          commandNode.block[0]!.words[0] === 'stats',
        'reveal run只接受一条统计查询',
      );
      stats = statistic(commandContext, commandNode.block[0]!);
    } else {
      requireCommandArgument(
        commandArguments.length === 2,
        'reveal需要目标和统计项',
      );
      if (commandArguments[1] === 'alive-homeworlds') {
        stats = {
          aliveHomeworlds: db.one<{n: number}>(
            "SELECT COUNT(*) n FROM homeworlds WHERE status='verified' AND destroyed_game IS NULL AND player_id IN (SELECT player_id FROM roster_members)",
          )!.n,
        };
      } else if (commandArguments[1] === 'unused-photoids') {
        stats = statistic(commandContext, {
          words: ['stats', 'sum', 'photons', 'of', '@alive'],
          options: {},
        });
      } else {
        requireCommandArgument(
          commandArguments[1] === 'kills-last-10min',
          '未知快捷统计',
        );
        stats = statistic(commandContext, {
          words: ['stats', 'events', 'sighting-hit', 'window', '10m'],
          options: {},
        });
      }
    }
    emitCommandMessage(
      commandContext,
      ids,
      '赛事统计：' + JSON.stringify(stats),
      commandArguments[0] === '@a',
    );
    return;
  }

  if (path === 'replay') {
    const ids = chosen();
    for (const r of db.all<{title: string; body: string; code: string | null}>(
      "SELECT title,body,code FROM event_log WHERE audience='public' ORDER BY seq DESC LIMIT ?",
      integer(Number(commandArguments[2]), 1, COMMAND_LIMITS.maxPage),
    )) {
      commandContext.work++;
      emitCommandMessage(
        commandContext,
        ids,
        `重播：${r.title}\n${r.body}${r.code ? '\n坐标：' + r.code : ''}`,
        commandArguments[0] === '@a',
      );
    }
    return;
  }

  if (path === 'message retract') {
    const row = db.one<Record<string, SqlStorageValue>>(
      'SELECT * FROM event_log WHERE id=? AND kind=?',
      commandArguments[0]!,
      'notice',
    );
    requireCommandArgument(row, '只能撤回管理消息');
    saveCommandObject(commandContext, 'retraction', {
      message: commandArguments[0],
      reason: commandContext.reason,
    });
    db.exec(
      "UPDATE event_log SET body='[裁判已撤回此消息；已阅读及QQ发送事实保留]' WHERE id=?",
      commandArguments[0]!,
    );
    recordChange(
      commandContext,
      commandArguments[0]!,
      '可见',
      '网站标记撤回，已阅读/已发送事实保留',
    );
    return;
  }

  if (path === 'notice mark' || path === 'notice retry') {
    const row = db.one<{id: string; version: number; status: string}>(
      'SELECT * FROM notice_queue WHERE id=?',
      commandArguments[0]!,
    );
    requireCommandArgument(row, '通知不存在');
    recordDependency(commandContext, 'notice:' + row.id, row);
    if (path === 'notice retry') {
      requireCommandArgument(
        row.status !== 'sent',
        '已发送通知不能伪造未发送；请创建更正通知',
      );
      db.exec(
        "UPDATE notice_queue SET status='pending',version=version+1,error='' WHERE id=?",
        row.id,
      );
      return;
    }
    requireCommandArgument(
      ['copied', 'sent', 'failed'].includes(commandArguments[1]!),
      '状态为copied/sent/failed',
    );
    return judgeAction(
      engine,
      commandContext.actor,
      `${commandContext.id}-${commandContext.work}`,
      `/judge/notices/${row.id}/${commandArguments[1] === 'failed' ? 'error' : commandArguments[1]}`,
      {
        request_id: `${commandContext.id}-${commandContext.work}`,
        expected_version: row.version,
        reason: commandArguments[2] ?? commandContext.reason,
      },
      commandContext.prepared,
    );
  }

  if (path === 'roster add' || path === 'roster remove') {
    requireHeadJudge(commandContext);
    recordTableDependency(commandContext, 'roster_members');
    const ids = chosen(0, true);
    const current = db.roster();
    return invokeJudgeAction(commandContext, '/judge/roster', {
      members: path.endsWith('add')
        ? [...new Set([...current, ...ids])].sort()
        : current.filter(id => !ids.includes(id)),
    });
  }

  throw new Fault(400, 'UNKNOWN_COMMAND', '命令没有执行处理器：' + path);
}
