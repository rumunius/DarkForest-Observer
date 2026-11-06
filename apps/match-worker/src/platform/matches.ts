import {operationView} from './policy';
import {
  integer,
  object,
  parseJson,
  requestId,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import type {
  MatchDownload,
  MatchHistory,
  MatchMember,
} from '../../../../packages/contracts/src/platform';
import type {BackendEnv, MatchGrant, RpcInput, RpcReply} from '../rpc/types';
import {digest, token} from '../security/crypto';
import {Fault, requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import {erasureFloor} from './retention';
import {controlSignature} from './security';
import type {Directory, Login, Operation} from './types';

const memberControlActions: Record<string, string> = {
  '/members/invite': 'invite',
  '/members/remove': 'remove-member',
  '/members/accept': 'accept',
  '/members/bind': 'bind',
  '/staff/assign': 'assign',
  '/publish': 'publish',
};

/** 处理成员邀请、绑定、岗位交接及发布请求，跨对象变更以持久操作驱动。 */
export async function matchRequest(
  host: DarkForestPlatform,
  environment: BackendEnv,
  input: RpcInput,
  session: Login,
): Promise<RpcReply> {
  const url = new URL(input.path, 'https://internal');
  const match = /^\/matches\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
  requireThat(match, 'MATCH_NOT_FOUND', '场次地址无效。', 404);
  const matchEntry = host.directory(match[1]!);
  const path = match[2] ?? '/';
  const indexed = !!host.db.one<Record<string, SqlStorageValue>>(
    'SELECT account_id FROM account_match_index WHERE account_id=? AND match_id=?',
    session.account_id,
    matchEntry.id,
  );
  const admin = host
    .roles(session.account_id)
    .some(r => ['owner', 'admin'].includes(r));
  if (
    ((path === '/manage' || path === '/eligible') && input.method === 'GET') ||
    (path === '/preview' && input.method === 'POST')
  ) {
    const current = await host.summary(matchEntry, session.account_id);
    const head = (
      current.members as Array<{
        account_id: string;
        local_id: string;
        state: string;
      }>
    ).some(
      m =>
        m.account_id === session.account_id &&
        m.local_id === 'J01' &&
        m.state === 'bound',
    );
    if (admin) {
      host.admin(session);
    } else {
      requireThat(head, 'FORBIDDEN', '需要本场总裁判或平台管理员。', 403);
    }
    if (path === '/eligible') {
      return {
        status: 200,
        body: (
          current.members as Array<{
            account_id: string;
            name: string;
            kind: string;
            state: string;
          }>
        )
          .filter(m => m.kind === 'staff' && m.state === 'accepted')
          .map(m => ({
            id: m.account_id,
            name: m.name,
            kind: 'staff',
            status: 'active',
          })),
      };
    }
    if (path === '/preview') {
      const body = object(input.body);
      const payload = object(body.payload);
      const target = text(body.path, 200);
      requireThat(
        target === `/matches/${matchEntry.id}/staff/assign`,
        'BAD_PREVIEW',
        '本页面只预览本场裁判交接。',
        400,
      );
      const previewToken = token();
      host.db.exec(
        'INSERT INTO platform_previews VALUES(?,?,?,?,?)',
        previewToken,
        session.account_id,
        target,
        await digest(stableJson(payload)),
        host.now() + 300000,
      );
      return {
        status: 200,
        body: {
          previewToken,
          match: {name: matchEntry.name, kind: matchEntry.kind},
          current,
          warning: '交接后旧任职结束，旧预览失效。未执行管理任务需要重新核对。',
        },
      };
    }
    return {status: 200, body: {match: matchEntry, current}};
  }
  if (
    input.method === 'GET' &&
    (path === '/history' || path.startsWith('/history/'))
  ) {
    return matchHistory(host, session, matchEntry, path, url);
  }
  if (
    input.method === 'POST' &&
    [
      '/members/invite',
      '/members/remove',
      '/members/accept',
      '/members/bind',
      '/staff/assign',
      '/publish',
    ].includes(path)
  ) {
    const requestPayload = object(input.body);
    const id = requestId(requestPayload.request_id);
    const reason = text(requestPayload.reason, 500);
    const bodyHash = await digest(
      stableJson({path, matchId: matchEntry.id, body: requestPayload}),
    );
    const old = host.db.one<Operation>(
      'SELECT * FROM platform_operations WHERE id=?',
      id,
    );
    if (old) {
      requireThat(
        old.actor === session.account_id && old.body_hash === bodyHash,
        'OPERATION_CONFLICT',
        '操作编号已用于不同内容。',
      );
      return {status: 200, body: operationView(host, old)};
    }
    const self = path === '/members/accept' || path === '/members/bind';
    const actor = session.account_id;
    if (self) {
      requireThat(indexed, 'FORBIDDEN', '请先取得本场邀请。', 403);
    } else {
      if (admin) {
        host.admin(session, ['owner', 'admin']);
      } else {
        const current = await host.summary(matchEntry, session.account_id);
        const member = (
          current.members as Array<{
            account_id: string;
            local_id: string;
            state: string;
          }>
        ).find(
          m =>
            m.account_id === session.account_id &&
            m.local_id === 'J01' &&
            m.state === 'bound',
        );
        requireThat(member, 'FORBIDDEN', '需要本场总裁判或平台管理员。', 403);
        requireThat(
          !(
            path === '/staff/assign' &&
            requestPayload.seat === 'J01' &&
            requestPayload.takeover === true
          ),
          'FORBIDDEN',
          '失联接管需要平台管理员。',
          403,
        );
      }
      const payload = {...requestPayload};
      delete payload.request_id;
      delete payload.preview_token;
      if (path === '/staff/assign') {
        const preview = host.db.one<{body_hash: string}>(
          'SELECT body_hash FROM platform_previews WHERE id=? AND actor=? AND path=? AND expires>?',
          String(requestPayload.preview_token),
          session.account_id,
          `/matches/${matchEntry.id}${path}`,
          host.now(),
        );
        requireThat(
          preview?.body_hash === (await digest(stableJson(payload))),
          'PREVIEW_REQUIRED',
          '请重新预览裁判交接影响。',
        );
        const a = host.account(text(requestPayload.accountId, 100));
        requireThat(
          a.status === 'active' && a.kind === 'staff',
          'ACTIVE_STAFF_REQUIRED',
          '新裁判需先激活工作人员账号。',
        );
      }
    }
    const targetId =
      path === '/members/invite' ? text(requestPayload.accountId, 100) : actor;
    let payload: Record<string, unknown> = {...requestPayload};
    if (path === '/members/invite') {
      const a = host.account(targetId);
      requireThat(
        a.status !== 'disabled',
        'ACCOUNT_DISABLED',
        '停用账号不能加入比赛。',
      );
      payload = {accountId: a.id, kind: a.kind, name: a.name};
    }
    const action = memberControlActions[path]!;
    host.db.tx(() => {
      host.insertOperation(
        id,
        session.account_id,
        `control:${action}`,
        matchEntry.id,
        bodyHash,
        {...payload, controlActor: actor},
        reason,
      );
      if (action === 'invite') {
        host.db.exec(
          'INSERT OR IGNORE INTO account_match_index VALUES(?,?)',
          targetId,
          matchEntry.id,
        );
      }
    });
    await host.arm();
    return {status: 202, body: {operationId: id, status: 'pending'}};
  }
  requireThat(indexed, 'MATCH_FORBIDDEN', '当前账号没有本场访问权限。', 403);
  if (erasureFloor(host, matchEntry.id) > 0) {
    throw new Fault(
      410,
      'REPLAY_EXPIRED',
      '完整复盘已到期，请从本场历史页面查看保留的战报。',
    );
  }
  requireThat(
    matchEntry.state === 'available' ||
      matchEntry.state === 'archived' ||
      matchEntry.state === 'archiving' ||
      matchEntry.state === 'purge_pending',
    'MATCH_NOT_AVAILABLE',
    '本场尚未发布或只保留档案。',
    409,
  );
  const account = host.account(session.account_id);
  const grant: MatchGrant = {
    accountId: account.id,
    authEpoch: account.auth_epoch,
    matchId: matchEntry.id,
    csrf: session.csrf,
    expires: host.now() + 30000,
    audience: account.kind,
  };
  const matchInput = {...input, path: `${path}${url.search}`};
  const reply = await environment.MATCH_DO.getByName(
    matchEntry.object_name,
  ).authorized(
    matchInput,
    grant,
    await controlSignature(environment, stableJson({input: matchInput, grant})),
  );
  host.login(session.token_hash);
  if (input.method === 'GET' && erasureFloor(host, matchEntry.id) > 0) {
    throw new Fault(
      410,
      'REPLAY_EXPIRED',
      '完整复盘已到期，请从本场历史页面查看保留的战报。',
    );
  }
  return {...reply, body: parseJson(reply.body)};
}

/** 按成员、主办方职责和保留期开放战报与受限下载，已清理资料不可回退读取。 */
async function matchHistory(
  host: DarkForestPlatform,
  session: Login,
  matchEntry: Directory,
  path: string,
  url: URL,
): Promise<RpcReply> {
  const staffScope = () => host.dataScope(session.account_id, matchEntry.id);
  const download = /^\/history\/download\/(report|replay|audit|backup)$/.exec(
    path,
  );
  const kind = (download?.[1] ??
    path.slice('/history/'.length)) as MatchDownload;
  requireThat(
    path === '/history' || download || kind === 'report' || kind === 'replay',
    'NOT_FOUND',
    '没有这项赛后资料。',
    404,
  );
  if (download) {
    host.admin(session, ['owner', 'archivist']);
    requireThat(
      staffScope(),
      'ARCHIVE_SCOPE_REQUIRED',
      '当前账号不能下载本场资料。',
      403,
    );
  }
  const indexed = host.db.one<Record<string, SqlStorageValue>>(
    'SELECT account_id FROM account_match_index WHERE account_id=? AND match_id=?',
    session.account_id,
    matchEntry.id,
  );
  requireThat(
    indexed || staffScope(),
    'FORBIDDEN',
    '当前账号不能查看本场历史。',
    403,
  );
  const current = await host.summary(matchEntry, session.account_id);
  const localReader =
    (current.participants as string[]).includes(session.account_id) ||
    (current.members as MatchMember[]).some(
      m =>
        m.account_id === session.account_id &&
        m.state === 'bound' &&
        m.local_id === 'J01',
    );
  const authorize = () => {
    host.login(session.token_hash);
    if (download) {
      host.admin(session, ['owner', 'archivist']);
    } else if (!localReader) {
      host.admin(session, ['owner', 'archivist']);
    }
    requireThat(
      download ? staffScope() : localReader || staffScope(),
      'FORBIDDEN',
      '当前账号不能查看这项赛后资料。',
      403,
    );
  };
  authorize();
  const available = (full: boolean) => {
    const held = host.db.one<Record<string, SqlStorageValue>>(
      'SELECT match_id FROM retention_holds WHERE match_id=?',
      matchEntry.id,
    );
    const days = full ? matchEntry.retention_days : matchEntry.audit_days;
    return (
      current.phase === 'ended' &&
      !current.recovering &&
      (!full ||
        (erasureFloor(host, matchEntry.id) === 0 &&
          current.erasureGeneration === 0)) &&
      (!!held || host.now() < Number(current.endedUtc) + days * 86400000)
    );
  };
  const record = (level: string, version?: number) =>
    host.control(
      matchEntry,
      crypto.randomUUID(),
      'history-record',
      session.account_id,
      '读取本场赛后资料',
      {
        kind: level,
        organizer: staffScope(),
        ...(version === undefined ? {} : {version}),
      },
    );
  if (path === '/history') {
    const versions = available(false)
      ? ((await record('versions')).versions as MatchHistory['versions'])
      : [];
    authorize();
    const replayAvailable = available(true) && versions.length > 0;
    const downloads: MatchDownload[] =
      staffScope() && available(false)
        ? [...(versions.length ? ['report' as const] : []), 'audit']
        : [];
    if (staffScope() && replayAvailable) {
      downloads.push('replay', 'backup');
    }
    return {
      status: 200,
      body: {
        phase: String(current.phase),
        versions: available(false) ? versions : [],
        replayAvailable,
        downloads,
      } satisfies MatchHistory,
    };
  }
  const full = kind === 'replay' || kind === 'backup';
  requireThat(
    current.phase === 'ended',
    'ENDED_REQUIRED',
    '比赛结束后可以查看赛后资料。',
  );
  requireThat(
    !current.recovering,
    'RECOVERY_LOCKED',
    '比赛正在恢复，请稍后再查看资料。',
  );
  requireThat(
    available(full),
    'HISTORY_EXPIRED',
    '这项赛后资料已超过保留期。',
    410,
  );
  host.limit(`history:${session.account_id}`, 20);
  const rawVersion = url.searchParams.get('version');
  const version =
    rawVersion !== null && kind === 'report'
      ? integer(Number(rawVersion), 1)
      : undefined;
  const data = await record(kind, version);
  authorize();
  requireThat(
    available(full),
    'HISTORY_EXPIRED',
    '这项赛后资料已停止提供。',
    410,
  );
  if (!download) {
    return {status: 200, body: data};
  }
  host.audit(
    session.account_id,
    'history-download',
    matchEntry.id,
    '下载本场赛后资料',
    {
      kind,
      version,
    },
  );
  if (kind === 'backup') {
    requireThat(
      typeof data.fileName === 'string' && typeof data.text === 'string',
      'HISTORY_UNAVAILABLE',
      '暂时无法生成加密备份，请稍后重试。',
      503,
    );
    return {status: 200, body: {fileName: data.fileName, text: data.text}};
  }
  const labels = {report: '战报', replay: '完整复盘', audit: '裁判操作记录'};
  const reportVersion =
    kind === 'report'
      ? `-第${(data.report as {version: number}).version}版`
      : '';
  return {
    status: 200,
    body: {
      fileName: `${matchEntry.id}-${labels[kind]}${reportVersion}.json`,
      text: JSON.stringify(data, null, 2),
    },
  };
}
