import {parseJson} from '../../../../packages/contracts/src/backend';
import {type Actor, type Scheduled} from '../storage/store';
import {recordCommand} from './command_audit';
import {commandObject} from './command_context';
import type {
  CommandEventContext,
  CommandEventPayload,
} from './command_event_context';
import {executeCommandJob} from './command_job_execution';
import {createCommandContext} from './command_runtime';
import {executeCommandTask} from './command_task_execution';
import {type Engine} from './engine';

/** 执行持久命令任务并复核创建者权限、时间与依赖，失败留存供裁判处置。 */
export function executeCommandEvent(engine: Engine, event: Scheduled): void {
  const payload = parseJson(event.payload) as CommandEventPayload;
  const row = commandObject(
    engine,
    payload.id ?? payload.job!,
    payload.job ? 'job' : 'schedule',
  );
  if (row.status !== 'pending') {
    return;
  }
  const actor = engine.db.one<Actor>(
    'SELECT * FROM accounts WHERE id=?',
    row.actor,
  );
  if (
    engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT id FROM match_identity',
    ) &&
    !engine.taskAuthorization.has(row.actor)
  ) {
    engine.db.exec(
      "UPDATE command_objects SET status='review',version=version+1 WHERE id=?",
      row.id,
    );
    return;
  }
  if (!actor?.enabled) {
    engine.db.exec(
      "UPDATE command_objects SET status='failed' WHERE id=?",
      row.id,
    );
    if (actor) {
      recordCommand(
        engine,
        actor,
        row.id,
        payload.job ? 'job step' : 'schedule due',
        'rejected',
        {
          parent: row.id,
          eventId: event.id,
          code: 'AUTHOR_DISABLED',
          originalDue: event.due,
        },
        null,
      );
    }
    return;
  }
  const commandContext = createCommandContext(
    engine,
    actor,
    `${row.id}-${payload.index ?? 0}`,
    engine.commandPrepared,
  );
  commandContext.reason = '裁判定时授权';
  commandContext.deferred = true;
  const context: CommandEventContext = {
    engine,
    event,
    payload,
    row,
    actor,
    commandContext,
  };
  if (payload.job) {
    executeCommandJob(context);
    return;
  }
  executeCommandTask(context);
}
