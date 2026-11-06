import {integer, parseJson} from '../../../../packages/contracts/src/backend';
import {
  commandSpec,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {Fault, permission} from '../storage/store';
import type {CommandContext} from './command_context';
import {
  validateCommandArguments,
  recordChange,
  emitCommandMessage,
  requireHeadJudge,
  requireCommandArgument,
  commandObject,
  saveCommandObject,
  recordTableDependency,
  updateCommandObject,
  commandValue,
} from './command_context';

/** Execute report commands inside the caller's existing preview or commit transaction. */
export function handleReportAction(
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

  if (path === 'case evidence' || path === 'case close') {
    requireHeadJudge(commandContext);
    const row = commandObject(engine, commandArguments[0]!, 'case');
    const data = parseJson(row.data) as {evidence: unknown[]};
    if (path.endsWith('evidence')) {
      requireCommandArgument(
        commandArguments.length === 5 &&
          commandArguments[1] === 'ref' &&
          commandArguments[3] === 'note',
        '用法：case evidence ID ref 业务ID note "说明"',
      );
      data.evidence.push({ref: commandArguments[2], note: commandArguments[4]});
    }
    updateCommandObject(
      commandContext,
      row,
      data,
      path.endsWith('close') ? 'closed' : row.status,
    );
    recordChange(
      commandContext,
      row.id,
      '原个案',
      path.endsWith('close') ? '已关闭' : '已追加证据',
    );
    return;
  }

  if (path === 'report correct') {
    requireHeadJudge(commandContext);
    requireCommandArgument(
      matchState.phase === 'ended',
      '只有完赛后可更正战报',
    );
    recordTableDependency(commandContext, 'result_reports');
    const basis = commandArguments[1]
      ? commandObject(engine, commandArguments[1], 'case').id
      : null;
    const version = db.one<{v: number}>(
      'SELECT MAX(version) v FROM result_reports',
    )!.v;
    const id = saveCommandObject(
      commandContext,
      'report-draft',
      {
        basis,
        reason: commandContext.reason,
        fromVersion: version,
        editRoute: '/judge/results',
      },
      'RPT',
    );
    recordChange(
      commandContext,
      id,
      `正式版本${version}`,
      '更正草稿已建立；请在战报表单选择具体记录和更正值，产生新版本',
    );
    return {id, editRoute: '/judge/results'};
  }

  if (path === 'report publish') {
    requireHeadJudge(commandContext);
    requireCommandArgument(
      matchState.phase === 'ended',
      '只有完赛后可发布战报',
    );
    const version = integer(
      Number(commandArguments[0]!.replace(/^RPT-/, '')),
      1,
    );
    requireCommandArgument(
      db.one<Record<string, SqlStorageValue>>(
        'SELECT version FROM result_reports WHERE version=?',
        version,
      ),
      '战报版本不存在',
    );
    emitCommandMessage(
      commandContext,
      db.roster(),
      `正式战报版本${version}已发布，请查看赛后复盘。`,
      true,
    );
    return;
  }

  throw new Fault(400, 'UNKNOWN_COMMAND', '命令没有执行处理器：' + path);
}
