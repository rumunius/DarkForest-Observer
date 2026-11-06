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
  n: CommandNode,
): unknown {
  const spec = commandSpec(n)!;

  permission(commandContext.actor, spec.permission);

  validateCommandArguments(n);

  const e = commandContext.e;

  const db = e.db;

  const path = spec.path;

  const a = n.words
    .slice(path.split(' ').length)
    .map(v => commandValue(v, commandContext));

  const chosen = (index = 0, pool = false) =>
    selectTargets(commandContext, a[index]!, pool);

  if (path === 'reveal') {
    const ids = chosen();
    let stats: unknown;
    if (n.block) {
      requireCommandArgument(
        a[1] === 'run' &&
          n.block.length === 1 &&
          n.block[0]!.words[0] === 'stats',
        'reveal run只接受一条统计查询',
      );
      stats = statistic(commandContext, n.block[0]!);
    } else {
      requireCommandArgument(a.length === 2, 'reveal需要目标和统计项');
      if (a[1] === 'alive-homeworlds') {
        stats = {
          aliveHomeworlds: db.one<{n: number}>(
            "SELECT COUNT(*) n FROM homeworlds WHERE status='verified' AND destroyed_game IS NULL AND player_id IN (SELECT player_id FROM roster_members)",
          )!.n,
        };
      } else if (a[1] === 'unused-photoids') {
        stats = statistic(commandContext, {
          words: ['stats', 'sum', 'photons', 'of', '@alive'],
          options: {},
        });
      } else {
        requireCommandArgument(a[1] === 'kills-last-10min', '未知快捷统计');
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
      a[0] === '@a',
    );
    return;
  }

  if (path === 'replay') {
    const ids = chosen();
    for (const r of db.all<{title: string; body: string; code: string | null}>(
      "SELECT title,body,code FROM event_log WHERE audience='public' ORDER BY seq DESC LIMIT ?",
      integer(Number(a[2]), 1, COMMAND_LIMITS.maxPage),
    )) {
      commandContext.work++;
      emitCommandMessage(
        commandContext,
        ids,
        `重播：${r.title}\n${r.body}${r.code ? '\n坐标：' + r.code : ''}`,
        a[0] === '@a',
      );
    }
    return;
  }

  if (path === 'message retract') {
    const row = db.one<Record<string, SqlStorageValue>>(
      'SELECT * FROM event_log WHERE id=? AND kind=?',
      a[0]!,
      'notice',
    );
    requireCommandArgument(row, '只能撤回管理消息');
    saveCommandObject(commandContext, 'retraction', {
      message: a[0],
      reason: commandContext.reason,
    });
    db.exec(
      "UPDATE event_log SET body='[裁判已撤回此消息；已阅读及QQ发送事实保留]' WHERE id=?",
      a[0]!,
    );
    recordChange(
      commandContext,
      a[0]!,
      '可见',
      '网站标记撤回，已阅读/已发送事实保留',
    );
    return;
  }

  if (path === 'notice mark' || path === 'notice retry') {
    const row = db.one<{id: string; version: number; status: string}>(
      'SELECT * FROM notice_queue WHERE id=?',
      a[0]!,
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
      ['copied', 'sent', 'failed'].includes(a[1]!),
      '状态为copied/sent/failed',
    );
    return judgeAction(
      e,
      commandContext.actor,
      `${commandContext.id}-${commandContext.work}`,
      `/judge/notices/${row.id}/${a[1] === 'failed' ? 'error' : a[1]}`,
      {
        request_id: `${commandContext.id}-${commandContext.work}`,
        expected_version: row.version,
        reason: a[2] ?? commandContext.reason,
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
