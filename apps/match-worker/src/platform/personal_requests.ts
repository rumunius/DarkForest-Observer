import type {
  MatchEntry,
  MatchMember,
} from '../../../../packages/contracts/src/platform';
import type {BackendEnv, RpcReply} from '../rpc/types';
import {requireThat} from '../storage/store';
import {matchRequest} from './matches';
import type {DarkForestPlatform} from './platform';
import {operationView} from './policy';
import type {AuthenticatedRequest} from './request_context';
import type {Operation} from './types';

/** 按本人身份查询原操作和比赛目录；场内请求继续进入原授权路由。 */
export function personalRequest(
  host: DarkForestPlatform,
  env: BackendEnv,
  request: AuthenticatedRequest,
): RpcReply | Promise<RpcReply> | undefined {
  const {input, path, session} = request;
  const personalOperation =
    /^\/me\/operations\/([A-Za-z0-9_-]+)(\/resolve)?$/.exec(path);
  if (personalOperation) {
    return personalOperationRequest(host, request, personalOperation);
  }
  if (path === '/me/matches' && input.method === 'GET') {
    return listMyMatches(host, request);
  }
  if (path.startsWith('/matches/')) {
    return matchRequest(host, env, input, session);
  }
}
/** 查询或取消本人尚未接收的原操作，不能读取他人的交付材料。 */
function personalOperationRequest(
  host: DarkForestPlatform,
  request: AuthenticatedRequest,
  personalOperation: RegExpExecArray,
): RpcReply {
  const {input, session} = request;

  const id = personalOperation[1]!;
  const old = host.db.one<Operation>(
    'SELECT * FROM platform_operations WHERE id=?',
    id,
  );
  if (old) {
    requireThat(
      old.actor === session.account_id,
      'NOT_FOUND',
      '操作不存在。',
      404,
    );
    return {status: 200, body: operationView(host, old)};
  }
  if (input.method === 'POST' && personalOperation[2]) {
    host.db.tx(() => {
      if (
        !host.db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM platform_operations WHERE id=?',
          id,
        )
      ) {
        host.insertOperation(
          id,
          session.account_id,
          'cancel-unreceived',
          session.account_id,
          'cancelled',
          {},
          '确认未接收操作，阻止迟到请求',
          'cancelled',
        );
      }
    });
    return {status: 200, body: {id, status: 'cancelled'}};
  }
  return {
    status: 200,
    body: {
      id,
      status: 'unknown',
      message: '尚未取得提交收据，可确认未接收并阻止迟到请求。',
    },
  };
}

/** 读取当前账号可发现的场次，并使用原投影边界处理不可用比赛。 */
async function listMyMatches(
  host: DarkForestPlatform,
  request: AuthenticatedRequest,
): Promise<RpcReply> {
  const {session} = request;

  const entries = host.db.all<Omit<MatchEntry, 'membership'>>(
    'SELECT d.id,d.name,d.kind,d.state,d.version,d.created_utc,d.summary,d.synced_utc,d.recommended,d.retention_days,d.audit_days FROM match_directory d JOIN account_match_index i ON i.match_id=d.id WHERE i.account_id=? ORDER BY d.created_utc DESC LIMIT 200',
    session.account_id,
  );
  return {
    status: 200,
    body: (
      await Promise.all(
        entries.map(async entry => {
          if (
            ['provisioning', 'purged', 'imported_archive'].includes(entry.state)
          ) {
            return entry;
          }
          const current = await host.summary(
            host.directory(entry.id),
            session.account_id,
          );
          return {
            ...entry,
            phase: current.phase,
            membership: (current.members as MatchMember[]).find(
              member => member.account_id === session.account_id,
            ),
          };
        }),
      )
    ).filter(
      entry => !('membership' in entry) || entry.membership !== undefined,
    ),
  };
}
