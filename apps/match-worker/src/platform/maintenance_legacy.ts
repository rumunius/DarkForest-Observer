import {
  parseJson,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import {digest} from '../security/crypto';
import {requireThat} from '../storage/store';
import type {MaintenanceContext} from './maintenance_context';
import {controlSignature} from './security';
import type {Operation} from './types';

/** Save the signed old-match inventory before any adoption or identity remapping. */
export async function inspectLegacyMatch(
  context: MaintenanceContext,
): Promise<string> {
  const {requestPayload, environment, host, id} = context;
  const matchId = text(requestPayload.matchId, 100);
  requireThat(
    /^[A-Za-z0-9_-]+$/.test(matchId),
    'BAD_MATCH_ID',
    '旧比赛编号格式不正确。',
    400,
  );
  const inventory = parseJson(
    await environment.MATCH_DO.getByName(`match:${matchId}`).legacyInventory(
      matchId,
      await controlSignature(
        environment,
        stableJson({action: 'legacy-inventory', matchId}),
      ),
    ),
  );
  host.db.exec(
    'INSERT OR REPLACE INTO platform_meta VALUES(?,?)',
    `legacy:${id}`,
    JSON.stringify(inventory),
  );
  return JSON.stringify(inventory);
}

/** Resume the original adoption operation and mark availability only after the match receipt arrives. */
export async function adoptLegacyPlatformMatch(
  context: MaintenanceContext,
): Promise<string> {
  const {requestPayload, host, id, hash, reason} = context;
  const matchId = text(requestPayload.matchId, 100);
  const existing = host.db.one<Operation>(
    'SELECT * FROM platform_operations WHERE id=?',
    id,
  );
  if (existing?.status === 'succeeded') {
    requireThat(
      existing.body_hash === hash,
      'OPERATION_CONFLICT',
      '迁移编号对应不同内容。',
    );
    return JSON.stringify({matchId, receipt: parseJson(existing.result)});
  }
  const row = host.db.one<{value: string}>(
    'SELECT value FROM platform_meta WHERE key=?',
    `legacy:${id}`,
  );
  requireThat(row, 'INSPECTION_REQUIRED', '请先检查旧比赛并保存加密检查点。');
  const inventory = parseJson(row.value) as LegacyInventory;
  requireThat(
    inventory.id === matchId &&
      requestPayload.checkpointDigest ===
        (await digest(stableJson(inventory.checkpoint))),
    'BACKUP_RECEIPT_REQUIRED',
    '请保存检查点、回读校验后再登记旧比赛。',
  );
  requireThat(
    requestPayload.confirm === `接入旧比赛 ${matchId}`,
    'CONFIRM_REQUIRED',
    `请输入“接入旧比赛 ${matchId}”。`,
  );
  const pendingOperation = stageLegacyAdoption(
    context,
    matchId,
    inventory,
    existing,
  );
  requireThat(
    pendingOperation.body_hash === hash,
    'OPERATION_CONFLICT',
    '迁移编号对应不同内容。',
  );
  const saved = parseJson(pendingOperation.payload) as {
    mappings: Array<{id: string; accountId: string}>;
    expectedRevision: number;
  };
  const matchEntry = host.directory(matchId);
  const receipt = await host.control(
    matchEntry,
    `${id}:adopt`,
    'adopt-legacy',
    'root-maintainer',
    reason,
    {
      kind: 'official',
      expectedRevision: saved.expectedRevision,
      accounts: saved.mappings.map(a => ({
        localId: a.id,
        accountId: a.accountId,
      })),
    },
  );
  host.db.tx(() => {
    host.db.exec(
      "UPDATE match_directory SET state='available',version=version+1 WHERE id=?",
      matchId,
    );
    host.db.exec(
      "UPDATE platform_operations SET status='succeeded',result=?,payload='{}' WHERE id=?",
      JSON.stringify(receipt),
      id,
    );
    host.db.exec('DELETE FROM platform_meta WHERE key=?', `legacy:${id}`);
  });
  return JSON.stringify({
    matchId,
    receipt,
    message:
      '原对象、码本和比赛记录已保留；旧口令仅可在领取页面兑换一次长期口令，7天后失效。未知旧日志人员保持未确认。',
  });
}

/** Shape written by the signed legacyInventory RPC and retained unchanged in platform_meta. */
interface LegacyInventory {
  id: string;
  revision: number;
  accounts: Array<{
    id: string;
    role: string;
    name: string;
    credential_hash: string;
  }>;
  checkpoint: unknown;
}

/** Persist the mapping and original operation together before contacting the match object. */
function stageLegacyAdoption(
  context: MaintenanceContext,
  matchId: string,
  inventory: LegacyInventory,
  existing: Operation | undefined,
): Operation {
  const {host, id, requestPayload, hash, reason} = context;
  let pendingOperation = existing;
  if (!pendingOperation) {
    const mappings = inventory.accounts.map(a => ({
      ...a,
      accountId: crypto.randomUUID(),
    }));
    host.db.tx(() => {
      requireThat(
        !host.db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM match_directory WHERE id=?',
          matchId,
        ),
        'MATCH_EXISTS',
        '该场次已登记，禁止重建。',
      );
      host.db.exec(
        "INSERT INTO match_directory(id,name,kind,state,object_name,created_utc,retention_days,audit_days,config) VALUES(?,?,'official','provisioning',?,?,44,365,'{}')",
        matchId,
        text(requestPayload.name, 100),
        `match:${matchId}`,
        host.now(),
      );
      for (const accountInput of mappings) {
        host.db.exec(
          "INSERT INTO platform_accounts(id,kind,name,status,created_utc) VALUES(?,?,?,'pending',?)",
          accountInput.accountId,
          accountInput.role === 'judge' ? 'staff' : 'player',
          accountInput.name,
          host.now(),
        );
        host.db.exec(
          'INSERT INTO invitations VALUES(?,?,?,?,0,NULL,?,?)',
          crypto.randomUUID(),
          accountInput.accountId,
          accountInput.credential_hash,
          host.now() + 7 * 86400000,
          host.now(),
          'legacy-migration',
        );
        host.db.exec(
          'INSERT INTO account_match_index VALUES(?,?)',
          accountInput.accountId,
          matchId,
        );
      }
      host.insertOperation(
        id,
        'root-maintainer',
        'adopt-legacy',
        matchId,
        hash,
        {mappings, expectedRevision: inventory.revision},
        reason,
      );
    });
    pendingOperation = host.db.one<Operation>(
      'SELECT * FROM platform_operations WHERE id=?',
      id,
    )!;
  }
  return pendingOperation;
}
