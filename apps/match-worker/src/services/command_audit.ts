import {type Actor} from '../storage/store';
import {type Engine} from './engine';

/** 写入命令结果与前后状态审计，原文密文按命令身份和操作ID绑定。 */
export function recordCommand(
  engine: Engine,
  actor: Actor,
  id: string,
  path: string,
  status: string,
  detail: unknown,
  ciphertext: string | null = null,
): void {
  const facts =
    detail && typeof detail === 'object'
      ? (detail as Record<string, unknown>)
      : {detail};
  let auditId: string | null = null;
  if (
    facts.before !== undefined &&
    facts.after !== undefined &&
    !['queried', 'previewed'].includes(status)
  ) {
    const targets = Array.isArray(facts.targets) ? facts.targets : [];
    engine.audit(
      actor.id,
      'command:' + path,
      targets.length === 1 ? String(targets[0]) : engine.db.match().id,
      typeof facts.reason === 'string' ? facts.reason : '裁判指令记录',
      {requestId: id, status, ...facts},
    );
    auditId = engine.db.one<{id: string}>(
      'SELECT id FROM audit_logs ORDER BY seq DESC LIMIT 1',
    )!.id;
  }
  engine.db.exec(
    'INSERT INTO judge_command_log(id,actor,request_id,status,path,created_utc,game_ms,detail,ciphertext) VALUES(?,?,?,?,?,?,?,?,?)',
    crypto.randomUUID(),
    actor.id,
    id,
    status,
    path,
    engine.now(),
    engine.game(),
    JSON.stringify({
      ...facts,
      auditId,
      identity: engine.db.one<Record<string, SqlStorageValue>>(
        'SELECT account_id,assignment_id,name FROM memberships WHERE local_id=?',
        actor.id,
      ) ?? {name: actor.name, legacySeat: true},
    }),
    ciphertext,
  );
}
