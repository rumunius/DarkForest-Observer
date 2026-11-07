import {
  integer,
  scalarText,
  text,
} from '../../../../packages/contracts/src/backend';
import type {RpcReply} from '../rpc/types';
import {requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import {assertVersion, protectOwner} from './policy';
import type {PlatformMutation} from './request_context';
import type {Operation} from './types';

/** 保存比赛草稿及创建队列，跨对象执行由原持久操作驱动。 */
export async function createMatch(
  host: DarkForestPlatform,
  request: PlatformMutation,
): Promise<RpcReply> {
  const {requestPayload, session, id, bodyHash, reason} = request;

  const kind = requestPayload.kind;
  requireThat(
    kind === 'official' || kind === 'trial',
    'BAD_KIND',
    '请选择正式或试玩。',
    400,
  );
  const matchId = crypto.randomUUID();
  const name = text(requestPayload.name, 100);
  const retention = integer(
    requestPayload.retentionDays ?? (kind === 'trial' ? 14 : 44),
    1,
    3650,
  );
  const auditDays = integer(requestPayload.auditDays ?? 365, retention, 3650);
  requireThat(
    requestPayload.retentionConfirmed === true,
    'RETENTION_CONFIRM',
    '请确认向参与者告知的数据保留期限。',
    400,
  );
  let description =
    typeof requestPayload.description === 'string'
      ? text(requestPayload.description, 2000, 0)
      : '';
  let template: Record<string, unknown> | undefined;
  if (requestPayload.copyFrom) {
    const source = host.directory(text(requestPayload.copyFrom, 100));
    requireThat(
      source.state !== 'imported_archive',
      'SOURCE_READONLY',
      '导入档案不能作为活动比赛模板。',
    );
    template = await host.control(
      source,
      crypto.randomUUID(),
      'template',
      session.account_id,
      '复制已核对的活动设置白名单',
      {},
    );
    description = scalarText(template.description ?? description);
  }
  host.db.tx(() => {
    host.db.exec(
      'INSERT INTO match_directory(id,name,kind,state,object_name,created_utc,retention_days,audit_days,config) VALUES(?,?,?,?,?,?,?,?,?)',
      matchId,
      name,
      kind,
      'provisioning',
      `match:${matchId}`,
      host.now(),
      retention,
      auditDays,
      JSON.stringify({description, rulesetVersion: '1', keyVersion: 2}),
    );
    host.insertOperation(
      id,
      session.account_id,
      'create',
      matchId,
      bodyHash,
      {name, kind, description, ...(template ? {template} : {})},
      reason,
    );
  });
  await host.arm();
  return {status: 202, body: {operationId: id, matchId, status: 'pending'}};
}

/** 变更平台任职并保护有效所有者，原操作收据与审计保持同事务。 */
export function updatePlatformRoles(
  host: DarkForestPlatform,
  request: PlatformMutation,
): RpcReply {
  const {requestPayload, id, session, bodyHash, reason} = request;

  const account = host.account(text(requestPayload.accountId, 100));
  requireThat(
    account.kind === 'staff' && account.status === 'active',
    'ACTIVE_STAFF_REQUIRED',
    '请选择已激活工作人员。',
  );
  requireThat(
    ['owner', 'admin', 'archivist'].includes(String(requestPayload.role)),
    'BAD_ROLE',
    '角色无效。',
    400,
  );
  const grantMatch =
    requestPayload.role === 'archivist' && requestPayload.enabled !== false
      ? host.directory(text(requestPayload.matchId, 100))
      : null;
  host.db.tx(() => {
    assertVersion(host, account, requestPayload.expected_version);
    if (requestPayload.enabled === false && requestPayload.role === 'owner') {
      protectOwner(host, account.id);
    }
    if (requestPayload.enabled === false) {
      host.db.exec(
        'DELETE FROM platform_roles WHERE account_id=? AND role=?',
        account.id,
        requestPayload.role as string,
      );
    } else {
      host.db.exec(
        'INSERT OR IGNORE INTO platform_roles VALUES(?,?)',
        account.id,
        requestPayload.role as string,
      );
    }
    if (grantMatch) {
      host.db.exec(
        'INSERT OR REPLACE INTO archive_grants VALUES(?,?,?)',
        account.id,
        grantMatch.id,
        integer(
          requestPayload.expiresUtc ?? host.now() + 30 * 86400000,
          host.now() + 60000,
        ),
      );
    }
    if (
      requestPayload.enabled === false &&
      requestPayload.role === 'archivist'
    ) {
      host.db.exec('DELETE FROM archive_grants WHERE account_id=?', account.id);
    }
    host.db.exec(
      'UPDATE platform_accounts SET version=version+1 WHERE id=?',
      account.id,
    );
    host.insertOperation(
      id,
      session.account_id,
      'roles',
      account.id,
      bodyHash,
      {},
      reason,
      'succeeded',
    );
  });
  return {status: 200, body: {operationId: id, status: 'succeeded'}};
}

/** 更新推荐目录项，不改变任何标签页已经绑定的比赛。 */
export function recommendMatch(
  host: DarkForestPlatform,
  request: PlatformMutation,
): RpcReply {
  const {requestPayload, id, session, bodyHash, reason} = request;

  const matchEntry = host.directory(text(requestPayload.matchId, 100));
  assertVersion(host, matchEntry, requestPayload.expected_version);
  host.db.tx(() => {
    host.db.exec('UPDATE match_directory SET recommended=0');
    host.db.exec(
      'UPDATE match_directory SET recommended=1,version=version+1 WHERE id=?',
      matchEntry.id,
    );
    host.insertOperation(
      id,
      session.account_id,
      'recommend',
      matchEntry.id,
      bodyHash,
      {},
      reason,
      'succeeded',
    );
  });
  return {status: 200, body: {status: 'succeeded', operationId: id}};
}

/** 重新安排原失败操作的未完成步骤，不生成新的业务身份。 */
export async function retryPlatformOperation(
  host: DarkForestPlatform,
  request: PlatformMutation,
): Promise<RpcReply> {
  const {requestPayload, id, session, bodyHash, reason} = request;

  const operation = host.db.one<Operation>(
    'SELECT * FROM platform_operations WHERE id=?',
    text(requestPayload.operationId, 100),
  );
  requireThat(
    operation && ['partial', 'failed'].includes(operation.status),
    'NOT_RETRYABLE',
    '任务没有可重试步骤。',
  );
  host.db.tx(() => {
    host.db.exec(
      "UPDATE platform_operations SET status='pending',next_attempt=0,attempts=0,error='' WHERE id=?",
      operation.id,
    );
    host.insertOperation(
      id,
      session.account_id,
      'retry',
      operation.id,
      bodyHash,
      {},
      reason,
      'succeeded',
    );
  });
  await host.arm();
  return {
    status: 202,
    body: {operationId: operation.id, status: 'pending'},
  };
}
