import {object, text} from '../../../../packages/contracts/src/backend';
import type {BackendEnv, RpcInput, RpcReply} from '../rpc/types';
import {digest, token} from '../security/crypto';
import {requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import {verifySecondFactor} from './session_requests';
import type {Account} from './types';

/** 仅分派无需既有会话的长期口令交换和邀请领取，其他路径交回会话入口。 */
export function publicAuthentication(
  host: DarkForestPlatform,
  env: BackendEnv,
  input: RpcInput,
): Promise<RpcReply> | null {
  const {path, method} = input;
  if (path === '/auth/exchange' && method === 'POST') {
    return exchangeCredential(host, env, input);
  }
  if (path === '/auth/claim' && method === 'POST') {
    return claimInvitation(host, input);
  }
  return null;
}

/** 验证账号与第二因素，在原事务中建立十二小时会话。 */
async function exchangeCredential(
  host: DarkForestPlatform,
  env: BackendEnv,
  input: RpcInput,
): Promise<RpcReply> {
  host.limit(`login:${input.clientKey}`, 30);
  const payload = object(input.body);
  const hash = await digest(text(payload.credential, 128, 32));
  const kind =
    payload.audience === 'player'
      ? 'player'
      : payload.audience === 'staff' || payload.audience === 'judge'
        ? 'staff'
        : '';
  requireThat(kind, 'BAD_AUDIENCE', '登录入口不正确。', 400);
  const account = host.db.one<Account>(
    "SELECT * FROM platform_accounts WHERE credential_hash=? AND kind=? AND status='active'",
    hash,
    kind,
  );
  requireThat(account, 'INVALID_CREDENTIAL', '登录口令无效。', 401);
  const factor = await verifySecondFactor(host, env, account, payload.code);
  requireThat(
    !account.totp_ciphertext || factor,
    'SECOND_FACTOR_REQUIRED',
    '请输入第二因素验证码或一次性恢复码。',
    401,
  );
  const raw = token();
  const tokenHash = await digest(raw);
  const csrf = token();
  host.db.tx(() => {
    requireThat(
      host.account(account.id).auth_epoch === account.auth_epoch,
      'AUTH_CHANGED',
      '凭据已更新。',
      401,
    );
    host.db.exec(
      'INSERT INTO platform_sessions VALUES(?,?,?,?,?,?,?,?,0)',
      tokenHash,
      account.id,
      account.auth_epoch,
      csrf,
      host.now(),
      host.now() + 43200000,
      0, // Retain the unused reauth_utc column for existing platform databases.
      factor ? 1 : 0,
    );
  });
  return {
    status: 200,
    body: host.view(host.login(tokenHash)),
    sessionToken: raw,
  };
}

/** 领取未过期的一次性邀请，原子更新凭据并撤销旧会话。 */
async function claimInvitation(
  host: DarkForestPlatform,
  input: RpcInput,
): Promise<RpcReply> {
  host.limit(`claim:${input.clientKey}`, 20);
  const requestPayload = object(input.body);
  const hash = await digest(text(requestPayload.invitation, 100, 32));
  const invite = host.db.one<{
    id: string;
    account_id: string;
    claimed: number;
    expires: number;
  }>('SELECT * FROM invitations WHERE token_hash=?', hash);
  requireThat(
    invite && !invite.claimed && invite.expires > host.now(),
    'INVITATION_EXPIRED',
    '邀请已失效，请联系管理员重新发送。',
    401,
  );
  const credential = token();
  const credentialHash = await digest(credential);
  host.db.tx(() => {
    requireThat(
      host.db.one<{claimed: number}>(
        'SELECT claimed FROM invitations WHERE id=?',
        invite.id,
      )?.claimed === 0,
      'INVITATION_USED',
      '邀请已被领取。',
      409,
    );
    requireThat(
      host.account(invite.account_id).status !== 'disabled',
      'ACCOUNT_DISABLED',
      '账号已停用。',
      403,
    );
    host.db.exec(
      'UPDATE invitations SET claimed=1,ciphertext=NULL WHERE id=?',
      invite.id,
    );
    host.db.exec(
      "UPDATE platform_accounts SET credential_hash=?,status='active',version=version+1,auth_epoch=auth_epoch+1 WHERE id=?",
      credentialHash,
      invite.account_id,
    );
    host.db.exec(
      'UPDATE platform_sessions SET revoked=1 WHERE account_id=?',
      invite.account_id,
    );
    host.audit(invite.account_id, 'claim', invite.account_id, '领取长期账号');
  });
  return {
    status: 200,
    body: {
      accountId: invite.account_id,
      credential,
      message: '请立即安全保存长期口令；离开后不能查看。',
    },
  };
}
