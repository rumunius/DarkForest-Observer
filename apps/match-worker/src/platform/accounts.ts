import {assertVersion, protectOwner} from './policy';
import {
  object,
  parseJson,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import type {BackendEnv, RpcReply} from '../rpc/types';
import {digest, encrypt, token} from '../security/crypto';
import {requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import {platformKey} from './security';
import type {Login} from './types';

/** 建立长期账号和一次性邀请，原始口令不直接进入账号表或普通审计。 */
export async function createAccount(
  host: DarkForestPlatform,
  environment: BackendEnv,
  session: Login,
  id: string,
  payload: Record<string, unknown>,
  hash: string,
  reason: string,
): Promise<RpcReply> {
  const kind = payload.kind;
  requireThat(
    kind === 'player' || kind === 'staff',
    'BAD_KIND',
    '账号类别不正确。',
    400,
  );
  const name = text(payload.name, 100);
  const accountId = crypto.randomUUID();
  const invitation = token();
  const inviteId = crypto.randomUUID();
  const inviteHash = await digest(invitation);
  const cipher = await encrypt(
    await platformKey(environment),
    invitation,
    `invitation|${inviteId}`,
  );
  host.db.tx(() => {
    host.db.exec(
      'INSERT INTO platform_accounts(id,kind,name,status,tags,created_utc) VALUES(?,?,?,?,?,?)',
      accountId,
      kind,
      name,
      'pending',
      typeof payload.tags === 'string' ? text(payload.tags, 500, 0) : '',
      host.now(),
    );
    host.db.exec(
      'INSERT INTO invitations VALUES(?,?,?,?,0,?,?,?)',
      inviteId,
      accountId,
      inviteHash,
      host.now() + 7 * 86400000,
      cipher,
      host.now() + 86400000,
      session.account_id,
    );
    host.insertOperation(
      id,
      session.account_id,
      'account-create',
      accountId,
      hash,
      {},
      reason,
      'succeeded',
    );
    host.db.exec(
      'UPDATE platform_operations SET result=? WHERE id=?',
      JSON.stringify({accountId, invitationId: inviteId}),
      id,
    );
  });
  return {
    status: 201,
    body: {
      accountId,
      invitationId: inviteId,
      invitation,
      expiresUtc: host.now() + 7 * 86400000,
    },
  };
}

/** 逐行验证并导入长期账号，保留行级错误和原请求的幂等结果。 */
export async function importAccounts(
  host: DarkForestPlatform,
  session: Login,
  id: string,
  payload: Record<string, unknown>,
  hash: string,
  reason: string,
): Promise<RpcReply> {
  requireThat(
    Array.isArray(payload.rows) &&
      payload.rows.length <= 100 &&
      payload.rows.length > 0,
    'IMPORT_LIMIT',
    '每批须为1—100行，请分批导入。',
    400,
  );
  const rows = payload.rows.map((r, index) => {
    try {
      const row = object(r);
      requireThat(
        row.kind === 'player' || row.kind === 'staff',
        'BAD_KIND',
        '类别须为player或staff。',
        400,
      );
      return {
        line: index + 1,
        name: text(row.name, 100),
        kind: row.kind,
        accountId: typeof row.accountId === 'string' ? row.accountId : null,
        error: '',
      };
    } catch (error) {
      return {
        line: index + 1,
        name: '',
        kind: 'player',
        accountId: null,
        error: error instanceof Error ? error.message : '格式错误',
      };
    }
  });
  const errors = rows.filter(r => r.error);
  if (payload.preview === true) {
    return {
      status: 200,
      body: {rows, valid: rows.length - errors.length, errors: errors.length},
    };
  }
  requireThat(
    !errors.length,
    'IMPORT_ERRORS',
    '请先修复预览中的行级错误。',
    400,
  );
  const batch = text(payload.batchId, 100);
  const fileHash = await digest(stableJson(payload.rows));
  const old = host.db.one<{body_hash: string; result: string}>(
    'SELECT * FROM import_batches WHERE id=?',
    batch,
  );
  if (old) {
    requireThat(
      old.body_hash === fileHash,
      'BATCH_CONFLICT',
      '该批次对应不同文件。',
    );
    return {status: 200, body: parseJson(old.result)};
  }
  const result = rows.map(r => ({
    ...r,
    id: r.accountId ?? crypto.randomUUID(),
  }));
  host.db.tx(() => {
    for (const row of result) {
      if (row.accountId) {
        const account = host.account(row.accountId);
        requireThat(
          payload.confirmMapping === true && account.kind === row.kind,
          'MAPPING_REQUIRED',
          '已有账号需按明确ID确认映射。',
        );
        host.db.exec(
          'UPDATE platform_accounts SET name=?,version=version+1 WHERE id=?',
          row.name,
          row.id,
        );
      } else {
        host.db.exec(
          "INSERT INTO platform_accounts(id,kind,name,status,created_utc) VALUES(?,?,?,'pending',?)",
          row.id,
          row.kind,
          row.name,
          host.now(),
        );
      }
    }
    host.db.exec(
      'INSERT INTO import_batches VALUES(?,?,?,?)',
      batch,
      fileHash,
      JSON.stringify({rows: result}),
      session.account_id,
    );
    host.insertOperation(
      id,
      session.account_id,
      'account-import',
      batch,
      hash,
      {},
      reason,
      'succeeded',
    );
  });
  return {
    status: 201,
    body: {
      rows: result,
      message: '未领取账号请在账号池单独生成邀请；同名不会合并。',
    },
  };
}

/** 在最新账号版本和所有者保护条件下处理停用、凭据或岗位变更。 */
export async function changeAccount(
  host: DarkForestPlatform,
  environment: BackendEnv,
  session: Login,
  id: string,
  path: string,
  payload: Record<string, unknown>,
  hash: string,
  reason: string,
): Promise<RpcReply> {
  const account = host.account(text(payload.accountId, 100));
  assertVersion(host, account, payload.expected_version);
  if (
    path === '/platform/accounts/invite' ||
    path === '/platform/accounts/reset'
  ) {
    if (path.endsWith('/reset')) {
      requireThat(
        account.status !== 'disabled',
        'DISABLED',
        '停用账号需先受控启用。',
      );
    }
    const invitation = token();
    const inviteId = crypto.randomUUID();
    const inviteHash = await digest(invitation);
    const cipher = await encrypt(
      await platformKey(environment),
      invitation,
      `invitation|${inviteId}`,
    );
    host.db.tx(() => {
      assertVersion(host, host.account(account.id), payload.expected_version);
      host.db.exec(
        'UPDATE invitations SET claimed=1,ciphertext=NULL WHERE account_id=?',
        account.id,
      );
      host.db.exec(
        'INSERT INTO invitations VALUES(?,?,?,?,0,?,?,?)',
        inviteId,
        account.id,
        inviteHash,
        host.now() + 7 * 86400000,
        cipher,
        host.now() + 86400000,
        session.account_id,
      );
      if (path.endsWith('/reset')) {
        host.db.exec(
          'UPDATE platform_accounts SET credential_hash=NULL,auth_epoch=auth_epoch+1,version=version+1 WHERE id=?',
          account.id,
        );
        host.db.exec(
          'UPDATE platform_sessions SET revoked=1 WHERE account_id=?',
          account.id,
        );
      } else {
        host.db.exec(
          'UPDATE platform_accounts SET version=version+1 WHERE id=?',
          account.id,
        );
      }
      host.insertOperation(
        id,
        session.account_id,
        'credential-invite',
        account.id,
        hash,
        {},
        reason,
        'succeeded',
      );
      host.db.exec(
        'UPDATE platform_operations SET result=? WHERE id=?',
        JSON.stringify({invitationId: inviteId}),
        id,
      );
    });
    return {
      status: 200,
      body: {
        invitationId: inviteId,
        invitation,
        warning:
          '重置影响全部比赛，旧口令和会话已失效；管理任务授权仍须另行撤销。',
      },
    };
  }
  requireThat(
    path === '/platform/accounts/status',
    'NOT_FOUND',
    '账号操作不存在。',
    404,
  );
  requireThat(
    payload.status === 'active' || payload.status === 'disabled',
    'BAD_STATUS',
    '请选择启用或停用。',
    400,
  );
  if (payload.status === 'disabled' && payload.emergency !== true) {
    for (const target of host.db.all<{match_id: string}>(
      'SELECT match_id FROM account_match_index WHERE account_id=?',
      account.id,
    )) {
      const matchEntry = host.directory(target.match_id);
      const current = await host.summary(matchEntry, session.account_id);
      requireThat(
        !(
          current.members as Array<{
            account_id: string;
            local_id: string;
            state: string;
          }>
        ).some(
          m =>
            m.account_id === account.id &&
            m.local_id === 'J01' &&
            m.state === 'bound',
        ),
        'HEAD_HANDOVER_REQUIRED',
        `该账号仍任${matchEntry.name}的总裁判，请先交接岗位；凭据泄漏时可选择紧急停用。`,
      );
    }
  }
  host.db.tx(() => {
    assertVersion(host, host.account(account.id), payload.expected_version);
    if (payload.status === 'disabled' && payload.emergency !== true) {
      protectOwner(host, account.id);
    }
    host.db.exec(
      'UPDATE platform_accounts SET status=?,auth_epoch=auth_epoch+1,version=version+1 WHERE id=?',
      payload.status === 'active' && !account.credential_hash
        ? 'pending'
        : (payload.status as string),
      account.id,
    );
    host.db.exec(
      'UPDATE platform_sessions SET revoked=1 WHERE account_id=?',
      account.id,
    );
    const updated = host.account(account.id);
    host.insertOperation(
      id,
      session.account_id,
      'fence',
      account.id,
      hash,
      {
        accountId: account.id,
        authEpoch: updated.auth_epoch,
        disabled: payload.status === 'disabled',
      },
      reason,
    );
    for (const target of host.db.all<{match_id: string}>(
      'SELECT match_id FROM account_match_index WHERE account_id=?',
      account.id,
    )) {
      host.db.exec(
        'INSERT INTO operation_targets(operation_id,target) VALUES(?,?)',
        id,
        target.match_id,
      );
    }
  });
  await host.arm();
  return {
    status: 202,
    body: {
      operationId: id,
      status: 'pending',
      message: '平台已拒绝旧授权；逐场撤销完成前，在途请求可能已提交。',
    },
  };
}
