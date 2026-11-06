import {operationView} from './policy';
import {text} from '../../../../packages/contracts/src/backend';
import type {BackendEnv, RpcInput, RpcReply} from '../rpc/types';
import {decrypt} from '../security/crypto';
import {Fault, requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import {platformKey} from './security';
import type {Account, Login, Operation} from './types';

/** 按平台任职和资料授权范围读取目录及操作，不授予隐式本场执裁权。 */
export async function readPlatform(
  host: DarkForestPlatform,
  environment: BackendEnv,
  path: string,
  input: RpcInput,
  session: Login,
): Promise<RpcReply> {
  const url = new URL(input.path, 'https://internal');
  const manager = host
    .roles(session.account_id)
    .some(role => ['owner', 'admin'].includes(role));
  const canSee = (id: string) =>
    manager || host.dataScope(session.account_id, id);
  if (path === '/platform/accounts') {
    host.admin(session);
    const after = url.searchParams.get('after') ?? '';
    return {
      status: 200,
      body: host.db
        .all<Account>(
          'SELECT * FROM platform_accounts WHERE id>? ORDER BY id LIMIT 100',
          after,
        )
        .map(a => host.safeAccount(a)),
    };
  }
  if (path === '/platform/matches') {
    return {
      status: 200,
      body: host.db
        .all<{id: string}>(
          'SELECT id,name,kind,state,version,created_utc,summary,synced_utc,recommended,retention_days,audit_days FROM match_directory ORDER BY created_utc DESC LIMIT 200',
        )
        .filter(row => canSee(row.id)),
    };
  }
  if (path === '/platform/operations') {
    return {
      status: 200,
      body: host.db
        .all<Operation>(
          'SELECT * FROM platform_operations ORDER BY created_utc DESC LIMIT 100',
        )
        .filter(op => op.actor === session.account_id || canSee(op.target))
        .map(op => operationView(host, op)),
    };
  }
  if (path.startsWith('/platform/operations/')) {
    const operation = host.db.one<Operation>(
      'SELECT * FROM platform_operations WHERE id=?',
      path.slice(21),
    );
    requireThat(
      operation &&
        (operation.actor === session.account_id || canSee(operation.target)),
      'NOT_FOUND',
      '任务不存在或当前账号不能查看。',
      404,
    );
    return {status: 200, body: operationView(host, operation)};
  }
  if (path === '/platform/security') {
    host.admin(session, ['owner']);
    return {
      status: 200,
      body: {
        roles: host.db.all<Record<string, SqlStorageValue>>(
          'SELECT r.account_id,a.name,r.role FROM platform_roles r JOIN platform_accounts a ON a.id=r.account_id',
        ),
        audit: host.db.all<Record<string, SqlStorageValue>>(
          'SELECT * FROM platform_audit ORDER BY utc_ms DESC LIMIT 100',
        ),
      },
    };
  }
  if (path === '/platform/data') {
    host.admin(session, ['owner', 'archivist']);
    return {
      status: 200,
      body: {
        holds: host.db
          .all<{match_id: string}>('SELECT * FROM retention_holds')
          .filter(row => host.dataScope(session.account_id, row.match_id)),
        ledger: host.db
          .all<{match_id: string}>('SELECT * FROM erasure_ledger')
          .filter(row => host.dataScope(session.account_id, row.match_id)),
      },
    };
  }
  if (path.startsWith('/platform/invitations/')) {
    host.admin(session, ['owner', 'admin']);
    const row = host.db.one<{
      id: string;
      ciphertext: string | null;
      delivery_expires: number;
      issuer: string;
    }>(
      'SELECT * FROM invitations WHERE id=?',
      path.slice('/platform/invitations/'.length),
    );
    requireThat(
      row &&
        row.issuer === session.account_id &&
        row.ciphertext &&
        row.delivery_expires > host.now(),
      'DELIVERY_EXPIRED',
      '交付材料已过期，请重新发送邀请。',
      404,
    );
    const invitation = await decrypt(
      await platformKey(environment),
      row.ciphertext,
      `invitation|${row.id}`,
    );
    host.admin(host.login(session.token_hash), ['owner', 'admin']);
    return {status: 200, body: {invitation}};
  }
  throw new Fault(404, 'NOT_FOUND', '页面数据不存在。');
}

/** 从本场权威状态生成平台管理影响说明，确认时仍需复核依赖。 */
export async function previewDetails(
  host: DarkForestPlatform,
  path: string,
  payload: Record<string, unknown>,
  session: Login,
): Promise<Record<string, unknown>> {
  if (payload.matchId) {
    const matchEntry = host.directory(text(payload.matchId, 100));
    const summary = await host.summary(matchEntry, session.account_id);
    return {
      match: {
        id: matchEntry.id,
        name: matchEntry.name,
        kind: matchEntry.kind,
        version: matchEntry.version,
      },
      current: path.startsWith('/platform/data/')
        ? {
            phase: summary.phase,
            retention_days: matchEntry.retention_days,
            audit_days: matchEntry.audit_days,
          }
        : summary,
      warning: path.includes('purge')
        ? '提交后等待7天再清理网站上的完整复盘。请提前下载需要保留的资料；已下载的文件需要另行处理。'
        : '权限与比赛状态将在提交时再次检查。',
    };
  }
  if (payload.accountId) {
    const a = host.account(text(payload.accountId, 100));
    return {
      account: host.safeAccount(a),
      matches: host.db.all<Record<string, SqlStorageValue>>(
        'SELECT match_id FROM account_match_index WHERE account_id=?',
        a.id,
      ),
      warning:
        '全局停用先拒绝新授权，再逐场撤销；已在撤销栅栏前提交的在途请求可能已成功。',
    };
  }
  return {warning: '执行后会保留审计与逐目标收据。'};
}
