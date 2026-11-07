import {type CommandNode} from '../../../../packages/contracts/src/commands';
import {condition} from './command_conditions';
import type {CommandContext} from './command_context';
import {requireCommandArgument, selectTargets} from './command_context';

/** 递归执行同一命令树，沿用上层事务、共享工作预算与深度门禁。 */
export type CommandRunner = (
  context: CommandContext,
  node: CommandNode,
) => unknown;

/** 执行原子操作块或显式创建逐步作业，不改变调用方事务。 */
export function runBatch(
  commandContext: CommandContext,
  commandNode: CommandNode,
  runCommand: CommandRunner,
  createJob: (context: CommandContext, steps: CommandNode[]) => unknown,
): unknown {
  requireCommandArgument(
    commandNode.words.length === 2 && commandNode.block?.length,
    '用法：batch run { 操作; ... }',
  );
  if (commandNode.options.mode) {
    requireCommandArgument(
      ['atomic', 'sequential'].includes(commandNode.options.mode),
      'mode须为atomic或sequential',
    );
  }
  if (commandNode.options.mode === 'sequential') {
    return createJob(commandContext, commandNode.block);
  }
  const results = [];
  for (const child of commandNode.block) {
    results.push(runCommand(commandContext, child));
  }
  return results;
}

/** 按原目标顺序绑定当前文明并逐项判断条件，条件为假时记录无操作。 */
export function runConditional(
  commandContext: CommandContext,
  commandNode: CommandNode,
  runCommand: CommandRunner,
): unknown {
  requireCommandArgument(
    commandNode.block?.length && commandNode.words.at(-1) === 'run',
    'execute需要run操作块',
  );
  let index = 1;
  let ids: Array<string | undefined> = [commandContext.self];
  if (commandNode.words[index] === 'as') {
    ids = selectTargets(commandContext, commandNode.words[index + 1]!);
    index += 2;
  }
  const steps: Array<{unless: boolean; words: string[]}> = [];
  while (index < commandNode.words.length - 1) {
    const kind = commandNode.words[index++];
    requireCommandArgument(
      kind === 'if' || kind === 'unless',
      'execute需要as/if/unless/run',
    );
    const start = index;
    let depth = 0;
    while (index < commandNode.words.length - 1) {
      const currentWord = commandNode.words[index]!;
      if (currentWord === '(') {
        depth++;
      }
      if (currentWord === ')') {
        depth--;
      }
      if (!depth && ['if', 'unless'].includes(currentWord)) {
        break;
      }
      index++;
    }
    steps.push({
      unless: kind === 'unless',
      words: commandNode.words.slice(start, index),
    });
  }
  const out = [];
  for (const id of ids) {
    commandContext.self = id;
    let enabled = true;
    for (const step of steps) {
      const matches = condition(commandContext, step.words);
      enabled = enabled && (step.unless ? !matches : matches);
    }
    if (enabled) {
      for (const child of commandNode.block) {
        out.push(runCommand(commandContext, child));
      }
    } else {
      commandContext.notes.push(`条件为假：${id ?? '全局'}，无操作。`);
    }
  }
  return out;
}
