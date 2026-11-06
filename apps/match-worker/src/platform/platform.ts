import {DurableObject} from 'cloudflare:workers';
import {
  ContractError,
  integer,
  object,
  parseJson,
  requestId,
  scalarText,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import type {
  MatchEntry,
  MatchMember,
  PlatformAccount,
  PlatformRole,
  PlatformSession,
} from '../../../../packages/contracts/src/platform';
import type {BackendEnv, RpcInput, RpcReply} from '../rpc/types';
import {decrypt, digest, encrypt, token} from '../security/crypto';
import {Fault, requireThat, type Store} from '../storage/store';
import {changeAccount, createAccount, importAccounts} from './accounts';
import {previewDetails, readPlatform} from './directory';
import {bootstrap, maintenance} from './maintenance';
import type {ControlRequest} from './match_control';
import {matchRequest} from './matches';
import {alarm} from './operation_queue';
import {assertVersion, operationView, protectOwner} from './policy';
import {erasureFloor} from './retention';
import {platformStore} from './schema';
import {base32, controlSignature, platformKey, verifyTotp} from './security';
import type {Account, Directory, Login, Operation} from './types';
import {DATA_ACTIONS} from './types';
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

  /** 验证第二因素时间步或一次性恢复码，并原子标记消费以阻止重放。 */
  private async factor(account: Account, raw: unknown): Promise<boolean> {
    if (!account.totp_ciphertext) {
      return false;
    }
    const code = typeof raw === 'string' ? raw : '';
    const secret = await decrypt(
      await platformKey(this.env),
      account.totp_ciphertext,
      `totp|${account.id}`,
    );
    const step = await verifyTotp(
      secret,
      code,
      account.last_totp_step,
      this.now(),
    );
    if (step >= 0) {
      return this.db.tx(() => {
        const current = this.account(account.id);
        requireThat(
          current.last_totp_step < step,
          'TOTP_REPLAY',
          '验证码已使用，请等待下一枚。',
          401,
        );
        this.db.exec(
          'UPDATE platform_accounts SET last_totp_step=? WHERE id=?',
          step,
          account.id,
        );
        return true;
      });
    }
    const hash = await digest(code);
    const r = this.db.one<Record<string, SqlStorageValue>>(
      'SELECT hash FROM recovery_codes WHERE account_id=? AND hash=? AND used=0',
      account.id,
      hash,
    );
    if (r) {
      this.db.exec('UPDATE recovery_codes SET used=1 WHERE hash=?', hash);
      return true;
    }
    return false;
  }

  /** 处理长期口令、领取和退出请求，凭据明文仅经专用交付返回。 */
  private async authenticate(input: RpcInput): Promise<RpcReply | null> {
    const {path, method} = input;
    if (path === '/auth/exchange' && method === 'POST') {
      this.limit(`login:${input.clientKey}`, 30);
      const payload = object(input.body);
      const hash = await digest(text(payload.credential, 128, 32));
      const kind =
        payload.audience === 'player'
          ? 'player'
          : payload.audience === 'staff' || payload.audience === 'judge'
            ? 'staff'
            : '';
      requireThat(kind, 'BAD_AUDIENCE', '登录入口不正确。', 400);
      const account = this.db.one<Account>(
        "SELECT * FROM platform_accounts WHERE credential_hash=? AND kind=? AND status='active'",
        hash,
        kind,
      );
      requireThat(account, 'INVALID_CREDENTIAL', '登录口令无效。', 401);
      const factor = await this.factor(account, payload.code);
      requireThat(
        !account.totp_ciphertext || factor,
        'SECOND_FACTOR_REQUIRED',
        '请输入第二因素验证码或一次性恢复码。',
        401,
      );
      const raw = token();
      const tokenHash = await digest(raw);
      const csrf = token();
      this.db.tx(() => {
        requireThat(
          this.account(account.id).auth_epoch === account.auth_epoch,
          'AUTH_CHANGED',
          '凭据已更新。',
          401,
        );
        this.db.exec(
          'INSERT INTO platform_sessions VALUES(?,?,?,?,?,?,?,?,0)',
          tokenHash,
          account.id,
          account.auth_epoch,
          csrf,
          this.now(),
          this.now() + 43200000,
          0, // Retain the unused reauth_utc column for existing platform databases.
          factor ? 1 : 0,
        );
      });
      return {
        status: 200,
        body: this.view(this.login(tokenHash)),
        sessionToken: raw,
      };
    }
    if (path === '/auth/claim' && method === 'POST') {
      this.limit(`claim:${input.clientKey}`, 20);
      const requestPayload = object(input.body);
      const hash = await digest(text(requestPayload.invitation, 100, 32));
      const invite = this.db.one<{
        id: string;
        account_id: string;
        claimed: number;
        expires: number;
      }>('SELECT * FROM invitations WHERE token_hash=?', hash);
      requireThat(
        invite && !invite.claimed && invite.expires > this.now(),
        'INVITATION_EXPIRED',
        '邀请已失效，请联系管理员重新发送。',
        401,
      );
      const credential = token();
      const credentialHash = await digest(credential);
      this.db.tx(() => {
        requireThat(
          this.db.one<{claimed: number}>(
            'SELECT claimed FROM invitations WHERE id=?',
            invite.id,
          )?.claimed === 0,
          'INVITATION_USED',
          '邀请已被领取。',
          409,
        );
        requireThat(
          this.account(invite.account_id).status !== 'disabled',
          'ACCOUNT_DISABLED',
          '账号已停用。',
          403,
        );
        this.db.exec(
          'UPDATE invitations SET claimed=1,ciphertext=NULL WHERE id=?',
          invite.id,
        );
        this.db.exec(
          "UPDATE platform_accounts SET credential_hash=?,status='active',version=version+1,auth_epoch=auth_epoch+1 WHERE id=?",
          credentialHash,
          invite.account_id,
        );
        this.db.exec(
          'UPDATE platform_sessions SET revoked=1 WHERE account_id=?',
          invite.account_id,
        );
        this.audit(
          invite.account_id,
          'claim',
          invite.account_id,
          '领取长期账号',
        );
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
    return null;
  }

  /** 在有效会话与职责校验后分派平台API，跨场变更由持久操作队列驱动。 */
  private async handle(input: RpcInput): Promise<RpcReply> {
    const auth = await this.authenticate(input);
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
    if (path === '/auth/session') {
      return {status: 200, body: this.view(session)};
    }
    if (path === '/auth/logout') {
      requireThat(input.method === 'POST', 'METHOD', '请提交退出请求。', 405);
      this.db.exec(
        'UPDATE platform_sessions SET revoked=1 WHERE token_hash=?',
        hash,
      );
      return {status: 200, body: {loggedOut: true}, clearCookie: true};
    }
    if (path === '/auth/reauth' && input.method === 'POST') {
      const targetAccount = this.account(session.account_id);
      this.limit(`reauth:${targetAccount.id}`, 10);
      requireThat(
        (await digest(text(requestPayload.credential, 128, 32))) ===
          targetAccount.credential_hash,
        'INVALID_CREDENTIAL',
        '口令无效。',
        401,
      );
      const factor = await this.factor(targetAccount, requestPayload.code);
      requireThat(
        !targetAccount.totp_ciphertext || factor,
        'SECOND_FACTOR_REQUIRED',
        '验证码无效或已使用。',
        401,
      );
      this.db.exec(
        'UPDATE platform_sessions SET second_factor=? WHERE token_hash=?',
        factor ? 1 : 0,
        hash,
      );
      return {status: 200, body: this.view(this.login(hash))};
    }
    if (path === '/me/security/disable' && input.method === 'POST') {
      requireThat(
        session.second_factor === 1,
        'SECOND_FACTOR_REQUIRED',
        '请先使用验证码或恢复码验证第二因素。',
        403,
      );
      this.db.tx(() => {
        this.db.exec(
          'UPDATE platform_accounts SET totp_ciphertext=NULL,last_totp_step=-1 WHERE id=?',
          session.account_id,
        );
        this.db.exec(
          'DELETE FROM recovery_codes WHERE account_id=?',
          session.account_id,
        );
        this.db.exec('DELETE FROM platform_meta WHERE key=?', `totp:${hash}`);
        this.db.exec(
          'UPDATE platform_sessions SET second_factor=0 WHERE account_id=?',
          session.account_id,
        );
        this.audit(
          session.account_id,
          'second_factor_disabled',
          session.account_id,
          '本人关闭第二因素验证',
        );
      });
      return {status: 200, body: this.view(this.login(hash))};
    }
    if (path === '/me/security/setup' && input.method === 'POST') {
      requireThat(
        !this.account(session.account_id).totp_ciphertext,
        'ALREADY_CONFIGURED',
        '请使用现有第二因素或受控找回。',
      );
      const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
      const cipher = await encrypt(
        await platformKey(this.env),
        secret,
        `pending-totp|${hash}`,
      );
      this.db.exec(
        'INSERT OR REPLACE INTO platform_meta VALUES(?,?)',
        `totp:${hash}`,
        JSON.stringify({cipher, expires: this.now() + 600000}),
      );
      return {
        status: 200,
        body: {
          secret,
          uri: `otpauth://totp/DarkForest:${session.account_id}?secret=${secret}&issuer=DarkForest`,
        },
      };
    }
    if (path === '/me/security/confirm' && input.method === 'POST') {
      this.limit(`factor:${session.account_id}`, 10);
      const row = this.db.one<{value: string}>(
        'SELECT value FROM platform_meta WHERE key=?',
        `totp:${hash}`,
      );
      requireThat(row, 'SETUP_REQUIRED', '请先设置第二因素。');
      const pending = parseJson(row.value) as {
        cipher: string;
        expires: number;
      };
      requireThat(
        pending.expires > this.now(),
        'SETUP_EXPIRED',
        '设置已过期，请重新开始。',
      );
      const secret = await decrypt(
        await platformKey(this.env),
        pending.cipher,
        `pending-totp|${hash}`,
      );
      const step = await verifyTotp(
        secret,
        String(requestPayload.code),
        -1,
        this.now(),
      );
      requireThat(step >= 0, 'INVALID_CODE', '验证码不正确。', 401);
      const cipher = await encrypt(
        await platformKey(this.env),
        secret,
        `totp|${session.account_id}`,
      );
      const codes = Array.from({length: 8}, () => token());
      const hashes = await Promise.all(codes.map(digest));
      this.db.tx(() => {
        requireThat(
          !this.account(session.account_id).totp_ciphertext,
          'ALREADY_CONFIGURED',
          '第二因素已设置。',
        );
        this.db.exec(
          'UPDATE platform_accounts SET totp_ciphertext=?,last_totp_step=? WHERE id=?',
          cipher,
          step,
          session.account_id,
        );
        this.db.exec(
          'UPDATE platform_sessions SET second_factor=1 WHERE token_hash=?',
          hash,
        );
        this.db.exec(
          'UPDATE platform_sessions SET revoked=1 WHERE account_id=? AND token_hash!=?',
          session.account_id,
          hash,
        );
        this.db.exec('DELETE FROM platform_meta WHERE key=?', `totp:${hash}`);
        for (const h of hashes) {
          this.db.exec(
            'INSERT INTO recovery_codes VALUES(?,?,0)',
            session.account_id,
            h,
          );
        }
      });
      return {status: 200, body: {recoveryCodes: codes}};
    }
    if (path === '/me/sessions' && input.method === 'GET') {
      return {
        status: 200,
        body: this.db.all<{
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
      this.db.exec(
        'UPDATE platform_sessions SET revoked=1 WHERE account_id=?',
        session.account_id,
      );
      return {status: 200, body: {revoked: true}, clearCookie: true};
    }
    if (path === '/me' && input.method === 'GET') {
      return {status: 200, body: this.view(session)};
    }
    const personalOperation =
      /^\/me\/operations\/([A-Za-z0-9_-]+)(\/resolve)?$/.exec(path);
    if (personalOperation) {
      const id = personalOperation[1]!;
      const old = this.db.one<Operation>(
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
        return {status: 200, body: this.operationView(old)};
      }
      if (input.method === 'POST' && personalOperation[2]) {
        this.db.tx(() => {
          if (
            !this.db.one<Record<string, SqlStorageValue>>(
              'SELECT id FROM platform_operations WHERE id=?',
              id,
            )
          ) {
            this.insertOperation(
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
    if (path === '/me/matches' && input.method === 'GET') {
      const entries = this.db.all<Omit<MatchEntry, 'membership'>>(
        'SELECT d.id,d.name,d.kind,d.state,d.version,d.created_utc,d.summary,d.synced_utc,d.recommended,d.retention_days,d.audit_days FROM match_directory d JOIN account_match_index i ON i.match_id=d.id WHERE i.account_id=? ORDER BY d.created_utc DESC LIMIT 200',
        session.account_id,
      );
      return {
        status: 200,
        body: (
          await Promise.all(
            entries.map(async entry => {
              if (
                ['provisioning', 'purged', 'imported_archive'].includes(
                  entry.state,
                )
              ) {
                return entry;
              }
              const current = await this.summary(
                this.directory(entry.id),
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
    if (path.startsWith('/matches/')) {
      return this.matchRequest(input, session);
    }
    this.admin(session, ['owner', 'admin', 'archivist']);
    if (input.method === 'GET') {
      return this.readPlatform(path, input, session);
    }
    if (path === '/platform/preview') {
      this.admin(session, ['owner', 'admin', 'archivist']);
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
        this.admin(session, ['owner', 'archivist']);
        if (payload.matchId) {
          requireThat(
            this.dataScope(session.account_id, scalarText(payload.matchId)),
            'ARCHIVE_SCOPE_REQUIRED',
            '当前账号未获本场数据管理权限。',
            403,
          );
        }
      } else {
        this.admin(session, ['owner', 'admin']);
      }
      const preview = await this.previewDetails(target, payload, session);
      this.db.exec(
        'INSERT INTO platform_previews VALUES(?,?,?,?,?)',
        id,
        session.account_id,
        target,
        bodyHash,
        this.now() + 300000,
      );
      return {
        status: 200,
        body: {previewToken: id, expiresUtc: this.now() + 300000, ...preview},
      };
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
    this.admin(
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
    const prior = this.db.one<Operation>(
      'SELECT * FROM platform_operations WHERE id=?',
      id,
    );
    if (prior) {
      requireThat(
        prior.actor === session.account_id && prior.body_hash === bodyHash,
        'OPERATION_CONFLICT',
        '操作编号已用于不同内容。',
      );
      return {status: 200, body: this.operationView(prior)};
    }
    if (sensitive) {
      const preview = this.db.one<{body_hash: string}>(
        'SELECT body_hash FROM platform_previews WHERE id=? AND actor=? AND path=? AND expires>?',
        String(requestPayload.preview_token),
        session.account_id,
        path,
        this.now(),
      );
      requireThat(
        preview && preview.body_hash === (await digest(stableJson(body))),
        'PREVIEW_REQUIRED',
        '请重新预览当前场次、账号与影响。',
      );
    }
    if (path === '/platform/accounts/create') {
      return this.createAccount(session, id, requestPayload, bodyHash, reason);
    }
    if (path === '/platform/accounts/import') {
      return this.importAccounts(session, id, requestPayload, bodyHash, reason);
    }
    if (path === '/platform/matches/create') {
      const kind = requestPayload.kind;
      requireThat(
        kind === 'official' || kind === 'trial',
        'BAD_KIND',
        '请选择正式或试玩。',
        400,
      );
      const matchId = crypto.randomUUID();
      const name = text(requestPayload.name, 100);
      const retention = integer(
        requestPayload.retentionDays ?? (kind === 'trial' ? 14 : 44),
        1,
        3650,
      );
      const auditDays = integer(
        requestPayload.auditDays ?? 365,
        retention,
        3650,
      );
      requireThat(
        requestPayload.retentionConfirmed === true,
        'RETENTION_CONFIRM',
        '请确认向参与者告知的数据保留期限。',
        400,
      );
      let description =
        typeof requestPayload.description === 'string'
          ? text(requestPayload.description, 2000, 0)
          : '';
      let template: Record<string, unknown> | undefined;
      if (requestPayload.copyFrom) {
        const source = this.directory(text(requestPayload.copyFrom, 100));
        requireThat(
          source.state !== 'imported_archive',
          'SOURCE_READONLY',
          '导入档案不能作为活动比赛模板。',
        );
        template = await this.control(
          source,
          crypto.randomUUID(),
          'template',
          session.account_id,
          '复制已核对的活动设置白名单',
          {},
        );
        description = scalarText(template.description ?? description);
      }
      this.db.tx(() => {
        this.db.exec(
          'INSERT INTO match_directory(id,name,kind,state,object_name,created_utc,retention_days,audit_days,config) VALUES(?,?,?,?,?,?,?,?,?)',
          matchId,
          name,
          kind,
          'provisioning',
          `match:${matchId}`,
          this.now(),
          retention,
          auditDays,
          JSON.stringify({description, rulesetVersion: '1', keyVersion: 2}),
        );
        this.insertOperation(
          id,
          session.account_id,
          'create',
          matchId,
          bodyHash,
          {name, kind, description, ...(template ? {template} : {})},
          reason,
        );
      });
      await this.arm();
      return {status: 202, body: {operationId: id, matchId, status: 'pending'}};
    }
    if (path.startsWith('/platform/accounts/')) {
      return this.changeAccount(
        session,
        id,
        path,
        requestPayload,
        bodyHash,
        reason,
      );
    }
    if (path === '/platform/roles/update') {
      const account = this.account(text(requestPayload.accountId, 100));
      requireThat(
        account.kind === 'staff' && account.status === 'active',
        'ACTIVE_STAFF_REQUIRED',
        '请选择已激活工作人员。',
      );
      requireThat(
        ['owner', 'admin', 'archivist'].includes(String(requestPayload.role)),
        'BAD_ROLE',
        '角色无效。',
        400,
      );
      const grantMatch =
        requestPayload.role === 'archivist' && requestPayload.enabled !== false
          ? this.directory(text(requestPayload.matchId, 100))
          : null;
      this.db.tx(() => {
        this.assertVersion(account, requestPayload.expected_version);
        if (
          requestPayload.enabled === false &&
          requestPayload.role === 'owner'
        ) {
          this.protectOwner(account.id);
        }
        if (requestPayload.enabled === false) {
          this.db.exec(
            'DELETE FROM platform_roles WHERE account_id=? AND role=?',
            account.id,
            requestPayload.role as string,
          );
        } else {
          this.db.exec(
            'INSERT OR IGNORE INTO platform_roles VALUES(?,?)',
            account.id,
            requestPayload.role as string,
          );
        }
        if (grantMatch) {
          this.db.exec(
            'INSERT OR REPLACE INTO archive_grants VALUES(?,?,?)',
            account.id,
            grantMatch.id,
            integer(
              requestPayload.expiresUtc ?? this.now() + 30 * 86400000,
              this.now() + 60000,
            ),
          );
        }
        if (
          requestPayload.enabled === false &&
          requestPayload.role === 'archivist'
        ) {
          this.db.exec(
            'DELETE FROM archive_grants WHERE account_id=?',
            account.id,
          );
        }
        this.db.exec(
          'UPDATE platform_accounts SET version=version+1 WHERE id=?',
          account.id,
        );
        this.insertOperation(
          id,
          session.account_id,
          'roles',
          account.id,
          bodyHash,
          {},
          reason,
          'succeeded',
        );
      });
      return {status: 200, body: {operationId: id, status: 'succeeded'}};
    }
    if (path === '/platform/matches/recommend') {
      const matchEntry = this.directory(text(requestPayload.matchId, 100));
      this.assertVersion(matchEntry, requestPayload.expected_version);
      this.db.tx(() => {
        this.db.exec('UPDATE match_directory SET recommended=0');
        this.db.exec(
          'UPDATE match_directory SET recommended=1,version=version+1 WHERE id=?',
          matchEntry.id,
        );
        this.insertOperation(
          id,
          session.account_id,
          'recommend',
          matchEntry.id,
          bodyHash,
          {},
          reason,
          'succeeded',
        );
      });
      return {status: 200, body: {status: 'succeeded', operationId: id}};
    }
    if (path === '/platform/operations/retry') {
      const operation = this.db.one<Operation>(
        'SELECT * FROM platform_operations WHERE id=?',
        text(requestPayload.operationId, 100),
      );
      requireThat(
        operation && ['partial', 'failed'].includes(operation.status),
        'NOT_RETRYABLE',
        '任务没有可重试步骤。',
      );
      this.db.tx(() => {
        this.db.exec(
          "UPDATE platform_operations SET status='pending',next_attempt=0,attempts=0,error='' WHERE id=?",
          operation.id,
        );
        this.insertOperation(
          id,
          session.account_id,
          'retry',
          operation.id,
          bodyHash,
          {},
          reason,
          'succeeded',
        );
      });
      await this.arm();
      return {
        status: 202,
        body: {operationId: operation.id, status: 'pending'},
      };
    }
    if (path === '/platform/data/hold') {
      const directoryEntry = this.directory(text(requestPayload.matchId, 100));
      requireThat(
        this.dataScope(session.account_id, directoryEntry.id),
        'ARCHIVE_SCOPE_REQUIRED',
        '当前账号未获本场数据管理权限。',
        403,
      );
      this.assertVersion(directoryEntry, requestPayload.expected_version);
      this.db.tx(() => {
        if (requestPayload.release === true) {
          this.db.exec(
            'DELETE FROM retention_holds WHERE match_id=?',
            directoryEntry.id,
          );
        } else {
          this.db.exec(
            'INSERT OR REPLACE INTO retention_holds VALUES(?,?,?,?)',
            directoryEntry.id,
            reason,
            session.account_id,
            integer(requestPayload.reviewUtc, this.now() + 60000),
          );
        }
        this.db.exec(
          'UPDATE match_directory SET version=version+1 WHERE id=?',
          directoryEntry.id,
        );
        this.insertOperation(
          id,
          session.account_id,
          'hold',
          directoryEntry.id,
          bodyHash,
          {},
          reason,
          'succeeded',
        );
      });
      return {status: 200, body: {status: 'succeeded', operationId: id}};
    }
    if (path === '/platform/data/purge') {
      const d = this.directory(text(requestPayload.matchId, 100));
      requireThat(
        this.dataScope(session.account_id, d.id),
        'ARCHIVE_SCOPE_REQUIRED',
        '当前账号未获本场数据管理权限。',
        403,
      );
      this.assertVersion(d, requestPayload.expected_version);
      const summary = await this.summary(d, session.account_id);
      requireThat(
        summary.phase === 'ended',
        'ENDED_REQUIRED',
        '只有已完赛的比赛可以清理。',
      );
      requireThat(
        !summary.recovering,
        'RECOVERY_LOCKED',
        '请先完成比赛恢复再清理。',
      );
      const ended = Number(summary.endedUtc);
      requireThat(
        ended > 0 && this.now() >= ended + d.retention_days * 86400000,
        'RETENTION_ACTIVE',
        '完整复盘的保留期尚未结束。',
      );
      requireThat(
        summary.reportVersion,
        'REPORT_REQUIRED',
        '正式战报尚未生成，暂不能清理。',
      );
      this.db.tx(() => {
        this.assertVersion(
          this.directory(d.id),
          requestPayload.expected_version,
        );
        requireThat(
          d.state !== 'purge_pending' && erasureFloor(this, d.id) === 0,
          'CLEANUP_ALREADY_REQUESTED',
          '本场已经安排清理或已经清理。请查看管理待办。',
        );
        requireThat(
          !this.db.one<Record<string, SqlStorageValue>>(
            'SELECT match_id FROM retention_holds WHERE match_id=?',
            d.id,
          ),
          'RETENTION_HOLD',
          '本场资料因申诉暂缓清理。',
        );
        this.db.exec(
          "UPDATE match_directory SET state='purge_pending',version=version+1 WHERE id=?",
          d.id,
        );
        this.insertOperation(
          id,
          session.account_id,
          'purge',
          d.id,
          bodyHash,
          requestPayload,
          reason,
        );
        this.db.exec(
          'UPDATE platform_operations SET next_attempt=? WHERE id=?',
          this.now() + 7 * 86400000,
          id,
        );
      });
      await this.arm();
      return {status: 202, body: {operationId: id, status: 'pending'}};
    }
    if (path === '/platform/data/cancel-purge') {
      const pendingOperation = this.db.one<Operation>(
        "SELECT * FROM platform_operations WHERE id=? AND action='purge' AND status='pending'",
        text(requestPayload.operationId, 100),
      );
      requireThat(
        pendingOperation &&
          !this.db.one<Record<string, SqlStorageValue>>(
            'SELECT match_id FROM erasure_ledger WHERE match_id=? AND status!=?',
            pendingOperation.target,
            'cancelled',
          ),
        'CANNOT_CANCEL',
        '清理已进入不可撤销步骤。',
      );
      requireThat(
        this.dataScope(session.account_id, pendingOperation.target),
        'ARCHIVE_SCOPE_REQUIRED',
        '当前账号未获本场数据管理权限。',
        403,
      );
      this.db.tx(() => {
        this.db.exec(
          "UPDATE platform_operations SET status='cancelled' WHERE id=?",
          pendingOperation.id,
        );
        this.db.exec(
          "UPDATE match_directory SET state='available',version=version+1 WHERE id=?",
          pendingOperation.target,
        );
        this.insertOperation(
          id,
          session.account_id,
          'cancel-purge',
          pendingOperation.target,
          bodyHash,
          {},
          reason,
          'succeeded',
        );
      });
      return {status: 200, body: {status: 'cancelled'}};
    }
    throw new Fault(404, 'NOT_FOUND', '平台接口不存在。');
  }

  /** 调用统一的乐观版本校验，防止确认过时管理草稿。 */
  private assertVersion(row: {version: number}, version: unknown) {
    return assertVersion(this, row, version);
  }

  /** 确保敏感账号或角色变更后仍保留可访问的有效所有者。 */
  private protectOwner(id: string) {
    return protectOwner(this, id);
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

  /** 生成脱敏操作投影，隐藏内部负载并加入各目标收据。 */
  private operationView(op: Operation) {
    return operationView(this, op);
  }

  /** 分派按平台任职和资料范围授权的只读查询。 */
  private async readPlatform(
    path: string,
    input: RpcInput,
    s: Login,
  ): Promise<RpcReply> {
    return readPlatform(this, this.env, path, input, s);
  }

  /** 读取真实本场摘要生成平台管理预览，不直接执行草稿。 */
  private async previewDetails(
    path: string,
    p: Record<string, unknown>,
    s: Login,
  ): Promise<Record<string, unknown>> {
    return previewDetails(this, path, p, s);
  }

  /** 分派长期账号创建及一次性邀请交付，保留原操作幂等收据。 */
  private async createAccount(
    s: Login,
    id: string,
    p: Record<string, unknown>,
    hash: string,
    reason: string,
  ): Promise<RpcReply> {
    return createAccount(this, this.env, s, id, p, hash, reason);
  }

  /** 分派批量长期账号导入，保留逐行校验与处理结果。 */
  private async importAccounts(
    s: Login,
    id: string,
    p: Record<string, unknown>,
    hash: string,
    reason: string,
  ): Promise<RpcReply> {
    return importAccounts(this, s, id, p, hash, reason);
  }

  /** 分派带版本和所有者保护的账号及权限变更。 */
  private async changeAccount(
    s: Login,
    id: string,
    path: string,
    p: Record<string, unknown>,
    hash: string,
    reason: string,
  ): Promise<RpcReply> {
    return changeAccount(this, this.env, s, id, path, p, hash, reason);
  }

  /** 分派本场成员、岗位及发布请求，并安排持久队列执行。 */
  private async matchRequest(input: RpcInput, s: Login): Promise<RpcReply> {
    return matchRequest(this, this.env, input, s);
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
