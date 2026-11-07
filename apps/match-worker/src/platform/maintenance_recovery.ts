import {
  object,
  parseJson,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import {digest} from '../security/crypto';
import {requireThat} from '../storage/store';
import type {MaintenanceContext} from './maintenance_context';
import {erasureFloor} from './retention';
import {controlSignature} from './security';
import type {Directory} from './types';

/** Persist the locally read-back carry digest before permitting recovery launch. */
export async function recordCarryReceipt(
  context: MaintenanceContext,
  directoryEntry: Directory,
): Promise<string> {
  const {requestPayload, host, id, reason} = context;
  const carry = object(requestPayload.carry);
  const savedDigest = text(requestPayload.sha256, 100);
  requireThat(
    savedDigest === (await digest(stableJson(carry))),
    'CARRY_MISMATCH',
    '本地回读材料的摘要不匹配。',
  );
  host.db.exec(
    'INSERT OR REPLACE INTO platform_meta VALUES(?,?)',
    `carry:${directoryEntry.id}:${id}`,
    JSON.stringify({digest: savedDigest, carryId: carry.id}),
  );
  host.audit('root-maintainer', 'carry-saved', directoryEntry.id, reason, {
    operationId: id,
  });
  return JSON.stringify({saved: true});
}

/** Forward the controlled recovery protocol and reapply current platform security facts after completion. */
export async function recoverPlatformMatch(
  context: MaintenanceContext,
  directoryEntry: Directory,
): Promise<string> {
  const {environment, requestPayload, host, id, reason} = context;
  requireThat(
    environment.BOOTSTRAP_SECRET,
    'RECOVERY_NOT_CONFIGURED',
    '比赛恢复凭据未配置。',
  );
  const payload = object(requestPayload.payload);
  const action = text(payload.operation, 100);
  if (action === 'prepare' || action === 'launch') {
    requireThat(
      erasureFloor(host, directoryEntry.id) === 0,
      'RESTORE_EXPIRED',
      '本场完整信息已清理，旧检查点不能重新开放比赛；请查看保留的正式战报。',
      410,
    );
  }
  if (action === 'launch') {
    const receipt = host.db.one<{value: string}>(
      'SELECT value FROM platform_meta WHERE key=?',
      `carry:${directoryEntry.id}:${id}`,
    );
    requireThat(
      receipt &&
        object(parseJson(receipt.value)).digest ===
          (await digest(stableJson(payload.payload))),
      'CARRY_RECEIPT_REQUIRED',
      '必须保存并回读校验carry材料，再登记收据后执行恢复。',
    );
    requireThat(
      requestPayload.confirm === `恢复比赛 ${directoryEntry.id}`,
      'CONFIRM_REQUIRED',
      `请输入“恢复比赛 ${directoryEntry.id}”。`,
    );
  }
  const signature = await controlSignature(
    environment,
    stableJson({matchId: directoryEntry.id, raw: payload}),
  );
  if (action === 'launch') {
    requireThat(
      erasureFloor(host, directoryEntry.id) === 0,
      'RESTORE_EXPIRED',
      '本场资料已清理，不能恢复旧检查点。',
      410,
    );
  }
  const reply = await environment.MATCH_DO.getByName(
    directoryEntry.object_name,
  ).recovery(environment.BOOTSTRAP_SECRET, payload, signature);
  requireThat(
    reply.status < 400,
    'RECOVERY_FAILED',
    (parseJson(reply.body) as {message?: string}).message ?? '比赛恢复未完成。',
  );
  if (action === 'complete') {
    // The platform timeline never rolls back with a match. Reapply its current security facts.
    for (const row of host.db.all<{account_id: string}>(
      'SELECT account_id FROM account_match_index WHERE match_id=?',
      directoryEntry.id,
    )) {
      const account = host.account(row.account_id);
      await host.control(
        directoryEntry,
        `${id}:security:${account.id}:${account.auth_epoch}`,
        'fence',
        'root-maintainer',
        '恢复后应用最新平台撤销',
        {
          accountId: account.id,
          authEpoch: account.auth_epoch,
          disabled: account.status !== 'active',
        },
      );
    }
    const generation = erasureFloor(host, directoryEntry.id);
    if (generation > 0) {
      await host.control(
        directoryEntry,
        `${id}:erase:${generation}`,
        'erase',
        'root-maintainer',
        '恢复后应用独立清理账本',
        {generation},
      );
    }
  }
  host.audit(
    'root-maintainer',
    `recovery:${action}`,
    directoryEntry.id,
    reason,
    {
      operationId: id,
    },
  );
  return reply.body;
}
