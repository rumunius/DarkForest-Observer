import {
  integer,
  parseJson,
  text,
} from '../../../../packages/contracts/src/backend';
import {
  durationMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import type {CommandRunner} from './command_composition';
import type {CommandContext} from './command_context';
import {
  commandValue,
  namedCommandObject,
  recordChange,
  recordDependency,
  requireCommandArgument,
  requireHeadJudge,
  saveCommandObject,
  selectTargets,
  unquoteArgument,
  updateCommandObject,
  validateCommandArguments,
} from './command_context';
/** 固定宏引用版本并核对展开权限，调用方显式传入当前调用栈。 */
export type CommandPinner = (
  context: CommandContext,
  node: CommandNode,
  stack?: string[],
) => void;
/** 宏定义持久正文，由defineMacro校验参数类型、正文及不可递归引用后保存。 */
export interface MacroData {
  name: string;
  params: Array<{name: string; type: string}>;
  block: CommandNode[];
}

/** 保存已固定依赖的不可变宏版本，不执行宏正文。 */
export function defineMacro(
  commandContext: CommandContext,
  commandNode: CommandNode,
  pinCommand: CommandPinner,
): unknown {
  requireHeadJudge(commandContext);
  requireCommandArgument(
    commandNode.block?.length && commandNode.words.at(-1) === 'run',
    '宏定义需要run操作块',
  );
  const name = commandValue(commandNode.words[2], commandContext);
  text(name, 200);
  const params: Array<{name: string; type: string}> = [];
  if (commandNode.words.length > 4) {
    requireCommandArgument(
      commandNode.words[3] === 'params' &&
        commandNode.words[4] === '(' &&
        commandNode.words.at(-2) === ')',
      '宏参数须使用params (...)',
    );
    const declarations = commandNode.words.slice(5, -2).join('').split(',');
    for (const decl of declarations) {
      const match =
        /^([A-Za-z][A-Za-z0-9_]*):(target|int|duration|text|bool)$/.exec(decl);
      requireCommandArgument(
        match && !params.some(p => p.name === match[1]),
        '宏参数类型、名称或重复声明不正确',
      );
      params.push({name: match[1]!, type: match[2]!});
    }
  }
  const block = structuredClone(commandNode.block);
  for (const node of block) {
    requireCommandArgument(
      !(node.words[0] === 'macro' && unquoteArgument(node.words[2]) === name),
      '宏不能递归',
    );
    pinCommand(commandContext, node, [name]);
  }
  const versions = commandContext.engine.db.all<{version: number}>(
    "SELECT version FROM command_objects WHERE kind='macro' AND json_extract(data,'$.name')=?",
    name,
  );
  const version = Math.max(0, ...versions.map(v => v.version)) + 1;
  const id = saveCommandObject(
    commandContext,
    'macro',
    {name, params, block},
    'MAC',
  );
  commandContext.engine.db.exec(
    'UPDATE command_objects SET version=? WHERE id=?',
    version,
    id,
  );
  recordChange(
    commandContext,
    id,
    '原版本保留',
    `宏「${name}」版本${version}已保存，尚未执行`,
  );
  return {id, version};
}

/** 一次绑定类型化宏参数，在递归保护及调用方预算内执行固定版本。 */
export function runMacro(
  commandContext: CommandContext,
  commandNode: CommandNode,
  runCommand: CommandRunner,
): unknown {
  const name = commandValue(commandNode.words[2], commandContext);
  const versionIndex = commandNode.words.indexOf('version');
  const row = namedCommandObject(
    commandContext,
    'macro',
    name,
    versionIndex >= 0 ? Number(commandNode.words[versionIndex + 1]) : undefined,
  );
  const data = parseJson(row.data) as MacroData;
  recordDependency(commandContext, 'object:' + row.id, row);
  requireCommandArgument(
    !commandContext.macroStack.includes(row.id),
    '宏不能递归',
  );
  const rest = commandNode.words.slice(
    3,
    versionIndex >= 0 ? versionIndex : undefined,
  );
  const args: string[] = [];
  if (rest.length) {
    requireCommandArgument(
      rest[0] === '(' && rest.at(-1) === ')',
      '宏参数须在括号内',
    );
    let current: string[] = [];
    for (const word of rest.slice(1, -1)) {
      if (word === ',') {
        args.push(current.join(''));
        current = [];
      } else {
        current.push(word);
      }
    }
    if (current.length) {
      args.push(current.join(''));
    }
  }
  requireCommandArgument(
    args.length === data.params.length,
    '宏实参数量与声明不一致',
  );
  commandContext.bindings = {...commandContext.bindings};
  commandContext.scalars = {...commandContext.scalars};
  for (const [parameterIndex, parameter] of data.params.entries()) {
    const arg = commandValue(args[parameterIndex], commandContext);
    const key = '$' + parameter.name;
    if (parameter.type === 'target') {
      commandContext.bindings[key] = selectTargets(commandContext, arg);
    } else {
      if (parameter.type === 'int') {
        integer(Number(arg), Number.MIN_SAFE_INTEGER);
      }
      if (parameter.type === 'duration') {
        durationMs(arg);
      }
      if (parameter.type === 'bool') {
        requireCommandArgument(
          ['true', 'false'].includes(arg),
          '宏布尔参数须为true/false',
        );
      }
      commandContext.scalars[key] = arg;
    }
  }
  commandContext.macroStack.push(row.id);
  try {
    return data.block.map(child => runCommand(commandContext, child));
  } finally {
    commandContext.macroStack.pop();
  }
}

/** 核对总裁判职责及指定版本后退役宏，保留正文和既有事实。 */
export function retireMacro(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  requireHeadJudge(commandContext);
  validateCommandArguments(commandNode);
  const row = namedCommandObject(
    commandContext,
    'macro',
    commandValue(commandNode.words[2], commandContext),
    integer(Number(commandNode.words[4]), 1),
  );
  updateCommandObject(commandContext, row, parseJson(row.data), 'retired');
  recordChange(commandContext, row.id, 'active', 'retired');
  return;
}
