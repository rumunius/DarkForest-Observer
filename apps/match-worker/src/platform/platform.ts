import {DurableObject} from 'cloudflare:workers';
import {
  ContractError,
  object,
  parseJson,
  stableJson,
} from '../../../../packages/contracts/src/backend';
import type {
  PlatformAccount,
  PlatformRole,
  PlatformSession,
} from '../../../../packages/contracts/src/platform';
import type {BackendEnv, RpcInput, RpcReply} from '../rpc/types';
import {digest} from '../security/crypto';
import {Fault, requireThat, type Store} from '../storage/store';
import {adminRequest} from './admin_requests';
import {publicAuthentication} from './authentication';
import {bootstrap, maintenance} from './maintenance';
import type {ControlRequest} from './match_control';
import {alarm} from './operation_queue';
import {personalRequest} from './personal_requests';
import type {AuthenticatedRequest} from './request_context';
import {platformStore} from './schema';
import {controlSignature} from './security';
import {sessionRequest} from './session_requests';
import type {Account, Directory, Login} from './types';

/** 跨比赛身份和目录的Durable Object；各场玩法状态仍由独立比赛对象持有。 */
export class DarkForestPlatform extends DurableObject<BackendEnv> {
  readonly db: Store;

  constructor(ctx: DurableObjectState, env: BackendEnv) {
    super(ctx, env);
    this.db = platformStore(ctx.storage);
  }

  /** 平台真实UTC来源；不与单场有效比赛时钟混用。 */
  now() {
    return Date.now();
  }

  /** 保存平台管理责任、原因和细节，原始凭据不进入普通审计。 */
  audit(
    actor: string,
    action: string,
    target: string,
    reason: string,
    detail: unknown = {},
  ) {
    this.db.exec(
      'INSERT INTO platform_audit VALUES(?,?,?,?,?,?,?)',
      crypto.randomUUID(),
      actor,
      action,
      target,
      reason,
      this.now(),
      JSON.stringify(detail),
    );
  }

  /** 限制平台入口请求频率，持久时间桶不依赖浏览器会话。 */
  limit(key: string, max: number, window = 60000) {
    const count = this.db.one<{count: number}>(
      'INSERT INTO platform_rate_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN bucket=excluded.bucket THEN count+1 ELSE 1 END,bucket=excluded.bucket RETURNING count',
      key,
      Math.floor(this.now() / window),
    )!.count;
    requireThat(
      count <= max,
      'RATE_LIMITED',
      '请求过于频繁，请稍后重试。',
      429,
    );
  }

  /** 读取长期账号，缺失时明确返回不可用错误。 */
  account(id: string): Account {
    const a = this.db.one<Account>(
      'SELECT * FROM platform_accounts WHERE id=?',
      id,
    );
    requireThat(a, 'NOT_FOUND', '账号不存在。', 404);
    return a;
  }

  /** 投影可公开账号字段，剥离凭据摘要和第二因素秘密。 */
  safeAccount(a: Account): PlatformAccount {
    return {
      id: a.id,
      kind: a.kind,
      name: a.name,
      status: a.status,
      auth_epoch: a.auth_epoch,
      version: a.version,
      tags: a.tags,
    };
  }

  /** 读取长期账号的当前平台任职，不推断单场裁判权限。 */
  roles(id: string): PlatformRole[] {
    return this.db
      .all<{role: PlatformRole}>(
        'SELECT role FROM platform_roles WHERE account_id=?',
        id,
      )
      .map(r => r.role);
  }

  /** 按所有者身份或未过期资料授权判断指定比赛的资料管理范围。 */
  dataScope(accountId: string, matchId: string) {
    return (
      this.roles(accountId).includes('owner') ||
      (this.roles(accountId).includes('archivist') &&
        !!this.db.one<Record<string, SqlStorageValue>>(
          'SELECT account_id FROM archive_grants WHERE account_id=? AND match_id=? AND expires>?',
          accountId,
          matchId,
          this.now(),
        ))
    );
  }

