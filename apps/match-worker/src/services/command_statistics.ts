import {
  durationMs,
  instantMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import type {CommandContext} from './command_context';
import {
  commandValue,
  requireCommandArgument,
  selectTargets,
} from './command_context';
import {score} from './command_targets';

/** 在目标和字段白名单内计算只读统计，不修改赛事状态或奖励。 */
export function statistic(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  const commandArguments = commandNode.words
    .slice(2)
    .map(v => commandValue(v, commandContext));
  const engine = commandContext.engine;
  if (commandNode.words[1] === 'count') {
    return {count: selectTargets(commandContext, commandArguments[0]!).length};
  }
  if (commandNode.words[1] === 'sum') {
    requireCommandArgument(
      commandArguments[1] === 'of',
      '用法：stats sum 字段 of 目标',
    );
    return {
      field: commandArguments[0],
      sum: selectTargets(commandContext, commandArguments[2]!).reduce(
        (sum, id) => sum + score(engine, id, commandArguments[0]!),
        0,
      ),
    };
  }
  const kind = commandArguments[0];
  const window = commandArguments[2] ? durationMs(commandArguments[2]) : null;
  requireCommandArgument(
    !commandArguments[1] || commandArguments[1] === 'window',
    '时间窗口须使用window',
  );
  const lower = window === null ? null : Math.max(0, engine.game() - window);
  let where =
    lower === null
      ? '1=1'
      : lower === 0
        ? 'game_ms>=0 AND game_ms<=?'
        : 'game_ms>? AND game_ms<=?';
  const args: SqlStorageValue[] =
    lower === null
      ? []
      : lower === 0
        ? [engine.game()]
        : [lower, engine.game()];
  if (commandNode.options.target) {
    const ids = selectTargets(commandContext, commandNode.options.target);
    where += ` AND ${kind === 'elimination' ? 'player_id' : 'actor'} IN (${ids.map(() => '?').join(',')})`;
    args.push(...ids);
  }
  const table =
    kind === 'sighting-hit'
      ? 'attacks'
      : kind === 'broadcast'
        ? 'event_log'
        : kind === 'elimination'
          ? 'eliminations'
          : kind === 'homeworld-destroyed'
            ? 'event_log'
            : undefined;
  requireCommandArgument(table, '未注册的统计事件类别');
  if (kind === 'sighting-hit') {
    where += " AND classification='hit' AND valid=1";
  }
  if (kind === 'elimination') {
    where += ' AND valid=1';
  }
  if (kind === 'broadcast') {
    where += " AND kind='broadcast'";
  }
  if (kind === 'homeworld-destroyed') {
    where +=
      " AND ((kind IN ('singer','photon') AND civilization_ids<>'[]') OR title='裁判母星毁灭')";
  }
  for (const k of ['since', 'until']) {
    if (commandNode.options[k]) {
      where += ` AND ${kind === 'elimination' ? 'utc_ms' : kind === 'sighting-hit' ? 'committed_utc' : 'utc_ms'}${k === 'since' ? '>=' : '<='}?`;
      args.push(instantMs(commandNode.options[k]));
    }
  }
  return {
    kind,
    count: engine.db.one<{n: number}>(
      `SELECT COUNT(*) n FROM ${table} WHERE ${where}`,
      ...args,
    )!.n,
    windowMs: window,
  };
}
