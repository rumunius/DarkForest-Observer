import {Fault, type Scheduled} from '../storage/store';
import type {CommandContext} from './command_context';
import {
  recordDependency,
  requireCommandArgument,
  singleTarget,
  recordPopulationDependency,
  selectTargets,
  commandValue,
} from './command_context';
import {inRange, score} from './command_targets';
import {survivors} from './life';

/** 解析并评估命令布尔条件，遵守已定义的括号与逻辑运算优先级。 */
export function condition(
  commandContext: CommandContext,
  words: string[],
): boolean {
  let index = 0;
  const take = () => {
    requireCommandArgument(index < words.length, '条件不完整');
    return commandValue(words[index++], commandContext);
  };
  const single = (v: string) => singleTarget(commandContext, v);
  const predicate = (): boolean => {
    const kind = take();
    const engine = commandContext.engine;
    if (kind === 'entity') {
      return selectTargets(commandContext, take()).length > 0;
    }
    if (kind === 'match') {
      const key = take();
      const v = take();
      const matchState = engine.db.match();
      if (key === 'phase') {
        return matchState.phase === v;
      }
      if (key === 'paused') {
        requireCommandArgument(['true', 'false'].includes(v), 'paused为布尔值');
        return (matchState.paused_at !== null) === (v === 'true');
      }
      requireCommandArgument(key === 'alive', '未知match条件');
      recordPopulationDependency(commandContext);
      return inRange(survivors(engine).length, v);
    }
    if (kind === 'player') {
      const id = single(take());
      const field = take();
      const v = take();
      if (field === 'status') {
        return engine.db.flight(id).status === v;
      }
      requireCommandArgument(field === 'homeworld', '未知player条件');
      const h = engine.db.home(id);
      return v === 'pending'
        ? h?.status === 'pending'
        : h?.status === 'verified' &&
            (v === 'alive'
              ? h.destroyed_game === null
              : h.destroyed_game !== null);
    }
    if (kind === 'score') {
      const id = single(take());
      const key = take();
      requireCommandArgument(take() === 'matches', 'score条件缺少matches');
      return inRange(score(engine, id, key), take());
    }
    if (kind === 'tag') {
      const id = single(take());
      const tag = take();
      return !!engine.db.one<Record<string, SqlStorageValue>>(
        'SELECT tag FROM command_tags WHERE player_id=? AND tag=?',
        id,
        tag,
      );
    }
    if (kind === 'effect') {
      const id = take();
      requireCommandArgument(take() === 'active', 'effect条件缺少active');
      const row = engine.db.one<{active: number; starts: number; ends: number}>(
        'SELECT active,starts,ends FROM admin_effects WHERE id=?',
        id,
      );
      recordDependency(commandContext, 'effect:' + id, row ?? null);
      return (
        !!row?.active && row.starts <= engine.now() && engine.now() < row.ends
      );
    }
    if (kind === 'event') {
      const id = take();
      requireCommandArgument(take() === 'status', 'event条件缺少status');
      const v = take();
      const row = engine.db.one<Scheduled>(
        'SELECT * FROM scheduled_events WHERE id=?',
        id,
      );
      recordDependency(commandContext, 'event:' + id, row ?? null);
      return (
        (row?.status === 'pending' && row.last_error
          ? 'failed'
          : row?.status) === v
      );
    }
    throw new Fault(400, 'CONDITION_SYNTAX', '未知条件：' + kind);
  };
  const not = (): boolean => {
    if (words[index] === 'not') {
      index++;
      return !not();
    }
    if (words[index] === '(') {
      index++;
      const v = or();
      requireCommandArgument(words[index++] === ')', '条件缺少右括号');
      return v;
    }
    return predicate();
  };
  const and = (): boolean => {
    let v = not();
    while (words[index] === 'and') {
      index++;
      const rhs = not();
      v = v && rhs;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (words[index] === 'or') {
      index++;
      const rhs = and();
      v = v || rhs;
    }
    return v;
  };
  const result = or();
  requireCommandArgument(index === words.length, '条件含多余参数');
  return result;
}