  /** 逐次核对会话UTC有效期、撤销状态和账号授权世代。 */
  login(hash: string): Login {
    const session = this.db.one<Login>(
      'SELECT * FROM platform_sessions WHERE token_hash=? AND revoked=0 AND expires>?',
      hash,
      this.now(),
    );
    requireThat(session, 'UNAUTHENTICATED', '请重新登录长期账号。', 401);
    const a = this.account(session.account_id);
    requireThat(
      a.status === 'active' && a.auth_epoch === session.auth_epoch,
      'UNAUTHENTICATED',
      '账号已停用或凭据已更新，请重新登录。',
      401,
    );
    return session;
  }

  /** 组合当前公开会话及平台任职，不返回会话存储摘要。 */
  view(s: Login): PlatformSession {
    return {
      account: this.safeAccount(this.account(s.account_id)),
      roles: this.roles(s.account_id),
      csrfToken: s.csrf,
      secondFactor: !!s.second_factor,
      secondFactorEnabled: !!this.account(s.account_id).totp_ciphertext,
    };
  }

  /** 要求当前有效平台会话及指定任职，单场裁判身份不能代替。 */
  admin(s: Login, roles: PlatformRole[] = ['owner', 'admin']) {
    this.login(s.token_hash);
    requireThat(
      this.roles(s.account_id).some(r => roles.includes(r)),
      'FORBIDDEN',
      '当前账号没有平台管理权限。',
      403,
    );
  }

  /** 读取本平台池中的比赛目录，未知ID不会自动创建比赛。 */
  directory(id: string): Directory {
    const matchEntry = this.db.one<Directory>(
      'SELECT * FROM match_directory WHERE id=?',
      id,
    );
    requireThat(
      matchEntry && matchEntry.pool_id === 'default',
      'MATCH_NOT_FOUND',
      '比赛不存在或当前不可用。',
      404,
    );
    return matchEntry;
  }

  /** 供持久任务复核长期账号有效性与本场索引关系。 */
  taskAllowed(accountId: string, matchId: string): boolean {
    const account = this.db.one<Account>(
      "SELECT * FROM platform_accounts WHERE id=? AND status='active'",
      accountId,
    );
    return (
      !!account &&
      !!this.db.one<Record<string, SqlStorageValue>>(
        'SELECT account_id FROM account_match_index WHERE account_id=? AND match_id=?',
        accountId,
        matchId,
      )
    );
  }

  /** 向指定比赛对象发送绑定操作和UTC期限的签名控制请求。 */
  async control(
    matchEntry: Directory,
    id: string,
    action: string,
    actor: string,
    reason: string,
    payload: Record<string, unknown>,
  ) {
    const request: ControlRequest = {
      id,
      matchId: matchEntry.id,
      action,
      actor,
      reason,
      payload,
      expires: this.now() + 30000,
    };
    const result = parseJson(
      await this.env.MATCH_DO.getByName(matchEntry.object_name).control(
        request,
        await controlSignature(this.env, stableJson(request)),
      ),
    ) as Record<string, unknown>;
    if (result.controlError) {
      throw new Fault(
        Number(result.status),
        String(result.code),
        String(result.message),
      );
    }
    return result;
  }

  /** 读取本场权威摘要并更新目录缓存，目录不能成为第二权威状态源。 */
  async summary(matchEntry: Directory, actor: string) {
    const summary = await this.control(
      matchEntry,
      crypto.randomUUID(),
      'summary',
      actor,
      '读取本场最新管理状态',
      {},
    );
    this.db.exec(
      'UPDATE match_directory SET summary=?,synced_utc=? WHERE id=?',
      JSON.stringify({
        phase: summary.phase,
        revision: summary.revision,
        paused: summary.paused,
        endedUtc: summary.endedUtc,
        players: summary.players,
      }),
      this.now(),
      matchEntry.id,
    );
    return summary;
  }

  /** 固定RPC入口：调用独立维护认证的首次所有者安装流程。 */
  async bootstrap(secret: string, raw: unknown): Promise<string> {
    return bootstrap(this, this.env, secret, raw);
  }

  /** 固定RPC入口：分派独立认证的救援、旧场接入和恢复步骤。 */
  async maintenance(secret: string, raw: unknown): Promise<string> {
    return maintenance(this, this.env, this.ctx, secret, raw);
  }

