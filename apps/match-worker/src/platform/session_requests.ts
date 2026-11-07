import {parseJson, text} from '../../../../packages/contracts/src/backend';
import type {BackendEnv, RpcReply} from '../rpc/types';
import {decrypt, digest, encrypt, token} from '../security/crypto';
import {requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import type {AuthenticatedRequest} from './request_context';
import {base32, platformKey, verifyTotp} from './security';
import type {Account} from './types';

/** 按持久账号状态验证认证器或一次性恢复码，不建立近期认证时限。 */
export async function verifySecondFactor(
  host: DarkForestPlatform,
  env: BackendEnv,
  account: Account,
  raw: unknown,
): Promise<boolean> {
  if (!account.totp_ciphertext) {
    return false;
  }
  const code = typeof raw === 'string' ? raw : '';
  const secret = await decrypt(
    await platformKey(env),
    account.totp_ciphertext,
    `totp|${account.id}`,
  );
  const step = await verifyTotp(
    secret,
    code,
    account.last_totp_step,
    host.now(),
  );
  if (step >= 0) {
    return host.db.tx(() => {
      const current = host.account(account.id);
      requireThat(
        current.last_totp_step < step,
        'TOTP_REPLAY',
        '验证码已使用，请等待下一枚。',
        401,
      );
      host.db.exec(
        'UPDATE platform_accounts SET last_totp_step=? WHERE id=?',
        step,
        account.id,
      );
      return true;
    });
  }
  const hash = await digest(code);
  const r = host.db.one<Record<string, SqlStorageValue>>(
    'SELECT hash FROM recovery_codes WHERE account_id=? AND hash=? AND used=0',
    account.id,
    hash,
  );
  if (r) {
    host.db.exec('UPDATE recovery_codes SET used=1 WHERE hash=?', hash);
    return true;
  }
  return false;
}

/** 处理已通过登录、限流和CSRF检查的本人会话及第二因素请求。 */
export function sessionRequest(
  host: DarkForestPlatform,
  env: BackendEnv,
  request: AuthenticatedRequest,
): RpcReply | Promise<RpcReply> | undefined {
  const {input, path, session, hash} = request;
  if (path === '/auth/session') {
    return {status: 200, body: host.view(session)};
  }
  if (path === '/auth/logout') {
    requireThat(input.method === 'POST', 'METHOD', '请提交退出请求。', 405);
    host.db.exec(
      'UPDATE platform_sessions SET revoked=1 WHERE token_hash=?',
      hash,
    );
    return {status: 200, body: {loggedOut: true}, clearCookie: true};
  }
  if (path === '/auth/reauth' && input.method === 'POST') {
    return verifySessionFactor(host, env, request);
  }
  if (path === '/me/security/disable' && input.method === 'POST') {
    return disableSecondFactor(host, request);
  }
  if (path === '/me/security/setup' && input.method === 'POST') {
    return beginSecondFactorSetup(host, env, request);
  }
  if (path === '/me/security/confirm' && input.method === 'POST') {
    return confirmSecondFactorSetup(host, env, request);
  }
  if (path === '/me/sessions' && input.method === 'GET') {
    return {
      status: 200,
      body: host.db.all<{
        created_utc: number;
        expires: number;
        revoked: number;
      }>(
        'SELECT created_utc,expires,revoked FROM platform_sessions WHERE account_id=? ORDER BY created_utc DESC LIMIT 100',
        session.account_id,
      ),
    };
  }
  if (path === '/me/sessions/revoke' && input.method === 'POST') {
    host.db.exec(
      'UPDATE platform_sessions SET revoked=1 WHERE account_id=?',
      session.account_id,
    );
    return {status: 200, body: {revoked: true}, clearCookie: true};
  }
  if (path === '/me' && input.method === 'GET') {
    return {status: 200, body: host.view(session)};
  }
}
/** 验证长期口令及第二因素，仅更新当前会话验证状态，不延长登录有效期。 */
async function verifySessionFactor(
  host: DarkForestPlatform,
  env: BackendEnv,
  request: AuthenticatedRequest,
): Promise<RpcReply> {
  const {session, requestPayload, hash} = request;

  const targetAccount = host.account(session.account_id);
  host.limit(`reauth:${targetAccount.id}`, 10);
  requireThat(
    (await digest(text(requestPayload.credential, 128, 32))) ===
      targetAccount.credential_hash,
    'INVALID_CREDENTIAL',
    '口令无效。',
    401,
  );
  const factor = await verifySecondFactor(
    host,
    env,
    targetAccount,
    requestPayload.code,
  );
  requireThat(
    !targetAccount.totp_ciphertext || factor,
    'SECOND_FACTOR_REQUIRED',
    '验证码无效或已使用。',
    401,
  );
  host.db.exec(
    'UPDATE platform_sessions SET second_factor=? WHERE token_hash=?',
    factor ? 1 : 0,
    hash,
  );
  return {status: 200, body: host.view(host.login(hash))};
}

/** 关闭已验证会话所属账号的第二因素并保留审计。 */
function disableSecondFactor(
  host: DarkForestPlatform,
  request: AuthenticatedRequest,
): RpcReply {
  const {session, hash} = request;

  requireThat(
    session.second_factor === 1,
    'SECOND_FACTOR_REQUIRED',
    '请先使用验证码或恢复码验证第二因素。',
    403,
  );
  host.db.tx(() => {
    host.db.exec(
      'UPDATE platform_accounts SET totp_ciphertext=NULL,last_totp_step=-1 WHERE id=?',
      session.account_id,
    );
    host.db.exec(
      'DELETE FROM recovery_codes WHERE account_id=?',
      session.account_id,
    );
    host.db.exec('DELETE FROM platform_meta WHERE key=?', `totp:${hash}`);
    host.db.exec(
      'UPDATE platform_sessions SET second_factor=0 WHERE account_id=?',
      session.account_id,
    );
    host.audit(
      session.account_id,
      'second_factor_disabled',
      session.account_id,
      '本人关闭第二因素验证',
    );
  });
  return {status: 200, body: host.view(host.login(hash))};
}

/** 生成短期有效的待确认密钥，保持账号现有验证状态。 */
async function beginSecondFactorSetup(
  host: DarkForestPlatform,
  env: BackendEnv,
  request: AuthenticatedRequest,
): Promise<RpcReply> {
  const {session, hash} = request;

  requireThat(
    !host.account(session.account_id).totp_ciphertext,
    'ALREADY_CONFIGURED',
    '请使用现有第二因素或受控找回。',
  );
  const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
  const cipher = await encrypt(
    await platformKey(env),
    secret,
    `pending-totp|${hash}`,
  );
  host.db.exec(
    'INSERT OR REPLACE INTO platform_meta VALUES(?,?)',
    `totp:${hash}`,
    JSON.stringify({cipher, expires: host.now() + 600000}),
  );
  return {
    status: 200,
    body: {
      secret,
      uri: `otpauth://totp/DarkForest:${session.account_id}?secret=${secret}&issuer=DarkForest`,
    },
  };
}

/** 校验待确认认证器、保存恢复码并撤销其他设备会话。 */
async function confirmSecondFactorSetup(
  host: DarkForestPlatform,
  env: BackendEnv,
  request: AuthenticatedRequest,
): Promise<RpcReply> {
  const {session, hash, requestPayload} = request;

  host.limit(`factor:${session.account_id}`, 10);
  const row = host.db.one<{value: string}>(
    'SELECT value FROM platform_meta WHERE key=?',
    `totp:${hash}`,
  );
  requireThat(row, 'SETUP_REQUIRED', '请先设置第二因素。');
  const pending = parseJson(row.value) as {
    cipher: string;
    expires: number;
  };
  requireThat(
    pending.expires > host.now(),
    'SETUP_EXPIRED',
    '设置已过期，请重新开始。',
  );
  const secret = await decrypt(
    await platformKey(env),
    pending.cipher,
    `pending-totp|${hash}`,
  );
  const step = await verifyTotp(
    secret,
    String(requestPayload.code),
    -1,
    host.now(),
  );
  requireThat(step >= 0, 'INVALID_CODE', '验证码不正确。', 401);
  const cipher = await encrypt(
    await platformKey(env),
    secret,
    `totp|${session.account_id}`,
  );
  const codes = Array.from({length: 8}, () => token());
  const hashes = await Promise.all(codes.map(digest));
  host.db.tx(() => {
    requireThat(
      !host.account(session.account_id).totp_ciphertext,
      'ALREADY_CONFIGURED',
      '第二因素已设置。',
    );
    host.db.exec(
      'UPDATE platform_accounts SET totp_ciphertext=?,last_totp_step=? WHERE id=?',
      cipher,
      step,
      session.account_id,
    );
    host.db.exec(
      'UPDATE platform_sessions SET second_factor=1 WHERE token_hash=?',
      hash,
    );
    host.db.exec(
      'UPDATE platform_sessions SET revoked=1 WHERE account_id=? AND token_hash!=?',
      session.account_id,
      hash,
    );
    host.db.exec('DELETE FROM platform_meta WHERE key=?', `totp:${hash}`);
    for (const h of hashes) {
      host.db.exec(
        'INSERT INTO recovery_codes VALUES(?,?,0)',
        session.account_id,
        h,
      );
    }
  });
  return {status: 200, body: {recoveryCodes: codes}};
}
