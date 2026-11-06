import {
  object,
  requestId,
  scalarText,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import type {BackendEnv, RpcReply} from '../rpc/types';
import {digest, token} from '../security/crypto';
import {Fault, requireThat} from '../storage/store';
import {changeAccount, createAccount, importAccounts} from './accounts';
import {previewDetails, readPlatform} from './directory';
import {
  createMatch,
  recommendMatch,
  retryPlatformOperation,
  updatePlatformRoles,
} from './management_requests';
import type {DarkForestPlatform} from './platform';
import {operationView} from './policy';
import type {AuthenticatedRequest, PlatformMutation} from './request_context';
import {
  cancelRetentionPurge,
  changeRetentionHold,
  queueRetentionPurge,
} from './retention_requests';
import type {Operation} from './types';
import {DATA_ACTIONS} from './types';

/** 按原顺序校验平台任职、预览及幂等正文，再分派受控管理写入。 */
export async function adminRequest(
  host: DarkForestPlatform,
  env: BackendEnv,
  request: AuthenticatedRequest,
): Promise<RpcReply> {
  const {input, path, session, requestPayload} = request;
  host.admin(session, ['owner', 'admin', 'archivist']);
  if (input.method === 'GET') {
    return readPlatform(host, env, path, input, session);
  }
  if (path === '/platform/preview') {
    return previewPlatformChange(host, request);
  }
  if (path.startsWith('/platform/data/')) {
    requireThat(
      DATA_ACTIONS.includes(path),
      'NOT_FOUND',
      '该操作已不再提供。',
      404,
    );
  }
  const sensitive = ![
    '/platform/accounts/create',
    '/platform/accounts/import',
    '/platform/matches/create',
  ].includes(path);
  host.admin(
    session,
    path.startsWith('/platform/data/')
      ? ['owner', 'archivist']
      : path.startsWith('/platform/roles')
        ? ['owner']
        : ['owner', 'admin'],
  );
  const id = requestId(requestPayload.request_id);
  const reason = text(requestPayload.reason, 500);
  const body = {...requestPayload};
  delete body.preview_token;
  delete body.request_id;
  const bodyHash = await digest(stableJson({path, body}));
  const prior = host.db.one<Operation>(
    'SELECT * FROM platform_operations WHERE id=?',
    id,
  );
  if (prior) {
    requireThat(
      prior.actor === session.account_id && prior.body_hash === bodyHash,
      'OPERATION_CONFLICT',
      '操作编号已用于不同内容。',
    );
    return {status: 200, body: operationView(host, prior)};
  }
  if (sensitive) {
    const preview = host.db.one<{body_hash: string}>(
      'SELECT body_hash FROM platform_previews WHERE id=? AND actor=? AND path=? AND expires>?',
      String(requestPayload.preview_token),
      session.account_id,
      path,
      host.now(),
    );
    requireThat(
      preview && preview.body_hash === (await digest(stableJson(body))),
      'PREVIEW_REQUIRED',
      '请重新预览当前场次、账号与影响。',
    );
  }
  const mutation: PlatformMutation = {...request, id, reason, bodyHash};
  return executePlatformMutation(host, env, mutation);
}

/** 根据真实数据生成短期预览，不能以该投影代替提交时的授权。 */
async function previewPlatformChange(
  host: DarkForestPlatform,
  request: AuthenticatedRequest,
): Promise<RpcReply> {
  const {session, requestPayload} = request;

  host.admin(session, ['owner', 'admin', 'archivist']);
  const target = text(requestPayload.path, 200);
  const payload = object(requestPayload.payload);
  const id = token();
  const bodyHash = await digest(stableJson(payload));
  if (target.startsWith('/platform/data/')) {
    requireThat(
      DATA_ACTIONS.includes(target),
      'NOT_FOUND',
      '该操作已不再提供。',
      404,
    );
    host.admin(session, ['owner', 'archivist']);
    if (payload.matchId) {
      requireThat(
        host.dataScope(session.account_id, scalarText(payload.matchId)),
        'ARCHIVE_SCOPE_REQUIRED',
        '当前账号未获本场数据管理权限。',
        403,
      );
    }
  } else {
    host.admin(session, ['owner', 'admin']);
  }
  const preview = await previewDetails(host, target, payload, session);
  host.db.exec(
    'INSERT INTO platform_previews VALUES(?,?,?,?,?)',
    id,
    session.account_id,
    target,
    bodyHash,
    host.now() + 300000,
  );
  return {
    status: 200,
    body: {previewToken: id, expiresUtc: host.now() + 300000, ...preview},
  };
}

/** 仅在共同权限、幂等及预览门禁之后分派平台写入。 */
function executePlatformMutation(
  host: DarkForestPlatform,
  env: BackendEnv,
  mutation: PlatformMutation,
): RpcReply | Promise<RpcReply> {
  const {path, session, requestPayload, id, reason, bodyHash} = mutation;
  if (path === '/platform/accounts/create') {
    return createAccount(
      host,
      env,
      session,
      id,
      requestPayload,
      bodyHash,
      reason,
    );
  }
  if (path === '/platform/accounts/import') {
    return importAccounts(host, session, id, requestPayload, bodyHash, reason);
  }
  if (path === '/platform/matches/create') {
    return createMatch(host, mutation);
  }
  if (path.startsWith('/platform/accounts/')) {
    return changeAccount(
      host,
      env,
      session,
      id,
      path,
      requestPayload,
      bodyHash,
      reason,
    );
  }
  if (path === '/platform/roles/update') {
    return updatePlatformRoles(host, mutation);
  }
  if (path === '/platform/matches/recommend') {
    return recommendMatch(host, mutation);
  }
  if (path === '/platform/operations/retry') {
    return retryPlatformOperation(host, mutation);
  }
  if (path === '/platform/data/hold') {
    return changeRetentionHold(host, mutation);
  }
  if (path === '/platform/data/purge') {
    return queueRetentionPurge(host, mutation);
  }
  if (path === '/platform/data/cancel-purge') {
    return cancelRetentionPurge(host, mutation);
  }
  throw new Fault(404, 'NOT_FOUND', '平台接口不存在。');
}