  /** 固定RPC入口：执行平台请求、重排队列并转换不泄密的错误响应。 */
  async call(
    input: RpcInput,
  ): Promise<Omit<RpcReply, 'body'> & {body: string}> {
    try {
      const result = await this.handle(input);
      await this.arm();
      return {...result, body: JSON.stringify(result.body)};
    } catch (error) {
      if (error instanceof Fault) {
        return {
          status: error.status,
          body: JSON.stringify({
            code: error.code,
            message: error.message,
            definitive: true,
          }),
        };
      }
      if (error instanceof ContractError) {
        return {
          status: 400,
          body: JSON.stringify({
            code: 'BAD_REQUEST',
            message: error.message,
            definitive: true,
          }),
        };
      }
      return {
        status: 503,
        body: JSON.stringify({
          code: 'PLATFORM_UNAVAILABLE',
          message:
            '平台身份服务暂时不可用，页面暂不可操作，比赛时钟仍运行。请查询原操作结果。',
          definitive: false,
        }),
      };
    }
  }

  /** 在有效会话与职责校验后分派平台API，跨场变更由持久操作队列驱动。 */
  private async handle(input: RpcInput): Promise<RpcReply> {
    const auth = await publicAuthentication(this, this.env, input);
    if (auth) {
      return auth;
    }
    const hash = input.token ? await digest(input.token) : '';
    if (input.path === '/auth/session' && !hash) {
      return {status: 200, body: null};
    }
    const session = this.login(hash);
    const path = new URL(input.path, 'https://internal').pathname;
    this.limit(`account:${session.account_id}`, 300);
    if (input.method === 'POST') {
      requireThat(
        input.csrf === session.csrf,
        'CSRF_REJECTED',
        '请刷新页面后重试。',
        403,
      );
    }
    const requestPayload = input.method === 'POST' ? object(input.body) : {};
    const request: AuthenticatedRequest = {
      input,
      path,
      session,
      hash,
      requestPayload,
    };
    const sessionReply = sessionRequest(this, this.env, request);
    if (sessionReply) {
      return sessionReply;
    }
    const personalReply = personalRequest(this, this.env, request);
    if (personalReply) {
      return personalReply;
    }
    return adminRequest(this, this.env, request);
  }

  /** 持久记录操作身份和正文摘要，跨对象执行随后逐项保存收据。 */
  insertOperation(
    id: string,
    actor: string,
    action: string,
    target: string,
    hash: string,
    payload: unknown,
    reason: string,
    status = 'pending',
  ) {
    if (actor !== 'root-maintainer') {
      const account = this.account(actor);
      requireThat(
        account.status === 'active',
        'AUTHOR_DISABLED',
        '操作账号已停用，请重新登录。',
        403,
      );
      if (
        !action.startsWith('control:') &&
        !['roles', 'cancel-unreceived'].includes(action)
      ) {
        requireThat(
          this.roles(actor).some(role =>
            ['owner', 'admin', 'archivist'].includes(role),
          ),
          'AUTHOR_REVOKED',
          '平台任职已变化，请重新登录后核对。',
          403,
        );
      }
    }
    this.db.exec(
      'INSERT INTO platform_operations(id,actor,action,target,body_hash,payload,status,created_utc) VALUES(?,?,?,?,?,?,?,?)',
      id,
      actor,
      action,
      target,
      hash,
      JSON.stringify(payload),
      status,
      this.now(),
    );
    this.audit(actor, action, target, reason, {operationId: id});
  }

  /** 根据持久队列下一次可执行UTC重排Alarm，不改变原操作身份。 */
  async arm() {
    const next = this.db.one<{due: number}>(
      "SELECT MIN(next_attempt) AS due FROM platform_operations WHERE status IN ('pending','partial') AND attempts<8 AND action!='adopt-legacy'",
    );
    const delivery = this.db.one<{due: number}>(
      'SELECT MIN(delivery_expires) AS due FROM invitations WHERE ciphertext IS NOT NULL',
    )?.due;
    const due = Math.min(next?.due ?? Infinity, delivery ?? Infinity);
    if (Number.isFinite(due)) {
      const wanted = Math.max(this.now() + 100, due);
      const scheduled = await this.ctx.storage.getAlarm();
      if (scheduled === null || scheduled > wanted) {
        await this.ctx.storage.setAlarm(wanted);
      }
    }
  }

  /** Cloudflare固定入口：执行可到期的平台队列工作并保留失败重试证据。 */
  async alarm() {
    return alarm(this);
  }
}
