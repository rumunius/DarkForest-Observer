import type { AccountSummary } from '@darkforest/contracts';
import { integer, text } from '../../../../packages/contracts/src/backend';
import { permission, requireThat, type Actor } from '../storage/store';
import type { Engine } from './engine';
import { digest, encrypt, token } from '../security/crypto';
export type CredentialMaterial = { id: string; hash: string; ciphertext: string };
export const DUTIES = {
  communications: ['overview', 'homeworlds', 'notices', 'players', 'events', 'account'],
  events: ['overview', 'notices', 'events', 'players', 'account'],
};
export function accountList(e: Engine, actor: Actor): AccountSummary[] {
  permission(actor, 'system');
  return e.db.all<Actor>('SELECT * FROM accounts ORDER BY id').map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    enabled: !!a.enabled,
    version: a.version,
    permissions: JSON.parse(a.permissions) as string[],
  }));
}
export async function prepareCredential(e: Engine, actor: string): Promise<CredentialMaterial> {
  const id = crypto.randomUUID(),
    credential = token(),
    keys = await e.keys();
  return {
    id,
    hash: await digest(credential),
    ciphertext: await encrypt(
      keys.encryption,
      credential,
      `credential|${e.matchId}|${actor}|${id}`,
    ),
  };
}
export function validateAccount(e: Engine, actor: Actor, body: Record<string, unknown>): Actor {
  permission(actor, 'system');
  const target = text(body.target, 16);
  const account = e.db.one<Actor>('SELECT * FROM accounts WHERE id=?', target);
  requireThat(
    account && account.version === integer(body.expected_version, 1),
    'ACCOUNT_VERSION_CONFLICT',
    '账号状态已更新，请刷新后核对。',
  );
  if (e.db.one('SELECT id FROM match_identity'))
    requireThat(
      account.role === 'player' && ['disable', 'enable'].includes(String(body.operation)),
      'PLATFORM_ACCOUNT_REQUIRED',
      '长期口令请由平台管理员在账号池找回；裁判换人请使用本场岗位交接。',
    );
  requireThat(
    target !== actor.id && !(JSON.parse(account.permissions) as string[]).includes('system'),
    'HEAD_ACCOUNT_PROTECTED',
    '总裁判账号由部署管理员管理。',
  );
  requireThat(
    ['disable', 'enable', 'reset', 'duty'].includes(String(body.operation)),
    'BAD_OPERATION',
    '请选择账号操作。',
    400,
  );
  if (body.operation === 'duty')
    requireThat(
      account.role === 'judge' && ['communications', 'events'].includes(String(body.duty)),
      'BAD_DUTY',
      '请选择裁判职责。',
      400,
    );
  return account;
}
export function updateAccount(
  e: Engine,
  actor: Actor,
  body: Record<string, unknown>,
  material?: CredentialMaterial,
): string | undefined {
  const account = validateAccount(e, actor, body),
    target = account.id;
  if (body.operation === 'disable' || body.operation === 'enable')
    e.db.exec(
      'UPDATE accounts SET enabled=?,version=version+1 WHERE id=?',
      body.operation === 'enable' ? 1 : 0,
      target,
    );
  else if (body.operation === 'duty')
    e.db.exec(
      'UPDATE accounts SET permissions=?,version=version+1 WHERE id=?',
      JSON.stringify(DUTIES[body.duty as keyof typeof DUTIES]),
      target,
    );
  else {
    requireThat(material, 'CREDENTIAL_NOT_PREPARED', '口令生成失败，请重试。', 503);
    e.db.exec(
      'UPDATE accounts SET credential_hash=?,version=version+1 WHERE id=?',
      material.hash,
      target,
    );
    e.db.exec(
      'INSERT INTO credential_deliveries VALUES(?,?,?,?,?)',
      material.id,
      actor.id,
      target,
      material.ciphertext,
      e.now(),
    );
  }
  e.db.exec('UPDATE sessions SET revoked=1 WHERE account_id=?', target);
  if (e.db.one('SELECT id FROM match_identity'))
    e.db.exec(
      'UPDATE memberships SET epoch=(SELECT version FROM accounts WHERE id=?) WHERE local_id=?',
      target,
      target,
    );
  e.db.exec('DELETE FROM previews WHERE actor=?', target);
  return body.operation === 'reset' ? material!.id : undefined;
}
