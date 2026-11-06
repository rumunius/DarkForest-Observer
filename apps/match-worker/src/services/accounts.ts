import {accountPermissions} from '../storage/store';
import type {AccountSummary} from '@darkforest/contracts';
import {integer, text} from '../../../../packages/contracts/src/backend';
import {permission, requireThat, type Actor} from '../storage/store';
import type {Engine} from './engine';
import {digest, encrypt, token} from '../security/crypto';
/** 事务外预生成、事务内消费的凭据材料，原口令不进入普通审计。 */
export interface CredentialMaterial {
  id: string;
  hash: string;
  ciphertext: string;
}
/** 本场裁判岗位到权限的服务端映射，供任职与账号变更统一使用。 */
export const DUTIES = {
  communications: [
    'overview',
    'homeworlds',
    'notices',
    'players',
    'events',
    'account',
  ],
  events: ['overview', 'notices', 'events', 'players', 'account'],
};
/** 为裁判管理页提供脱敏账号信息，不返回登录秘密或第二因素密文。 */
export function accountList(engine: Engine, actor: Actor): AccountSummary[] {
  permission(actor, 'system');
  return engine.db.all<Actor>('SELECT * FROM accounts ORDER BY id').map(a => ({
    id: a.id,
    name: a.name,
    role: a.role,
    enabled: !!a.enabled,
    version: a.version,
    permissions: accountPermissions(a),
  }));
}
/** 为后续账号变更预生成凭据与加密交付材料，尚未修改账号。 */
export async function prepareCredential(
  engine: Engine,
  actor: string,
): Promise<CredentialMaterial> {
  const id = crypto.randomUUID();
  const credential = token();
  const keys = await engine.keys();
  return {
    id,
    hash: await digest(credential),
    ciphertext: await encrypt(
      keys.encryption,
      credential,
      `credential|${engine.matchId}|${actor}|${id}`,
    ),
  };
}
/** 在执行前核对目标账号、版本及允许的账号管理操作。 */
export function validateAccount(
  engine: Engine,
  actor: Actor,
  body: Record<string, unknown>,
): Actor {
  permission(actor, 'system');
  const target = text(body.target, 16);
  const account = engine.db.one<Actor>(
    'SELECT * FROM accounts WHERE id=?',
    target,
  );
  requireThat(
    account && account.version === integer(body.expected_version, 1),
    'ACCOUNT_VERSION_CONFLICT',
    '账号状态已更新，请刷新后核对。',
  );
  if (
    engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT id FROM match_identity',
    )
  ) {
    requireThat(
      account.role === 'player' &&
        ['disable', 'enable'].includes(String(body.operation)),
      'PLATFORM_ACCOUNT_REQUIRED',
      '长期口令请由平台管理员在账号池找回；裁判换人请使用本场岗位交接。',
    );
  }
  requireThat(
    target !== actor.id && !accountPermissions(account).includes('system'),
    'HEAD_ACCOUNT_PROTECTED',
    '总裁判账号由部署管理员管理。',
  );
  requireThat(
    ['disable', 'enable', 'reset', 'duty'].includes(String(body.operation)),
    'BAD_OPERATION',
    '请选择账号操作。',
    400,
  );
  if (body.operation === 'duty') {
    requireThat(
      account.role === 'judge' &&
        ['communications', 'events'].includes(String(body.duty)),
      'BAD_DUTY',
      '请选择裁判职责。',
      400,
    );
  }
  return account;
}
/** 在调用方事务内应用账号变更并撤销相关旧会话，保留幂等交付依据。 */
export function updateAccount(
  engine: Engine,
  actor: Actor,
  body: Record<string, unknown>,
  material?: CredentialMaterial,
): string | undefined {
  const account = validateAccount(engine, actor, body);
  const target = account.id;
  if (body.operation === 'disable' || body.operation === 'enable') {
    engine.db.exec(
      'UPDATE accounts SET enabled=?,version=version+1 WHERE id=?',
      body.operation === 'enable' ? 1 : 0,
      target,
    );
  } else if (body.operation === 'duty') {
    engine.db.exec(
      'UPDATE accounts SET permissions=?,version=version+1 WHERE id=?',
      JSON.stringify(DUTIES[body.duty as keyof typeof DUTIES]),
      target,
    );
  } else {
    requireThat(
      material,
      'CREDENTIAL_NOT_PREPARED',
      '口令生成失败，请重试。',
      503,
    );
    engine.db.exec(
      'UPDATE accounts SET credential_hash=?,version=version+1 WHERE id=?',
      material.hash,
      target,
    );
    engine.db.exec(
      'INSERT INTO credential_deliveries VALUES(?,?,?,?,?)',
      material.id,
      actor.id,
      target,
      material.ciphertext,
      engine.now(),
    );
  }
  engine.db.exec('UPDATE sessions SET revoked=1 WHERE account_id=?', target);
  if (
    engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT id FROM match_identity',
    )
  ) {
    engine.db.exec(
      'UPDATE memberships SET epoch=(SELECT version FROM accounts WHERE id=?) WHERE local_id=?',
      target,
      target,
    );
  }
  engine.db.exec('DELETE FROM previews WHERE actor=?', target);
  return body.operation === 'reset' ? material!.id : undefined;
}
