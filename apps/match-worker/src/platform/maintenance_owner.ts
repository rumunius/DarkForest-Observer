import {parseJson, text} from '../../../../packages/contracts/src/backend';
import {decrypt, digest, encrypt, token} from '../security/crypto';
import {requireThat} from '../storage/store';
import type {MaintenanceContext} from './maintenance_context';
import {platformKey} from './security';

/** Recover owner access under the independent maintenance secret and retain the original rescue receipt. */
export async function rescuePlatformOwner(
  context: MaintenanceContext,
): Promise<string> {
  const {host, id, hash, requestPayload, environment, reason} = context;
  const old = host.db.one<{value: string}>(
    'SELECT value FROM platform_meta WHERE key=?',
    `rescue:${id}`,
  );
  if (old) {
    const stored = parseJson(old.value) as {
      hash: string;
      invitationId: string;
      accountId: string;
    };
    requireThat(
      stored.hash === hash,
      'OPERATION_CONFLICT',
      '救援编号已用于不同内容。',
    );
    return JSON.stringify(stored);
  }
  requireThat(
    requestPayload.confirm === '恢复平台所有者访问',
    'CONFIRM_REQUIRED',
    '请输入“恢复平台所有者访问”。',
  );
  const accountId = crypto.randomUUID();
  const invite = token();
  const inviteId = crypto.randomUUID();
  const inviteHash = await digest(invite);
  const cipher = await encrypt(
    await platformKey(environment),
    invite,
    `invitation|${inviteId}`,
  );
  host.db.tx(() => {
    host.db.exec('UPDATE platform_sessions SET revoked=1');
    host.db.exec("DELETE FROM platform_roles WHERE role='owner'");
    host.db.exec(
      "INSERT INTO platform_accounts(id,kind,name,status,created_utc) VALUES(?,'staff',?,'pending',?)",
      accountId,
      text(requestPayload.name, 100),
      host.now(),
    );
    host.db.exec("INSERT INTO platform_roles VALUES(?,'owner')", accountId);
    host.db.exec(
      'INSERT INTO invitations VALUES(?,?,?,?,0,?,?,?)',
      inviteId,
      accountId,
      inviteHash,
      host.now() + 86400000,
      cipher,
      host.now() + 86400000,
      'root-rescue',
    );
    host.db.exec(
      'INSERT INTO platform_meta VALUES(?,?)',
      `rescue:${id}`,
      JSON.stringify({hash, invitationId: inviteId, accountId}),
    );
    host.audit('root-maintainer', 'owner-rescue', accountId, reason, {
      operationId: id,
    });
  });
  return JSON.stringify({
    accountId,
    invitationId: inviteId,
    invitation: invite,
  });
}

/** Read only unexpired root rescue material through its dedicated delivery path. */
export async function deliverOwnerRescue(
  context: MaintenanceContext,
): Promise<string> {
  const {host, requestPayload, environment} = context;
  const row = host.db.one<{ciphertext: string; delivery_expires: number}>(
    "SELECT ciphertext,delivery_expires FROM invitations WHERE id=? AND issuer='root-rescue'",
    text(requestPayload.invitationId, 100),
  );
  requireThat(
    row?.ciphertext && row.delivery_expires > host.now(),
    'DELIVERY_EXPIRED',
    '救援材料已过期，请建立新的救援任务。',
  );
  return JSON.stringify({
    invitation: await decrypt(
      await platformKey(environment),
      row.ciphertext,
      `invitation|${text(requestPayload.invitationId, 100)}`,
    ),
  });
}
