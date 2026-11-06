import {parseJson} from '../../../../packages/contracts/src/backend';
import {type CommandNode} from '../../../../packages/contracts/src/commands';
import type {CommandContext} from './command_context';
import {
  commandObject,
  commandValue,
  recordChange,
  requireObjectOwner,
  updateCommandObject,
  validateCommandArguments,
} from './command_context';
import {dispatchCommandAction} from './command_dispatch';
import {logEvent} from './life';
/** 按原归属和状态取消后续任务，保留已提交步骤及完成结果。 */
export function cancelCommandTask(
  commandContext: CommandContext,
  commandNode: CommandNode,
  path: string,
): unknown {
  validateCommandArguments(commandNode);
  const row = commandObject(
    commandContext.engine,
    commandValue(commandNode.words[2], commandContext),
    path.startsWith('job') ? 'job' : 'schedule',
  );
  requireObjectOwner(commandContext, row);
  if (['complete', 'cancelled'].includes(row.status)) {
    return parseJson(row.data);
  }
  updateCommandObject(commandContext, row, parseJson(row.data), 'cancelled');
  commandContext.engine.db.exec(
    "UPDATE scheduled_events SET status='cancelled' WHERE (id=? OR json_extract(payload,'$.job')=?) AND status='pending'",
    row.id,
    row.id,
  );
  recordChange(
    commandContext,
    row.id,
    row.status,
    'cancelled；已提交步骤不回滚',
  );
  return;
}

/** 复用领域动作并以本次真实变化记录业务审计和公开干预事件。 */
export function executeCommandAction(
  commandContext: CommandContext,
  commandNode: CommandNode,
  path: string,
): unknown {
  const offset = commandContext.changes.length;
  const result = dispatchCommandAction(commandContext, commandNode);
  const changes = commandContext.changes.slice(offset);
  const ids = [
    ...new Set(changes.map(p => p.target).filter(id => /^C\d{2,3}$/.test(id))),
  ];
  commandContext.engine.audit(
    commandContext.actor.id,
    'command:' + path,
    ids.length === 1 ? ids[0]! : commandContext.engine.db.match().id,
    commandContext.reason,
    {
      requestId: commandContext.id,
      source: commandContext.source,
      caseId: commandContext.caseId ?? null,
      status: 'executed',
      changes,
    },
  );
  if (changes.length) {
    logEvent(
      commandContext.engine,
      `command:${commandContext.actor.id}:${commandContext.id}:${commandContext.work}`,
      'review',
      /^(resource|photon|tech) /.test(path) ? '资源调整' : '裁判指令',
      commandContext.reason,
      'global',
      ids,
      commandContext.engine.game(),
      commandContext.engine.now(),
    );
  }
  return result;
}
