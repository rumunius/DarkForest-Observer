import { DurableObject } from 'cloudflare:workers';
import type { BackendEnv, MatchGrant, RpcInput, RpcReply } from '../rpc/types';
import { Fault, requireThat, type Store } from '../storage/store';
import { platformStore } from './schema';
import { decrypt, digest, encrypt, token } from '../security/crypto';
import { base32, controlSignature, platformKey, verifyTotp } from './security';
import {
  ContractError,
  integer,
  object,
  requestId,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import type {
  MatchEntry,
  MatchHistory,
  MatchDownload,
  MatchMember,
  PlatformAccount,
  PlatformRole,
  PlatformSession,
} from '../../../../packages/contracts/src/platform';
import type { ControlRequest } from './match-control';
import { erasureOperation, erasureFloor } from './retention';

type Account = PlatformAccount & {
  credential_hash: string | null;
  totp_ciphertext: string | null;
  last_totp_step: number;
  created_utc: number;
} & Record<string, SqlStorageValue>;
type Login = {
  token_hash: string;
  account_id: string;
  auth_epoch: number;
  csrf: string;
  created_utc: number;
  expires: number;
  reauth_utc: number;
  second_factor: number;
  revoked: number;
};
type Directory = MatchEntry & { pool_id: string; object_name: string; config: string } & Record<
    string,
    SqlStorageValue
  >;
type Operation = {
  id: string;
  actor: string;
  action: string;
  target: string;
  body_hash: string;
  payload: string;
  status: string;
  created_utc: number;
  attempts: number;
  next_attempt: number;
  error: string;
  result: string;
};
const DATA_ACTIONS = ['/platform/data/hold', '/platform/data/purge', '/platform/data/cancel-purge'];
export class DarkForestPlatform extends DurableObject<BackendEnv> {
  db: Store;
  constructor(ctx: DurableObjectState, env: BackendEnv) {
    super(ctx, env);
    this.db = platformStore(ctx.storage);
  }
  now() {
    return Date.now();
  }
  audit(actor: string, action: string, target: string, reason: string, detail: unknown = {}) {
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
  limit(key: string, max: number, window = 60000) {
    const count = this.db.one<{ count: number }>(
      'INSERT INTO platform_rate_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN bucket=excluded.bucket THEN count+1 ELSE 1 END,bucket=excluded.bucket RETURNING count',
      key,
      Math.floor(this.now() / window),
    )!.count;
    requireThat(count <= max, 'RATE_LIMITED', '请求过于频繁，请稍后重试。', 429);
  }
  account(id: string): Account {
    const a = this.db.one<Account>('SELECT * FROM platform_accounts WHERE id=?', id);
    requireThat(a, 'NOT_FOUND', '账号不存在。', 404);
    return a;
  }
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
  roles(id: string): PlatformRole[] {
    return this.db
      .all<{ role: PlatformRole }>('SELECT role FROM platform_roles WHERE account_id=?', id)
      .map((r) => r.role);
  }
  dataScope(accountId: string, matchId: string) {
    return (
      this.roles(accountId).includes('owner') ||
      (this.roles(accountId).includes('archivist') &&
        !!this.db.one(
          'SELECT account_id FROM archive_grants WHERE account_id=? AND match_id=? AND expires>?',
          accountId,
          matchId,
          this.now(),
        ))
    );
  }
  login(hash: string): Login {
    const s = this.db.one<Login>(
      'SELECT * FROM platform_sessions WHERE token_hash=? AND revoked=0 AND expires>?',
      hash,
      this.now(),
    );
    requireThat(s, 'UNAUTHENTICATED', '请重新登录长期账号。', 401);
    const a = this.account(s.account_id);
    requireThat(
      a.status === 'active' && a.auth_epoch === s.auth_epoch,
      'UNAUTHENTICATED',
      '账号已停用或凭据已更新，请重新登录。',
      401,
    );
    return s;
  }
  view(s: Login): PlatformSession {
    return {
      account: this.safeAccount(this.account(s.account_id)),
      roles: this.roles(s.account_id),
      csrfToken: s.csrf,
      recent: s.reauth_utc > this.now() - 600000,
      secondFactor: !!s.second_factor,
      secondFactorEnabled: !!this.account(s.account_id).totp_ciphertext,
    };
  }
  admin(s: Login, roles: PlatformRole[] = ['owner', 'admin'], recent = false) {
    this.login(s.token_hash);
    requireThat(
      this.roles(s.account_id).some((r) => roles.includes(r)),
      'FORBIDDEN',
      '当前账号没有平台管理权限。',
      403,
    );
    if (recent)
      requireThat(
        s.reauth_utc > this.now() - 600000,
        'REAUTH_REQUIRED',
        '请先在账号安全页重新认证。',
        403,
      );
  }
  directory(id: string): Directory {
    const d = this.db.one<Directory>('SELECT * FROM match_directory WHERE id=?', id);
    requireThat(d && d.pool_id === 'default', 'MATCH_NOT_FOUND', '比赛不存在或当前不可用。', 404);
    return d;
  }
  async taskAllowed(accountId: string, matchId: string): Promise<boolean> {
    const a = this.db.one<Account>(
      "SELECT * FROM platform_accounts WHERE id=? AND status='active'",
      accountId,
    );
    return (
      !!a &&
      !!this.db.one(
        'SELECT account_id FROM account_match_index WHERE account_id=? AND match_id=?',
        accountId,
        matchId,
      )
    );
  }
  async control(
    d: Directory,
    id: string,
    action: string,
    actor: string,
    reason: string,
    payload: Record<string, unknown>,
  ) {
    const request: ControlRequest = {
      id,
      matchId: d.id,
      action,
      actor,
      reason,
      payload,
      expires: this.now() + 30000,
    };
    const result = JSON.parse(
      await this.env.MATCH_DO.getByName(d.object_name).control(
        request,
        await controlSignature(this.env, stableJson(request)),
      ),
    ) as Record<string, unknown>;
    if (result.controlError)
      throw new Fault(Number(result.status), String(result.code), String(result.message));
    return result;
  }
  async summary(d: Directory, actor: string) {
    const summary = await this.control(
      d,
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
      d.id,
    );
    return summary;
  }
  async bootstrap(secret: string, raw: unknown): Promise<string> {
    const expected =
      this.env.PLATFORM_BOOTSTRAP_SECRET ??
      (this.env.APP_ENV === 'local' ? this.env.BOOTSTRAP_SECRET : undefined);
    requireThat(
      expected && (await digest(secret)) === (await digest(expected)),
      'FORBIDDEN',
      '安装授权无效。',
      403,
    );
    const p = object(raw),
      name = text(p.name, 100);
    const id = crypto.randomUUID(),
      invitation = token(),
      invitationId = crypto.randomUUID();
    const ciphertext = await encrypt(
        await platformKey(this.env),
        invitation,
        `invitation|${invitationId}`,
      ),
      invitationHash = await digest(invitation);
    this.db.tx(() => {
      requireThat(
        !this.db.one("SELECT key FROM platform_meta WHERE key='installed'"),
        'ALREADY_INSTALLED',
        '平台已安装；所有者失联请使用独立救援流程。',
      );
      this.db.exec(
        "INSERT INTO platform_accounts(id,kind,name,status,created_utc) VALUES(?,'staff',?,'pending',?)",
        id,
        name,
        this.now(),
      );
      this.db.exec("INSERT INTO platform_roles VALUES(?,'owner')", id);
      this.db.exec(
        'INSERT INTO invitations VALUES(?,?,?,?,0,?,?,?)',
        invitationId,
        id,
        invitationHash,
        this.now() + 7 * 86400000,
        ciphertext,
        this.now() + 86400000,
        'installer',
      );
      this.db.exec("INSERT INTO platform_meta VALUES('installed','1')");
      this.audit('installer', 'install', id, '首次建立平台所有者');
    });
    return JSON.stringify({
      accountId: id,
      invitationId,
      invitation,
      expiresUtc: this.now() + 7 * 86400000,
      environment: this.env.APP_ENV,
    });
  }
  async maintenance(secret: string, raw: unknown): Promise<string> {
    requireThat(
      this.env.PLATFORM_BOOTSTRAP_SECRET &&
        (await digest(secret)) === (await digest(this.env.PLATFORM_BOOTSTRAP_SECRET)),
      'FORBIDDEN',
      '独立维护凭据无效。',
      403,
    );
    const p = object(raw),
      operation = text(p.operation, 100);
    if (operation === 'release-check') {
      const matches = this.db.all<Directory>(
        "SELECT * FROM match_directory WHERE kind='official' AND state IN ('available','archiving','archived','purge_pending') LIMIT 51",
      );
      requireThat(
        matches.length <= 50,
        'RELEASE_CHECK_LIMIT',
        '正式比赛数量超过本次检查范围，请分批完成维护核对后再发布。',
      );
      const checked = [];
      for (const d of matches) {
        const state = await this.summary(d, 'root-maintainer');
        checked.push({ id: d.id, name: d.name, kind: d.kind, summary: { phase: state.phase } });
      }
      return JSON.stringify({ environment: this.env.APP_ENV, matches: checked });
    }
    if (operation === 'diagnostics')
      return JSON.stringify({
        environment: this.env.APP_ENV,
        version: this.env.CF_VERSION_METADATA?.id ?? 'local',
        platformSchema: 1,
        matchSchema: 8,
        matches: this.db.all('SELECT id,name,kind,state,object_name,summary FROM match_directory'),
        operations: this.db.all(
          "SELECT id,action,target,status,error FROM platform_operations WHERE status!='succeeded'",
        ),
        bindingFingerprint: await digest(
          `${this.env.APP_ENV}|${this.ctx.id.toString()}|${this.env.MATCH_DO.idFromName('match:binding-probe').toString()}`,
        ),
      });
    const id = requestId(p.operationId),
      reason = text(p.reason, 500),
      hash = await digest(stableJson(p));
    if (operation === 'rescue-owner') {
      const old = this.db.one<{ value: string }>(
        'SELECT value FROM platform_meta WHERE key=?',
        `rescue:${id}`,
      );
      if (old) {
        const stored = JSON.parse(old.value) as {
          hash: string;
          invitationId: string;
          accountId: string;
        };
        requireThat(stored.hash === hash, 'OPERATION_CONFLICT', '救援编号已用于不同内容。');
        return JSON.stringify(stored);
      }
      requireThat(
        p.confirm === '恢复平台所有者访问',
        'CONFIRM_REQUIRED',
        '请输入“恢复平台所有者访问”。',
      );
      const accountId = crypto.randomUUID(),
        invite = token(),
        inviteId = crypto.randomUUID(),
        inviteHash = await digest(invite),
        cipher = await encrypt(await platformKey(this.env), invite, `invitation|${inviteId}`);
      this.db.tx(() => {
        this.db.exec('UPDATE platform_sessions SET revoked=1');
        this.db.exec("DELETE FROM platform_roles WHERE role='owner'");
        this.db.exec(
          "INSERT INTO platform_accounts(id,kind,name,status,created_utc) VALUES(?,'staff',?,'pending',?)",
          accountId,
          text(p.name, 100),
          this.now(),
        );
        this.db.exec("INSERT INTO platform_roles VALUES(?,'owner')", accountId);
        this.db.exec(
          'INSERT INTO invitations VALUES(?,?,?,?,0,?,?,?)',
          inviteId,
          accountId,
          inviteHash,
          this.now() + 86400000,
          cipher,
          this.now() + 86400000,
          'root-rescue',
        );
        this.db.exec(
          'INSERT INTO platform_meta VALUES(?,?)',
          `rescue:${id}`,
          JSON.stringify({ hash, invitationId: inviteId, accountId }),
        );
        this.audit('root-maintainer', 'owner-rescue', accountId, reason, { operationId: id });
      });
      return JSON.stringify({ accountId, invitationId: inviteId, invitation: invite });
    }
    if (operation === 'rescue-delivery') {
      const row = this.db.one<{ ciphertext: string; delivery_expires: number }>(
        "SELECT ciphertext,delivery_expires FROM invitations WHERE id=? AND issuer='root-rescue'",
        text(p.invitationId, 100),
      );
      requireThat(
        row?.ciphertext && row.delivery_expires > this.now(),
        'DELIVERY_EXPIRED',
        '救援材料已过期，请建立新的救援任务。',
      );
      return JSON.stringify({
        invitation: await decrypt(
          await platformKey(this.env),
          row.ciphertext,
          `invitation|${p.invitationId}`,
        ),
      });
    }
    if (operation === 'inspect-legacy') {
      const matchId = text(p.matchId, 100);
      requireThat(/^[A-Za-z0-9_-]+$/.test(matchId), 'BAD_MATCH_ID', '旧比赛编号格式不正确。', 400);
      const inventory = JSON.parse(
        await this.env.MATCH_DO.getByName(`match:${matchId}`).legacyInventory(
          matchId,
          await controlSignature(this.env, stableJson({ action: 'legacy-inventory', matchId })),
        ),
      );
      this.db.exec(
        'INSERT OR REPLACE INTO platform_meta VALUES(?,?)',
        `legacy:${id}`,
        JSON.stringify(inventory),
      );
      return JSON.stringify(inventory);
    }
    if (operation === 'adopt-legacy') {
      const matchId = text(p.matchId, 100),
        existing = this.db.one<Operation>('SELECT * FROM platform_operations WHERE id=?', id);
      if (existing?.status === 'succeeded') {
        requireThat(existing.body_hash === hash, 'OPERATION_CONFLICT', '迁移编号对应不同内容。');
        return JSON.stringify({ matchId, receipt: JSON.parse(existing.result) });
      }
      const row = this.db.one<{ value: string }>(
        'SELECT value FROM platform_meta WHERE key=?',
        `legacy:${id}`,
      );
      requireThat(row, 'INSPECTION_REQUIRED', '请先检查旧比赛并保存加密检查点。');
      const inventory = JSON.parse(row.value) as {
        id: string;
        revision: number;
        accounts: { id: string; role: string; name: string; credential_hash: string }[];
        checkpoint: unknown;
      };
      requireThat(
        inventory.id === matchId &&
          p.checkpointDigest === (await digest(stableJson(inventory.checkpoint))),
        'BACKUP_RECEIPT_REQUIRED',
        '请保存检查点、回读校验后再登记旧比赛。',
      );
      requireThat(
        p.confirm === `接入旧比赛 ${matchId}`,
        'CONFIRM_REQUIRED',
        `请输入“接入旧比赛 ${matchId}”。`,
      );
      let op = existing;
      if (!op) {
        const mappings = inventory.accounts.map((a) => ({ ...a, accountId: crypto.randomUUID() }));
        this.db.tx(() => {
          requireThat(
            !this.db.one('SELECT id FROM match_directory WHERE id=?', matchId),
            'MATCH_EXISTS',
            '该场次已登记，禁止重建。',
          );
          this.db.exec(
            "INSERT INTO match_directory(id,name,kind,state,object_name,created_utc,retention_days,audit_days,config) VALUES(?,?,'official','provisioning',?,?,44,365,'{}')",
            matchId,
            text(p.name, 100),
            `match:${matchId}`,
            this.now(),
          );
          for (const a of mappings) {
            this.db.exec(
              "INSERT INTO platform_accounts(id,kind,name,status,created_utc) VALUES(?,?,?,'pending',?)",
              a.accountId,
              a.role === 'judge' ? 'staff' : 'player',
              a.name,
              this.now(),
            );
            this.db.exec(
              'INSERT INTO invitations VALUES(?,?,?,?,0,NULL,?,?)',
              crypto.randomUUID(),
              a.accountId,
              a.credential_hash,
              this.now() + 7 * 86400000,
              this.now(),
              'legacy-migration',
            );
            this.db.exec('INSERT INTO account_match_index VALUES(?,?)', a.accountId, matchId);
          }
          this.insertOperation(
            id,
            'root-maintainer',
            'adopt-legacy',
            matchId,
            hash,
            { mappings, expectedRevision: inventory.revision },
            reason,
          );
        });
        op = this.db.one<Operation>('SELECT * FROM platform_operations WHERE id=?', id)!;
      }
      requireThat(op.body_hash === hash, 'OPERATION_CONFLICT', '迁移编号对应不同内容。');
      const saved = JSON.parse(op.payload) as {
        mappings: { id: string; accountId: string }[];
        expectedRevision: number;
      };
      const d = this.directory(matchId),
        receipt = await this.control(d, `${id}:adopt`, 'adopt-legacy', 'root-maintainer', reason, {
          kind: 'official',
          expectedRevision: saved.expectedRevision,
          accounts: saved.mappings.map((a) => ({ localId: a.id, accountId: a.accountId })),
        });
      this.db.tx(() => {
        this.db.exec(
          "UPDATE match_directory SET state='available',version=version+1 WHERE id=?",
          matchId,
        );
        this.db.exec(
          "UPDATE platform_operations SET status='succeeded',result=?,payload='{}' WHERE id=?",
          JSON.stringify(receipt),
          id,
        );
        this.db.exec('DELETE FROM platform_meta WHERE key=?', `legacy:${id}`);
      });
      return JSON.stringify({
        matchId,
        receipt,
        message:
          '原对象、码本和比赛记录已保留；旧口令仅可在领取页面兑换一次长期口令，7天后失效。未知旧日志人员保持未确认。',
      });
    }
    const d = this.directory(text(p.matchId, 100));
    if (operation === 'carry-receipt') {
      const carry = object(p.carry),
        savedDigest = text(p.sha256, 100);
      requireThat(
        savedDigest === (await digest(stableJson(carry))),
        'CARRY_MISMATCH',
        '本地回读材料的摘要不匹配。',
      );
      this.db.exec(
        'INSERT OR REPLACE INTO platform_meta VALUES(?,?)',
        `carry:${d.id}:${id}`,
        JSON.stringify({ digest: savedDigest, carryId: carry.id }),
      );
      this.audit('root-maintainer', 'carry-saved', d.id, reason, { operationId: id });
      return JSON.stringify({ saved: true });
    }
    if (operation === 'recovery') {
      requireThat(this.env.BOOTSTRAP_SECRET, 'RECOVERY_NOT_CONFIGURED', '比赛恢复凭据未配置。');
      const payload = object(p.payload),
        action = text(payload.operation, 100);
      if (action === 'prepare' || action === 'launch') {
        requireThat(
          erasureFloor(this, d.id) === 0,
          'RESTORE_EXPIRED',
          '本场完整信息已清理，旧检查点不能重新开放比赛；请查看保留的正式战报。',
          410,
        );
      }
      if (action === 'launch') {
        const receipt = this.db.one<{ value: string }>(
          'SELECT value FROM platform_meta WHERE key=?',
          `carry:${d.id}:${id}`,
        );
        requireThat(
          receipt &&
            JSON.parse(receipt.value).digest === (await digest(stableJson(payload.payload))),
          'CARRY_RECEIPT_REQUIRED',
          '必须保存并回读校验carry材料，再登记收据后执行恢复。',
        );
        requireThat(
          p.confirm === `恢复比赛 ${d.id}`,
          'CONFIRM_REQUIRED',
          `请输入“恢复比赛 ${d.id}”。`,
        );
      }
      const signature = await controlSignature(
        this.env,
        stableJson({ matchId: d.id, raw: payload }),
      );
      if (action === 'launch')
        requireThat(
          erasureFloor(this, d.id) === 0,
          'RESTORE_EXPIRED',
          '本场资料已清理，不能恢复旧检查点。',
          410,
        );
      const reply = await this.env.MATCH_DO.getByName(d.object_name).recovery(
        this.env.BOOTSTRAP_SECRET,
        payload,
        signature,
      );
      requireThat(
        reply.status < 400,
        'RECOVERY_FAILED',
        (JSON.parse(reply.body) as { message?: string }).message ?? '比赛恢复未完成。',
      );
      if (action === 'complete') {
        // The platform timeline never rolls back with a match. Reapply its current security facts.
        for (const row of this.db.all<{ account_id: string }>(
          'SELECT account_id FROM account_match_index WHERE match_id=?',
          d.id,
        )) {
          const a = this.account(row.account_id);
          await this.control(
            d,
            `${id}:security:${a.id}:${a.auth_epoch}`,
            'fence',
            'root-maintainer',
            '恢复后应用最新平台撤销',
            { accountId: a.id, authEpoch: a.auth_epoch, disabled: a.status !== 'active' },
          );
        }
        const generation = erasureFloor(this, d.id);
        if (generation > 0)
          await this.control(
            d,
            `${id}:erase:${generation}`,
            'erase',
            'root-maintainer',
            '恢复后应用独立清理账本',
            { generation },
          );
      }
      this.audit('root-maintainer', `recovery:${action}`, d.id, reason, { operationId: id });
      return reply.body;
    }
    throw new Fault(
      400,
      'UNSUPPORTED_MAINTENANCE',
      '此操作需要兼容性检查与基础设施工具，当前向导不会伪装执行。',
    );
  }
  async call(input: RpcInput): Promise<Omit<RpcReply, 'body'> & { body: string }> {
    try {
      const result = await this.handle(input);
      await this.arm();
      return { ...result, body: JSON.stringify(result.body) };
    } catch (error) {
      if (error instanceof Fault)
        return {
          status: error.status,
          body: JSON.stringify({ code: error.code, message: error.message, definitive: true }),
        };
      if (error instanceof ContractError)
        return {
          status: 400,
          body: JSON.stringify({ code: 'BAD_REQUEST', message: error.message, definitive: true }),
        };
      return {
        status: 503,
        body: JSON.stringify({
          code: 'PLATFORM_UNAVAILABLE',
          message: '平台身份服务暂时不可用，页面暂不可操作，比赛时钟仍运行。请查询原操作结果。',
          definitive: false,
        }),
      };
    }
  }
  private async factor(a: Account, raw: unknown): Promise<boolean> {
    if (!a.totp_ciphertext) return false;
    const code = typeof raw === 'string' ? raw : '';
    const secret = await decrypt(await platformKey(this.env), a.totp_ciphertext, `totp|${a.id}`);
    const step = await verifyTotp(secret, code, a.last_totp_step, this.now());
    if (step >= 0)
      return this.db.tx(() => {
        const current = this.account(a.id);
        requireThat(
          current.last_totp_step < step,
          'TOTP_REPLAY',
          '验证码已使用，请等待下一枚。',
          401,
        );
        this.db.exec('UPDATE platform_accounts SET last_totp_step=? WHERE id=?', step, a.id);
        return true;
      });
    const hash = await digest(code);
    const r = this.db.one(
      'SELECT hash FROM recovery_codes WHERE account_id=? AND hash=? AND used=0',
      a.id,
      hash,
    );
    if (r) {
      this.db.exec('UPDATE recovery_codes SET used=1 WHERE hash=?', hash);
      return true;
    }
    return false;
  }
  private async authenticate(input: RpcInput): Promise<RpcReply | null> {
    const { path, method } = input;
    if (path === '/auth/exchange' && method === 'POST') {
      this.limit(`login:${input.clientKey}`, 30);
      const p = object(input.body),
        hash = await digest(text(p.credential, 128, 32));
      const kind =
        p.audience === 'player'
          ? 'player'
          : p.audience === 'staff' || p.audience === 'judge'
            ? 'staff'
            : '';
      requireThat(kind, 'BAD_AUDIENCE', '登录入口不正确。', 400);
      const a = this.db.one<Account>(
        "SELECT * FROM platform_accounts WHERE credential_hash=? AND kind=? AND status='active'",
        hash,
        kind,
      );
      requireThat(a, 'INVALID_CREDENTIAL', '登录口令无效。', 401);
      const factor = await this.factor(a, p.code);
      requireThat(
        !a.totp_ciphertext || factor,
        'SECOND_FACTOR_REQUIRED',
        '请输入第二因素验证码或一次性恢复码。',
        401,
      );
      const raw = token(),
        tokenHash = await digest(raw),
        csrf = token();
      this.db.tx(() => {
        requireThat(
          this.account(a.id).auth_epoch === a.auth_epoch,
          'AUTH_CHANGED',
          '凭据已更新。',
          401,
        );
        this.db.exec(
          'INSERT INTO platform_sessions VALUES(?,?,?,?,?,?,?,?,0)',
          tokenHash,
          a.id,
          a.auth_epoch,
          csrf,
          this.now(),
          this.now() + 43200000,
          this.now(),
          factor ? 1 : 0,
        );
      });
      return { status: 200, body: this.view(this.login(tokenHash)), sessionToken: raw };
    }
    if (path === '/auth/claim' && method === 'POST') {
      this.limit(`claim:${input.clientKey}`, 20);
      const p = object(input.body),
        hash = await digest(text(p.invitation, 100, 32));
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
      const credential = token(),
        credentialHash = await digest(credential);
      this.db.tx(() => {
        requireThat(
          this.db.one<{ claimed: number }>('SELECT claimed FROM invitations WHERE id=?', invite.id)
            ?.claimed === 0,
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
        this.db.exec('UPDATE invitations SET claimed=1,ciphertext=NULL WHERE id=?', invite.id);
        this.db.exec(
          "UPDATE platform_accounts SET credential_hash=?,status='active',version=version+1,auth_epoch=auth_epoch+1 WHERE id=?",
          credentialHash,
          invite.account_id,
        );
        this.db.exec(
          'UPDATE platform_sessions SET revoked=1 WHERE account_id=?',
          invite.account_id,
        );
        this.audit(invite.account_id, 'claim', invite.account_id, '领取长期账号');
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
  private async handle(input: RpcInput): Promise<RpcReply> {
    const auth = await this.authenticate(input);
    if (auth) return auth;
    const hash = input.token ? await digest(input.token) : '';
    if (input.path === '/auth/session' && !hash) return { status: 200, body: null };
    const s = this.login(hash),
      path = new URL(input.path, 'https://internal').pathname;
    this.limit(`account:${s.account_id}`, 300);
    if (input.method === 'POST')
      requireThat(input.csrf === s.csrf, 'CSRF_REJECTED', '请刷新页面后重试。', 403);
    const p = input.method === 'POST' ? object(input.body) : {};
    if (path === '/auth/session') return { status: 200, body: this.view(s) };
    if (path === '/auth/logout') {
      requireThat(input.method === 'POST', 'METHOD', '请提交退出请求。', 405);
      this.db.exec('UPDATE platform_sessions SET revoked=1 WHERE token_hash=?', hash);
      return { status: 200, body: { loggedOut: true }, clearCookie: true };
    }
    if (path === '/auth/reauth' && input.method === 'POST') {
      const a = this.account(s.account_id);
      this.limit(`reauth:${a.id}`, 10);
      requireThat(
        (await digest(text(p.credential, 128, 32))) === a.credential_hash,
        'INVALID_CREDENTIAL',
        '口令无效。',
        401,
      );
      const factor = await this.factor(a, p.code);
      requireThat(
        !a.totp_ciphertext || factor,
        'SECOND_FACTOR_REQUIRED',
        '验证码无效或已使用。',
        401,
      );
      this.db.exec(
        'UPDATE platform_sessions SET reauth_utc=?,second_factor=? WHERE token_hash=?',
        this.now(),
        factor ? 1 : 0,
        hash,
      );
      return { status: 200, body: this.view(this.login(hash)) };
    }
    if (path === '/me/security/disable' && input.method === 'POST') {
      requireThat(s.reauth_utc > this.now() - 600000, 'REAUTH_REQUIRED', '请先重新认证。', 403);
      requireThat(
        s.second_factor === 1,
        'SECOND_FACTOR_REQUIRED',
        '请先使用验证码或恢复码重新认证。',
        403,
      );
      this.db.tx(() => {
        this.db.exec(
          'UPDATE platform_accounts SET totp_ciphertext=NULL,last_totp_step=-1 WHERE id=?',
          s.account_id,
        );
        this.db.exec('DELETE FROM recovery_codes WHERE account_id=?', s.account_id);
        this.db.exec('DELETE FROM platform_meta WHERE key=?', `totp:${hash}`);
        this.db.exec(
          'UPDATE platform_sessions SET second_factor=0 WHERE account_id=?',
          s.account_id,
        );
        this.audit(s.account_id, 'second_factor_disabled', s.account_id, '本人关闭第二因素验证');
      });
      return { status: 200, body: this.view(this.login(hash)) };
    }
    if (path === '/me/security/setup' && input.method === 'POST') {
      requireThat(s.reauth_utc > this.now() - 600000, 'REAUTH_REQUIRED', '请先重新认证。', 403);
      requireThat(
        !this.account(s.account_id).totp_ciphertext,
        'ALREADY_CONFIGURED',
        '请使用现有第二因素或受控找回。',
      );
      const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
      const cipher = await encrypt(await platformKey(this.env), secret, `pending-totp|${hash}`);
      this.db.exec(
        'INSERT OR REPLACE INTO platform_meta VALUES(?,?)',
        `totp:${hash}`,
        JSON.stringify({ cipher, expires: this.now() + 600000 }),
      );
      return {
        status: 200,
        body: {
          secret,
          uri: `otpauth://totp/DarkForest:${s.account_id}?secret=${secret}&issuer=DarkForest`,
        },
      };
    }
    if (path === '/me/security/confirm' && input.method === 'POST') {
      this.limit(`factor:${s.account_id}`, 10);
      const row = this.db.one<{ value: string }>(
        'SELECT value FROM platform_meta WHERE key=?',
        `totp:${hash}`,
      );
      requireThat(row, 'SETUP_REQUIRED', '请先设置第二因素。');
      const pending = JSON.parse(row.value) as { cipher: string; expires: number };
      requireThat(pending.expires > this.now(), 'SETUP_EXPIRED', '设置已过期，请重新开始。');
      const secret = await decrypt(
        await platformKey(this.env),
        pending.cipher,
        `pending-totp|${hash}`,
      );
      const step = await verifyTotp(secret, String(p.code), -1, this.now());
      requireThat(step >= 0, 'INVALID_CODE', '验证码不正确。', 401);
      const cipher = await encrypt(await platformKey(this.env), secret, `totp|${s.account_id}`),
        codes = Array.from({ length: 8 }, () => token()),
        hashes = await Promise.all(codes.map(digest));
      this.db.tx(() => {
        requireThat(
          !this.account(s.account_id).totp_ciphertext,
          'ALREADY_CONFIGURED',
          '第二因素已设置。',
        );
        this.db.exec(
          'UPDATE platform_accounts SET totp_ciphertext=?,last_totp_step=? WHERE id=?',
          cipher,
          step,
          s.account_id,
        );
        this.db.exec('UPDATE platform_sessions SET second_factor=1 WHERE token_hash=?', hash);
        this.db.exec(
          'UPDATE platform_sessions SET revoked=1 WHERE account_id=? AND token_hash!=?',
          s.account_id,
          hash,
        );
        this.db.exec('DELETE FROM platform_meta WHERE key=?', `totp:${hash}`);
        for (const h of hashes)
          this.db.exec('INSERT INTO recovery_codes VALUES(?,?,0)', s.account_id, h);
      });
      return { status: 200, body: { recoveryCodes: codes } };
    }
    if (path === '/me/sessions' && input.method === 'GET')
      return {
        status: 200,
        body: this.db.all<{ created_utc: number; expires: number; revoked: number }>(
          'SELECT created_utc,expires,revoked FROM platform_sessions WHERE account_id=? ORDER BY created_utc DESC LIMIT 100',
          s.account_id,
        ),
      };
    if (path === '/me/sessions/revoke' && input.method === 'POST') {
      this.db.exec('UPDATE platform_sessions SET revoked=1 WHERE account_id=?', s.account_id);
      return { status: 200, body: { revoked: true }, clearCookie: true };
    }
    if (path === '/me' && input.method === 'GET') return { status: 200, body: this.view(s) };
    const personalOperation = /^\/me\/operations\/([A-Za-z0-9_-]+)(\/resolve)?$/.exec(path);
    if (personalOperation) {
      const id = personalOperation[1]!,
        old = this.db.one<Operation>('SELECT * FROM platform_operations WHERE id=?', id);
      if (old) {
        requireThat(old.actor === s.account_id, 'NOT_FOUND', '操作不存在。', 404);
        return { status: 200, body: this.operationView(old) };
      }
      if (input.method === 'POST' && personalOperation[2]) {
        this.db.tx(() => {
          if (!this.db.one('SELECT id FROM platform_operations WHERE id=?', id))
            this.insertOperation(
              id,
              s.account_id,
              'cancel-unreceived',
              s.account_id,
              'cancelled',
              {},
              '确认未接收操作，阻止迟到请求',
              'cancelled',
            );
        });
        return { status: 200, body: { id, status: 'cancelled' } };
      }
      return {
        status: 200,
        body: { id, status: 'unknown', message: '尚未取得提交收据，可确认未接收并阻止迟到请求。' },
      };
    }
    if (path === '/me/matches' && input.method === 'GET') {
      const entries = this.db.all<MatchEntry & Record<string, SqlStorageValue>>(
        'SELECT d.id,d.name,d.kind,d.state,d.version,d.created_utc,d.summary,d.synced_utc,d.recommended,d.retention_days,d.audit_days FROM match_directory d JOIN account_match_index i ON i.match_id=d.id WHERE i.account_id=? ORDER BY d.created_utc DESC LIMIT 200',
        s.account_id,
      );
      return {
        status: 200,
        body: await Promise.all(
          entries.map(async (entry) => {
            if (['provisioning', 'purged', 'imported_archive'].includes(entry.state)) return entry;
            const current = await this.summary(this.directory(entry.id), s.account_id);
            return {
              ...entry,
              phase: current.phase,
              membership: (current.members as MatchMember[]).find(
                (member) => member.account_id === s.account_id,
              ),
            };
          }),
        ),
      };
    }
    if (path.startsWith('/matches/')) return this.matchRequest(input, s);
    this.admin(s, ['owner', 'admin', 'archivist']);
    if (input.method === 'GET') return this.readPlatform(path, input, s);
    if (path === '/platform/preview') {
      this.admin(s, ['owner', 'admin', 'archivist'], true);
      const target = text(p.path, 200),
        payload = object(p.payload),
        id = token(),
        bodyHash = await digest(stableJson(payload));
      if (target.startsWith('/platform/data/')) {
        requireThat(DATA_ACTIONS.includes(target), 'NOT_FOUND', '该操作已不再提供。', 404);
        this.admin(s, ['owner', 'archivist'], true);
        if (payload.matchId)
          requireThat(
            this.dataScope(s.account_id, String(payload.matchId)),
            'ARCHIVE_SCOPE_REQUIRED',
            '当前账号未获本场数据管理权限。',
            403,
          );
      } else this.admin(s, ['owner', 'admin'], true);
      const preview = await this.previewDetails(target, payload, s);
      this.db.exec(
        'INSERT INTO platform_previews VALUES(?,?,?,?,?)',
        id,
        s.account_id,
        target,
        bodyHash,
        this.now() + 300000,
      );
      return {
        status: 200,
        body: { previewToken: id, expiresUtc: this.now() + 300000, ...preview },
      };
    }
    if (path.startsWith('/platform/data/'))
      requireThat(DATA_ACTIONS.includes(path), 'NOT_FOUND', '该操作已不再提供。', 404);
    const sensitive = ![
      '/platform/accounts/create',
      '/platform/accounts/import',
      '/platform/matches/create',
    ].includes(path);
    this.admin(
      s,
      path.startsWith('/platform/data/')
        ? ['owner', 'archivist']
        : path.startsWith('/platform/roles')
          ? ['owner']
          : ['owner', 'admin'],
      sensitive,
    );
    const id = requestId(p.request_id),
      reason = text(p.reason, 500),
      body = { ...p };
    delete body.preview_token;
    delete body.request_id;
    const bodyHash = await digest(stableJson({ path, body }));
    const prior = this.db.one<Operation>('SELECT * FROM platform_operations WHERE id=?', id);
    if (prior) {
      requireThat(
        prior.actor === s.account_id && prior.body_hash === bodyHash,
        'OPERATION_CONFLICT',
        '操作编号已用于不同内容。',
      );
      return { status: 200, body: this.operationView(prior) };
    }
    if (sensitive) {
      const preview = this.db.one<{ body_hash: string }>(
        'SELECT body_hash FROM platform_previews WHERE id=? AND actor=? AND path=? AND expires>?',
        String(p.preview_token),
        s.account_id,
        path,
        this.now(),
      );
      requireThat(
        preview && preview.body_hash === (await digest(stableJson(body))),
        'PREVIEW_REQUIRED',
        '请重新预览当前场次、账号与影响。',
      );
    }
    if (path === '/platform/accounts/create') return this.createAccount(s, id, p, bodyHash, reason);
    if (path === '/platform/accounts/import')
      return this.importAccounts(s, id, p, bodyHash, reason);
    if (path === '/platform/matches/create') {
      const kind = p.kind;
      requireThat(kind === 'official' || kind === 'trial', 'BAD_KIND', '请选择正式或试玩。', 400);
      const matchId = crypto.randomUUID(),
        name = text(p.name, 100),
        retention = integer(p.retentionDays ?? (kind === 'trial' ? 14 : 44), 1, 3650),
        auditDays = integer(p.auditDays ?? 365, retention, 3650);
      requireThat(
        p.retentionConfirmed === true,
        'RETENTION_CONFIRM',
        '请确认向参与者告知的数据保留期限。',
        400,
      );
      let description = typeof p.description === 'string' ? text(p.description, 2000, 0) : '';
      let template: Record<string, unknown> | undefined;
      if (p.copyFrom) {
        const source = this.directory(text(p.copyFrom, 100));
        requireThat(
          source.state !== 'imported_archive',
          'SOURCE_READONLY',
          '导入档案不能作为活动比赛模板。',
        );
        template = await this.control(
          source,
          crypto.randomUUID(),
          'template',
          s.account_id,
          '复制已核对的活动设置白名单',
          {},
        );
        description = String(template.description ?? description);
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
          JSON.stringify({ description, rulesetVersion: '1', keyVersion: 2 }),
        );
        this.insertOperation(
          id,
          s.account_id,
          'create',
          matchId,
          bodyHash,
          { name, kind, description, ...(template ? { template } : {}) },
          reason,
        );
      });
      await this.arm();
      return { status: 202, body: { operationId: id, matchId, status: 'pending' } };
    }
    if (path.startsWith('/platform/accounts/'))
      return this.changeAccount(s, id, path, p, bodyHash, reason);
    if (path === '/platform/roles/update') {
      const account = this.account(text(p.accountId, 100));
      requireThat(
        account.kind === 'staff' && account.status === 'active',
        'ACTIVE_STAFF_REQUIRED',
        '请选择已激活工作人员。',
      );
      requireThat(
        ['owner', 'admin', 'archivist'].includes(String(p.role)),
        'BAD_ROLE',
        '角色无效。',
        400,
      );
      const grantMatch =
        p.role === 'archivist' && p.enabled !== false ? this.directory(text(p.matchId, 100)) : null;
      this.db.tx(() => {
        this.assertVersion(account, p.expected_version);
        if (p.enabled === false && p.role === 'owner') this.protectOwner(account.id);
        if (p.enabled === false)
          this.db.exec(
            'DELETE FROM platform_roles WHERE account_id=? AND role=?',
            account.id,
            p.role as string,
          );
        else
          this.db.exec(
            'INSERT OR IGNORE INTO platform_roles VALUES(?,?)',
            account.id,
            p.role as string,
          );
        if (grantMatch)
          this.db.exec(
            'INSERT OR REPLACE INTO archive_grants VALUES(?,?,?)',
            account.id,
            grantMatch.id,
            integer(p.expiresUtc ?? this.now() + 30 * 86400000, this.now() + 60000),
          );
        if (p.enabled === false && p.role === 'archivist')
          this.db.exec('DELETE FROM archive_grants WHERE account_id=?', account.id);
        this.db.exec('UPDATE platform_accounts SET version=version+1 WHERE id=?', account.id);
        this.insertOperation(
          id,
          s.account_id,
          'roles',
          account.id,
          bodyHash,
          {},
          reason,
          'succeeded',
        );
      });
      return { status: 200, body: { operationId: id, status: 'succeeded' } };
    }
    if (path === '/platform/matches/recommend') {
      const d = this.directory(text(p.matchId, 100));
      this.assertVersion(d, p.expected_version);
      this.db.tx(() => {
        this.db.exec('UPDATE match_directory SET recommended=0');
        this.db.exec('UPDATE match_directory SET recommended=1,version=version+1 WHERE id=?', d.id);
        this.insertOperation(
          id,
          s.account_id,
          'recommend',
          d.id,
          bodyHash,
          {},
          reason,
          'succeeded',
        );
      });
      return { status: 200, body: { status: 'succeeded', operationId: id } };
    }
    if (path === '/platform/operations/retry') {
      const op = this.db.one<Operation>(
        'SELECT * FROM platform_operations WHERE id=?',
        text(p.operationId, 100),
      );
      requireThat(
        op && ['partial', 'failed'].includes(op.status),
        'NOT_RETRYABLE',
        '任务没有可重试步骤。',
      );
      this.db.tx(() => {
        this.db.exec(
          "UPDATE platform_operations SET status='pending',next_attempt=0,attempts=0,error='' WHERE id=?",
          op.id,
        );
        this.insertOperation(id, s.account_id, 'retry', op.id, bodyHash, {}, reason, 'succeeded');
      });
      await this.arm();
      return { status: 202, body: { operationId: op.id, status: 'pending' } };
    }
    if (path === '/platform/data/hold') {
      const d = this.directory(text(p.matchId, 100));
      requireThat(
        this.dataScope(s.account_id, d.id),
        'ARCHIVE_SCOPE_REQUIRED',
        '当前账号未获本场数据管理权限。',
        403,
      );
      this.assertVersion(d, p.expected_version);
      this.db.tx(() => {
        if (p.release === true) this.db.exec('DELETE FROM retention_holds WHERE match_id=?', d.id);
        else
          this.db.exec(
            'INSERT OR REPLACE INTO retention_holds VALUES(?,?,?,?)',
            d.id,
            reason,
            s.account_id,
            integer(p.reviewUtc, this.now() + 60000),
          );
        this.db.exec('UPDATE match_directory SET version=version+1 WHERE id=?', d.id);
        this.insertOperation(id, s.account_id, 'hold', d.id, bodyHash, {}, reason, 'succeeded');
      });
      return { status: 200, body: { status: 'succeeded', operationId: id } };
    }
    if (path === '/platform/data/purge') {
      const d = this.directory(text(p.matchId, 100));
      requireThat(
        this.dataScope(s.account_id, d.id),
        'ARCHIVE_SCOPE_REQUIRED',
        '当前账号未获本场数据管理权限。',
        403,
      );
      this.assertVersion(d, p.expected_version);
      const summary = await this.summary(d, s.account_id);
      requireThat(summary.phase === 'ended', 'ENDED_REQUIRED', '只有已完赛的比赛可以清理。');
      requireThat(!summary.recovering, 'RECOVERY_LOCKED', '请先完成比赛恢复再清理。');
      const ended = Number(summary.endedUtc);
      requireThat(
        ended > 0 && this.now() >= ended + d.retention_days * 86400000,
        'RETENTION_ACTIVE',
        '完整复盘的保留期尚未结束。',
      );
      requireThat(summary.reportVersion, 'REPORT_REQUIRED', '正式战报尚未生成，暂不能清理。');
      this.db.tx(() => {
        this.assertVersion(this.directory(d.id), p.expected_version);
        requireThat(
          d.state !== 'purge_pending' && erasureFloor(this, d.id) === 0,
          'CLEANUP_ALREADY_REQUESTED',
          '本场已经安排清理或已经清理。请查看管理待办。',
        );
        requireThat(
          !this.db.one('SELECT match_id FROM retention_holds WHERE match_id=?', d.id),
          'RETENTION_HOLD',
          '本场资料因申诉暂缓清理。',
        );
        this.db.exec(
          "UPDATE match_directory SET state='purge_pending',version=version+1 WHERE id=?",
          d.id,
        );
        this.insertOperation(id, s.account_id, 'purge', d.id, bodyHash, p, reason);
        this.db.exec(
          'UPDATE platform_operations SET next_attempt=? WHERE id=?',
          this.now() + 7 * 86400000,
          id,
        );
      });
      await this.arm();
      return { status: 202, body: { operationId: id, status: 'pending' } };
    }
    if (path === '/platform/data/cancel-purge') {
      const op = this.db.one<Operation>(
        "SELECT * FROM platform_operations WHERE id=? AND action='purge' AND status='pending'",
        text(p.operationId, 100),
      );
      requireThat(
        op &&
          !this.db.one(
            'SELECT match_id FROM erasure_ledger WHERE match_id=? AND status!=?',
            op.target,
            'cancelled',
          ),
        'CANNOT_CANCEL',
        '清理已进入不可撤销步骤。',
      );
      requireThat(
        this.dataScope(s.account_id, op.target),
        'ARCHIVE_SCOPE_REQUIRED',
        '当前账号未获本场数据管理权限。',
        403,
      );
      this.db.tx(() => {
        this.db.exec("UPDATE platform_operations SET status='cancelled' WHERE id=?", op.id);
        this.db.exec(
          "UPDATE match_directory SET state='available',version=version+1 WHERE id=?",
          op.target,
        );
        this.insertOperation(
          id,
          s.account_id,
          'cancel-purge',
          op.target,
          bodyHash,
          {},
          reason,
          'succeeded',
        );
      });
      return { status: 200, body: { status: 'cancelled' } };
    }
    throw new Fault(404, 'NOT_FOUND', '平台接口不存在。');
  }
  private assertVersion(row: { version: number }, version: unknown) {
    requireThat(
      row.version === integer(version, 1),
      'VERSION_CONFLICT',
      '内容已变化，请刷新后重新预览。',
    );
  }
  private protectOwner(id: string) {
    if (this.roles(id).includes('owner'))
      requireThat(
        this.db.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM platform_roles r JOIN platform_accounts a ON a.id=r.account_id WHERE r.role='owner' AND a.status='active' AND a.id!=?",
          id,
        )!.n > 0,
        'LAST_OWNER',
        '至少保留一名已激活且可恢复访问的所有者。',
      );
  }
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
      if (!action.startsWith('control:') && !['roles', 'cancel-unreceived'].includes(action))
        requireThat(
          this.roles(actor).some((role) => ['owner', 'admin', 'archivist'].includes(role)),
          'AUTHOR_REVOKED',
          '平台任职已变化，请重新登录后核对。',
          403,
        );
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
    this.audit(actor, action, target, reason, { operationId: id });
  }
  private operationView(op: Operation) {
    return {
      ...op,
      payload: undefined,
      body_hash: undefined,
      receipts: this.db.all(
        'SELECT target,status,receipt FROM operation_targets WHERE operation_id=?',
        op.id,
      ),
    };
  }
  private async readPlatform(path: string, input: RpcInput, s: Login): Promise<RpcReply> {
    const url = new URL(input.path, 'https://internal');
    const manager = this.roles(s.account_id).some((role) => ['owner', 'admin'].includes(role));
    const canSee = (id: string) => manager || this.dataScope(s.account_id, id);
    if (path === '/platform/accounts') {
      this.admin(s);
      const after = url.searchParams.get('after') ?? '';
      return {
        status: 200,
        body: this.db
          .all<Account>('SELECT * FROM platform_accounts WHERE id>? ORDER BY id LIMIT 100', after)
          .map((a) => this.safeAccount(a)),
      };
    }
    if (path === '/platform/matches')
      return {
        status: 200,
        body: this.db
          .all<{ id: string }>(
            'SELECT id,name,kind,state,version,created_utc,summary,synced_utc,recommended,retention_days,audit_days FROM match_directory ORDER BY created_utc DESC LIMIT 200',
          )
          .filter((row) => canSee(row.id)),
      };
    if (path === '/platform/operations')
      return {
        status: 200,
        body: this.db
          .all<Operation>('SELECT * FROM platform_operations ORDER BY created_utc DESC LIMIT 100')
          .filter((op) => op.actor === s.account_id || canSee(op.target))
          .map((op) => this.operationView(op)),
      };
    if (path.startsWith('/platform/operations/')) {
      const op = this.db.one<Operation>(
        'SELECT * FROM platform_operations WHERE id=?',
        path.slice(21),
      );
      requireThat(
        op && (op.actor === s.account_id || canSee(op.target)),
        'NOT_FOUND',
        '任务不存在或当前账号不能查看。',
        404,
      );
      return { status: 200, body: this.operationView(op) };
    }
    if (path === '/platform/security') {
      this.admin(s, ['owner']);
      return {
        status: 200,
        body: {
          roles: this.db.all(
            'SELECT r.account_id,a.name,r.role FROM platform_roles r JOIN platform_accounts a ON a.id=r.account_id',
          ),
          audit: this.db.all('SELECT * FROM platform_audit ORDER BY utc_ms DESC LIMIT 100'),
        },
      };
    }
    if (path === '/platform/data') {
      this.admin(s, ['owner', 'archivist']);
      return {
        status: 200,
        body: {
          holds: this.db
            .all<{ match_id: string }>('SELECT * FROM retention_holds')
            .filter((row) => this.dataScope(s.account_id, row.match_id)),
          ledger: this.db
            .all<{ match_id: string }>('SELECT * FROM erasure_ledger')
            .filter((row) => this.dataScope(s.account_id, row.match_id)),
        },
      };
    }
    if (path.startsWith('/platform/invitations/')) {
      this.admin(s, ['owner', 'admin'], true);
      const row = this.db.one<{
        id: string;
        ciphertext: string | null;
        delivery_expires: number;
        issuer: string;
      }>('SELECT * FROM invitations WHERE id=?', path.slice('/platform/invitations/'.length));
      requireThat(
        row && row.issuer === s.account_id && row.ciphertext && row.delivery_expires > this.now(),
        'DELIVERY_EXPIRED',
        '交付材料已过期，请重新发送邀请。',
        404,
      );
      const invitation = await decrypt(
        await platformKey(this.env),
        row.ciphertext,
        `invitation|${row.id}`,
      );
      this.admin(this.login(s.token_hash), ['owner', 'admin'], true);
      return { status: 200, body: { invitation } };
    }
    throw new Fault(404, 'NOT_FOUND', '页面数据不存在。');
  }
  private async previewDetails(
    path: string,
    p: Record<string, unknown>,
    s: Login,
  ): Promise<Record<string, unknown>> {
    if (p.matchId) {
      const d = this.directory(text(p.matchId, 100));
      const summary = await this.summary(d, s.account_id);
      return {
        match: { id: d.id, name: d.name, kind: d.kind, version: d.version },
        current: path.startsWith('/platform/data/')
          ? { phase: summary.phase, retention_days: d.retention_days, audit_days: d.audit_days }
          : summary,
        warning: path.includes('purge')
          ? '提交后等待7天再清理网站上的完整复盘。请提前下载需要保留的资料；已下载的文件需要另行处理。'
          : '权限与比赛状态将在提交时再次检查。',
      };
    }
    if (p.accountId) {
      const a = this.account(text(p.accountId, 100));
      return {
        account: this.safeAccount(a),
        matches: this.db.all('SELECT match_id FROM account_match_index WHERE account_id=?', a.id),
        warning: '全局停用先拒绝新授权，再逐场撤销；已在撤销栅栏前提交的在途请求可能已成功。',
      };
    }
    return { warning: '执行后会保留审计与逐目标收据。' };
  }
  private async createAccount(
    s: Login,
    id: string,
    p: Record<string, unknown>,
    hash: string,
    reason: string,
  ): Promise<RpcReply> {
    const kind = p.kind;
    requireThat(kind === 'player' || kind === 'staff', 'BAD_KIND', '账号类别不正确。', 400);
    const name = text(p.name, 100),
      accountId = crypto.randomUUID(),
      invitation = token(),
      inviteId = crypto.randomUUID(),
      inviteHash = await digest(invitation),
      cipher = await encrypt(await platformKey(this.env), invitation, `invitation|${inviteId}`);
    this.db.tx(() => {
      this.db.exec(
        'INSERT INTO platform_accounts(id,kind,name,status,tags,created_utc) VALUES(?,?,?,?,?,?)',
        accountId,
        kind,
        name,
        'pending',
        typeof p.tags === 'string' ? text(p.tags, 500, 0) : '',
        this.now(),
      );
      this.db.exec(
        'INSERT INTO invitations VALUES(?,?,?,?,0,?,?,?)',
        inviteId,
        accountId,
        inviteHash,
        this.now() + 7 * 86400000,
        cipher,
        this.now() + 86400000,
        s.account_id,
      );
      this.insertOperation(
        id,
        s.account_id,
        'account-create',
        accountId,
        hash,
        {},
        reason,
        'succeeded',
      );
      this.db.exec(
        'UPDATE platform_operations SET result=? WHERE id=?',
        JSON.stringify({ accountId, invitationId: inviteId }),
        id,
      );
    });
    return {
      status: 201,
      body: {
        accountId,
        invitationId: inviteId,
        invitation,
        expiresUtc: this.now() + 7 * 86400000,
      },
    };
  }
  private async importAccounts(
    s: Login,
    id: string,
    p: Record<string, unknown>,
    hash: string,
    reason: string,
  ): Promise<RpcReply> {
    requireThat(
      Array.isArray(p.rows) && p.rows.length <= 100 && p.rows.length > 0,
      'IMPORT_LIMIT',
      '每批须为1—100行，请分批导入。',
      400,
    );
    const rows = p.rows.map((r, i) => {
      try {
        const row = object(r);
        requireThat(
          row.kind === 'player' || row.kind === 'staff',
          'BAD_KIND',
          '类别须为player或staff。',
          400,
        );
        return {
          line: i + 1,
          name: text(row.name, 100),
          kind: row.kind,
          accountId: typeof row.accountId === 'string' ? row.accountId : null,
          error: '',
        };
      } catch (error) {
        return {
          line: i + 1,
          name: '',
          kind: 'player',
          accountId: null,
          error: error instanceof Error ? error.message : '格式错误',
        };
      }
    });
    const errors = rows.filter((r) => r.error);
    if (p.preview === true)
      return {
        status: 200,
        body: { rows, valid: rows.length - errors.length, errors: errors.length },
      };
    requireThat(!errors.length, 'IMPORT_ERRORS', '请先修复预览中的行级错误。', 400);
    const batch = text(p.batchId, 100),
      fileHash = await digest(stableJson(p.rows));
    const old = this.db.one<{ body_hash: string; result: string }>(
      'SELECT * FROM import_batches WHERE id=?',
      batch,
    );
    if (old) {
      requireThat(old.body_hash === fileHash, 'BATCH_CONFLICT', '该批次对应不同文件。');
      return { status: 200, body: JSON.parse(old.result) };
    }
    const result = rows.map((r) => ({ ...r, id: r.accountId ?? crypto.randomUUID() }));
    this.db.tx(() => {
      for (const row of result) {
        if (row.accountId) {
          const a = this.account(row.accountId);
          requireThat(
            p.confirmMapping === true && a.kind === row.kind,
            'MAPPING_REQUIRED',
            '已有账号需按明确ID确认映射。',
          );
          this.db.exec(
            'UPDATE platform_accounts SET name=?,version=version+1 WHERE id=?',
            row.name,
            row.id,
          );
        } else
          this.db.exec(
            "INSERT INTO platform_accounts(id,kind,name,status,created_utc) VALUES(?,?,?,'pending',?)",
            row.id,
            row.kind,
            row.name,
            this.now(),
          );
      }
      this.db.exec(
        'INSERT INTO import_batches VALUES(?,?,?,?)',
        batch,
        fileHash,
        JSON.stringify({ rows: result }),
        s.account_id,
      );
      this.insertOperation(
        id,
        s.account_id,
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
      body: { rows: result, message: '未领取账号请在账号池单独生成邀请；同名不会合并。' },
    };
  }
  private async changeAccount(
    s: Login,
    id: string,
    path: string,
    p: Record<string, unknown>,
    hash: string,
    reason: string,
  ): Promise<RpcReply> {
    const account = this.account(text(p.accountId, 100));
    this.assertVersion(account, p.expected_version);
    if (path === '/platform/accounts/invite' || path === '/platform/accounts/reset') {
      if (path.endsWith('/reset'))
        requireThat(account.status !== 'disabled', 'DISABLED', '停用账号需先受控启用。');
      const invitation = token(),
        inviteId = crypto.randomUUID(),
        inviteHash = await digest(invitation),
        cipher = await encrypt(await platformKey(this.env), invitation, `invitation|${inviteId}`);
      this.db.tx(() => {
        this.assertVersion(this.account(account.id), p.expected_version);
        this.db.exec(
          'UPDATE invitations SET claimed=1,ciphertext=NULL WHERE account_id=?',
          account.id,
        );
        this.db.exec(
          'INSERT INTO invitations VALUES(?,?,?,?,0,?,?,?)',
          inviteId,
          account.id,
          inviteHash,
          this.now() + 7 * 86400000,
          cipher,
          this.now() + 86400000,
          s.account_id,
        );
        if (path.endsWith('/reset')) {
          this.db.exec(
            'UPDATE platform_accounts SET credential_hash=NULL,auth_epoch=auth_epoch+1,version=version+1 WHERE id=?',
            account.id,
          );
          this.db.exec('UPDATE platform_sessions SET revoked=1 WHERE account_id=?', account.id);
        } else
          this.db.exec('UPDATE platform_accounts SET version=version+1 WHERE id=?', account.id);
        this.insertOperation(
          id,
          s.account_id,
          'credential-invite',
          account.id,
          hash,
          {},
          reason,
          'succeeded',
        );
        this.db.exec(
          'UPDATE platform_operations SET result=? WHERE id=?',
          JSON.stringify({ invitationId: inviteId }),
          id,
        );
      });
      return {
        status: 200,
        body: {
          invitationId: inviteId,
          invitation,
          warning: '重置影响全部比赛，旧口令和会话已失效；管理任务授权仍须另行撤销。',
        },
      };
    }
    requireThat(path === '/platform/accounts/status', 'NOT_FOUND', '账号操作不存在。', 404);
    requireThat(
      p.status === 'active' || p.status === 'disabled',
      'BAD_STATUS',
      '请选择启用或停用。',
      400,
    );
    if (p.status === 'disabled' && p.emergency !== true) {
      for (const target of this.db.all<{ match_id: string }>(
        'SELECT match_id FROM account_match_index WHERE account_id=?',
        account.id,
      )) {
        const d = this.directory(target.match_id),
          current = await this.summary(d, s.account_id);
        requireThat(
          !(current.members as { account_id: string; local_id: string; state: string }[]).some(
            (m) => m.account_id === account.id && m.local_id === 'J01' && m.state === 'bound',
          ),
          'HEAD_HANDOVER_REQUIRED',
          `该账号仍任${d.name}的总裁判，请先交接岗位；凭据泄漏时可选择紧急停用。`,
        );
      }
    }
    this.db.tx(() => {
      this.assertVersion(this.account(account.id), p.expected_version);
      if (p.status === 'disabled' && p.emergency !== true) this.protectOwner(account.id);
      this.db.exec(
        'UPDATE platform_accounts SET status=?,auth_epoch=auth_epoch+1,version=version+1 WHERE id=?',
        p.status === 'active' && !account.credential_hash ? 'pending' : (p.status as string),
        account.id,
      );
      this.db.exec('UPDATE platform_sessions SET revoked=1 WHERE account_id=?', account.id);
      const updated = this.account(account.id);
      this.insertOperation(
        id,
        s.account_id,
        'fence',
        account.id,
        hash,
        { accountId: account.id, authEpoch: updated.auth_epoch, disabled: p.status === 'disabled' },
        reason,
      );
      for (const target of this.db.all<{ match_id: string }>(
        'SELECT match_id FROM account_match_index WHERE account_id=?',
        account.id,
      ))
        this.db.exec(
          'INSERT INTO operation_targets(operation_id,target) VALUES(?,?)',
          id,
          target.match_id,
        );
    });
    await this.arm();
    return {
      status: 202,
      body: {
        operationId: id,
        status: 'pending',
        message: '平台已拒绝旧授权；逐场撤销完成前，在途请求可能已提交。',
      },
    };
  }
  private async matchRequest(input: RpcInput, s: Login): Promise<RpcReply> {
    const url = new URL(input.path, 'https://internal'),
      match = /^\/matches\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
    requireThat(match, 'MATCH_NOT_FOUND', '场次地址无效。', 404);
    const d = this.directory(match[1]!),
      path = match[2] ?? '/';
    const indexed = !!this.db.one(
        'SELECT account_id FROM account_match_index WHERE account_id=? AND match_id=?',
        s.account_id,
        d.id,
      ),
      admin = this.roles(s.account_id).some((r) => ['owner', 'admin'].includes(r));
    if (
      ((path === '/manage' || path === '/eligible') && input.method === 'GET') ||
      (path === '/preview' && input.method === 'POST')
    ) {
      const current = await this.summary(d, s.account_id);
      const head = (
        current.members as { account_id: string; local_id: string; state: string }[]
      ).some((m) => m.account_id === s.account_id && m.local_id === 'J01' && m.state === 'bound');
      if (admin) this.admin(s);
      else requireThat(head, 'FORBIDDEN', '需要本场总裁判或平台管理员。', 403);
      if (path === '/eligible')
        return {
          status: 200,
          body: (
            current.members as { account_id: string; name: string; kind: string; state: string }[]
          )
            .filter((m) => m.kind === 'staff' && m.state === 'accepted')
            .map((m) => ({ id: m.account_id, name: m.name, kind: 'staff', status: 'active' })),
        };
      if (path === '/preview') {
        requireThat(
          s.reauth_utc > this.now() - 600000,
          'REAUTH_REQUIRED',
          '请先在账号安全页面重新认证。',
          403,
        );
        const body = object(input.body),
          payload = object(body.payload),
          target = text(body.path, 200);
        requireThat(
          target === `/matches/${d.id}/staff/assign`,
          'BAD_PREVIEW',
          '本页面只预览本场裁判交接。',
          400,
        );
        const previewToken = token();
        this.db.exec(
          'INSERT INTO platform_previews VALUES(?,?,?,?,?)',
          previewToken,
          s.account_id,
          target,
          await digest(stableJson(payload)),
          this.now() + 300000,
        );
        return {
          status: 200,
          body: {
            previewToken,
            match: { name: d.name, kind: d.kind },
            current,
            warning: '交接后旧任职结束，旧预览失效。未执行管理任务需要重新核对。',
          },
        };
      }
      return { status: 200, body: { match: d, current } };
    }
    if (input.method === 'GET' && (path === '/history' || path.startsWith('/history/')))
      return this.matchHistory(s, d, path, url);
    if (
      input.method === 'POST' &&
      ['/members/invite', '/members/accept', '/members/bind', '/staff/assign', '/publish'].includes(
        path,
      )
    ) {
      const p = object(input.body),
        id = requestId(p.request_id),
        reason = text(p.reason, 500),
        bodyHash = await digest(stableJson({ path, matchId: d.id, body: p }));
      const old = this.db.one<Operation>('SELECT * FROM platform_operations WHERE id=?', id);
      if (old) {
        requireThat(
          old.actor === s.account_id && old.body_hash === bodyHash,
          'OPERATION_CONFLICT',
          '操作编号已用于不同内容。',
        );
        return { status: 200, body: this.operationView(old) };
      }
      const self = path === '/members/accept' || path === '/members/bind';
      const actor = s.account_id;
      if (self) requireThat(indexed, 'FORBIDDEN', '请先取得本场邀请。', 403);
      else {
        if (admin) this.admin(s, ['owner', 'admin'], path === '/staff/assign');
        else {
          const current = await this.summary(d, s.account_id);
          const member = (
            current.members as { account_id: string; local_id: string; state: string }[]
          ).find(
            (m) => m.account_id === s.account_id && m.local_id === 'J01' && m.state === 'bound',
          );
          requireThat(member, 'FORBIDDEN', '需要本场总裁判或平台管理员。', 403);
          requireThat(
            !(path === '/staff/assign' && p.seat === 'J01' && p.takeover === true),
            'FORBIDDEN',
            '失联接管需要平台管理员。',
            403,
          );
        }
        const payload = { ...p };
        delete payload.request_id;
        delete payload.preview_token;
        if (path === '/staff/assign') {
          const preview = this.db.one<{ body_hash: string }>(
            'SELECT body_hash FROM platform_previews WHERE id=? AND actor=? AND path=? AND expires>?',
            String(p.preview_token),
            s.account_id,
            `/matches/${d.id}${path}`,
            this.now(),
          );
          requireThat(
            preview?.body_hash === (await digest(stableJson(payload))),
            'PREVIEW_REQUIRED',
            '请重新预览裁判交接影响。',
          );
          const a = this.account(text(p.accountId, 100));
          requireThat(
            a.status === 'active' && a.kind === 'staff',
            'ACTIVE_STAFF_REQUIRED',
            '新裁判需先激活工作人员账号。',
          );
        }
      }
      const targetId = path === '/members/invite' ? text(p.accountId, 100) : actor;
      let payload: Record<string, unknown> = { ...p };
      if (path === '/members/invite') {
        const a = this.account(targetId);
        requireThat(a.status !== 'disabled', 'ACCOUNT_DISABLED', '停用账号不能加入比赛。');
        payload = { accountId: a.id, kind: a.kind, name: a.name };
      }
      const action = (
        {
          '/members/invite': 'invite',
          '/members/accept': 'accept',
          '/members/bind': 'bind',
          '/staff/assign': 'assign',
          '/publish': 'publish',
        } as Record<string, string>
      )[path]!;
      this.db.tx(() => {
        this.insertOperation(
          id,
          s.account_id,
          `control:${action}`,
          d.id,
          bodyHash,
          { ...payload, controlActor: actor },
          reason,
        );
        if (action === 'invite')
          this.db.exec('INSERT OR IGNORE INTO account_match_index VALUES(?,?)', targetId, d.id);
      });
      await this.arm();
      return { status: 202, body: { operationId: id, status: 'pending' } };
    }
    requireThat(indexed, 'MATCH_FORBIDDEN', '当前账号没有本场访问权限。', 403);
    if (erasureFloor(this, d.id) > 0)
      throw new Fault(410, 'REPLAY_EXPIRED', '完整复盘已到期，请从本场历史页面查看保留的战报。');
    requireThat(
      d.state === 'available' ||
        d.state === 'archived' ||
        d.state === 'archiving' ||
        d.state === 'purge_pending',
      'MATCH_NOT_AVAILABLE',
      '本场尚未发布或只保留档案。',
      409,
    );
    const a = this.account(s.account_id),
      grant: MatchGrant = {
        accountId: a.id,
        authEpoch: a.auth_epoch,
        matchId: d.id,
        csrf: s.csrf,
        expires: this.now() + 30000,
        audience: a.kind,
      };
    const matchInput = { ...input, path: `${path}${url.search}` };
    const reply = await this.env.MATCH_DO.getByName(d.object_name).authorized(
      matchInput,
      grant,
      await controlSignature(this.env, stableJson({ input: matchInput, grant })),
    );
    this.login(s.token_hash);
    if (input.method === 'GET' && erasureFloor(this, d.id) > 0)
      throw new Fault(410, 'REPLAY_EXPIRED', '完整复盘已到期，请从本场历史页面查看保留的战报。');
    return { ...reply, body: JSON.parse(reply.body) };
  }
  private async matchHistory(s: Login, d: Directory, path: string, url: URL): Promise<RpcReply> {
    const staffScope = () => this.dataScope(s.account_id, d.id);
    const download = /^\/history\/download\/(report|replay|audit|backup)$/.exec(path);
    const kind = (download?.[1] ?? path.slice('/history/'.length)) as MatchDownload;
    requireThat(
      path === '/history' || download || kind === 'report' || kind === 'replay',
      'NOT_FOUND',
      '没有这项赛后资料。',
      404,
    );
    if (download) {
      this.admin(s, ['owner', 'archivist'], kind === 'audit' || kind === 'backup');
      requireThat(staffScope(), 'ARCHIVE_SCOPE_REQUIRED', '当前账号不能下载本场资料。', 403);
    }
    const indexed = this.db.one(
      'SELECT account_id FROM account_match_index WHERE account_id=? AND match_id=?',
      s.account_id,
      d.id,
    );
    requireThat(indexed || staffScope(), 'FORBIDDEN', '当前账号不能查看本场历史。', 403);
    const current = await this.summary(d, s.account_id);
    const localReader =
      (current.participants as string[]).includes(s.account_id) ||
      (current.members as MatchMember[]).some(
        (m) => m.account_id === s.account_id && m.state === 'bound' && m.local_id === 'J01',
      );
    const authorize = () => {
      this.login(s.token_hash);
      if (download) this.admin(s, ['owner', 'archivist'], kind === 'audit' || kind === 'backup');
      else if (!localReader) this.admin(s, ['owner', 'archivist']);
      requireThat(
        download ? staffScope() : localReader || staffScope(),
        'FORBIDDEN',
        '当前账号不能查看这项赛后资料。',
        403,
      );
    };
    authorize();
    const available = (full: boolean) => {
      const held = this.db.one('SELECT match_id FROM retention_holds WHERE match_id=?', d.id);
      const days = full ? d.retention_days : d.audit_days;
      return (
        current.phase === 'ended' &&
        !current.recovering &&
        (!full || (erasureFloor(this, d.id) === 0 && current.erasureGeneration === 0)) &&
        (!!held || this.now() < Number(current.endedUtc) + days * 86400000)
      );
    };
    const record = (level: string, version?: number) =>
      this.control(d, crypto.randomUUID(), 'history-record', s.account_id, '读取本场赛后资料', {
        kind: level,
        organizer: staffScope(),
        ...(version === undefined ? {} : { version }),
      });
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
      if (staffScope() && replayAvailable) downloads.push('replay', 'backup');
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
    requireThat(current.phase === 'ended', 'ENDED_REQUIRED', '比赛结束后可以查看赛后资料。');
    requireThat(!current.recovering, 'RECOVERY_LOCKED', '比赛正在恢复，请稍后再查看资料。');
    requireThat(available(full), 'HISTORY_EXPIRED', '这项赛后资料已超过保留期。', 410);
    this.limit(`history:${s.account_id}`, 20);
    const rawVersion = url.searchParams.get('version');
    const version =
      rawVersion !== null && kind === 'report' ? integer(Number(rawVersion), 1) : undefined;
    const data = await record(kind, version);
    authorize();
    requireThat(available(full), 'HISTORY_EXPIRED', '这项赛后资料已停止提供。', 410);
    if (!download) return { status: 200, body: data };
    this.audit(s.account_id, 'history-download', d.id, '下载本场赛后资料', { kind, version });
    if (kind === 'backup') {
      requireThat(
        typeof data.fileName === 'string' && typeof data.text === 'string',
        'HISTORY_UNAVAILABLE',
        '暂时无法生成加密备份，请稍后重试。',
        503,
      );
      return { status: 200, body: { fileName: data.fileName, text: data.text } };
    }
    const labels = { report: '战报', replay: '完整复盘', audit: '裁判操作记录' };
    const reportVersion =
      kind === 'report' ? `-第${(data.report as { version: number }).version}版` : '';
    return {
      status: 200,
      body: {
        fileName: `${d.id}-${labels[kind]}${reportVersion}.json`,
        text: JSON.stringify(data, null, 2),
      },
    };
  }
  async arm() {
    const next = this.db.one<{ due: number }>(
      "SELECT MIN(next_attempt) AS due FROM platform_operations WHERE status IN ('pending','partial') AND attempts<8 AND action!='adopt-legacy'",
    );
    const delivery = this.db.one<{ due: number }>(
      'SELECT MIN(delivery_expires) AS due FROM invitations WHERE ciphertext IS NOT NULL',
    )?.due;
    const due = Math.min(next?.due ?? Infinity, delivery ?? Infinity);
    if (Number.isFinite(due)) {
      const wanted = Math.max(this.now() + 100, due),
        scheduled = await this.ctx.storage.getAlarm();
      if (scheduled === null || scheduled > wanted) await this.ctx.storage.setAlarm(wanted);
    }
  }
  async alarm() {
    this.db.exec('UPDATE invitations SET ciphertext=NULL WHERE delivery_expires<?', this.now());
    this.db.exec('DELETE FROM platform_sessions WHERE expires<?', this.now() - 30 * 86400000);
    const operations = this.db.all<Operation>(
      "SELECT * FROM platform_operations WHERE status IN ('pending','partial') AND attempts<8 AND next_attempt<=? AND action!='adopt-legacy' ORDER BY created_utc LIMIT 4",
      this.now(),
    );
    for (const op of operations) {
      try {
        const owner = this.account(op.actor);
        requireThat(
          owner.status === 'active',
          'AUTHOR_DISABLED',
          '任务发起账号已停用，需要管理员重新核对。',
        );
        if (!op.action.startsWith('control:'))
          requireThat(
            this.roles(op.actor).some((r) => ['owner', 'admin', 'archivist'].includes(r)),
            'AUTHOR_REVOKED',
            '任务发起人已失去管理权限。',
          );
        const p = JSON.parse(op.payload) as Record<string, unknown>;
        let result: unknown = {};
        if (op.action === 'create') {
          const d = this.directory(op.target);
          result = await this.control(d, op.id, 'initialize', op.actor, '网站新建独立比赛', p);
          this.db.exec(
            "UPDATE match_directory SET state='draft',version=version+1 WHERE id=?",
            d.id,
          );
        } else if (op.action.startsWith('control:')) {
          const d = this.directory(op.target),
            action = op.action.slice(8);
          if (
            ['invite', 'assign', 'publish'].includes(action) &&
            !this.roles(op.actor).some((r) => ['owner', 'admin'].includes(r))
          ) {
            const latest = await this.summary(d, op.actor);
            requireThat(
              (latest.members as { account_id: string; local_id: string; state: string }[]).some(
                (m) => m.account_id === op.actor && m.local_id === 'J01' && m.state === 'bound',
              ),
              'AUTHOR_REVOKED',
              '原总裁判已失去任职，请由新人重新提交。',
            );
          }
          if (p.accountId)
            requireThat(
              this.account(String(p.accountId)).status !== 'disabled',
              'ACCOUNT_DISABLED',
              '目标账号已停用。',
            );
          result = await this.control(
            d,
            op.id,
            action,
            String(p.controlActor ?? op.actor),
            '网站本场管理',
            p,
          );
          if (action === 'publish')
            this.db.exec(
              "UPDATE match_directory SET state='available',version=version+1 WHERE id=?",
              d.id,
            );
        } else if (op.action === 'fence') {
          const targets = this.db.all<{ target: string }>(
            'SELECT target FROM operation_targets WHERE operation_id=? AND status!=? LIMIT 8',
            op.id,
            'succeeded',
          );
          for (const target of targets) {
            try {
              const receipt = await this.control(
                this.directory(target.target),
                `${op.id}:${target.target}`,
                'fence',
                op.actor,
                '全局账号授权更新',
                p,
              );
              this.db.exec(
                "UPDATE operation_targets SET status='succeeded',receipt=? WHERE operation_id=? AND target=?",
                JSON.stringify(receipt),
                op.id,
                target.target,
              );
            } catch {
              this.db.exec(
                "UPDATE operation_targets SET status='failed',receipt=? WHERE operation_id=? AND target=?",
                JSON.stringify({ message: '连接未确认，请重试原步骤。' }),
                op.id,
                target.target,
              );
            }
          }
          if (
            this.db.one(
              'SELECT target FROM operation_targets WHERE operation_id=? AND status!=?',
              op.id,
              'succeeded',
            )
          ) {
            this.db.exec(
              "UPDATE platform_operations SET status='partial',attempts=attempts+1,next_attempt=? WHERE id=?",
              this.now() + Math.min(300000, 1000 * 2 ** op.attempts),
              op.id,
            );
            continue;
          }
          result = { allFenced: true };
        } else if (op.action === 'purge') {
          requireThat(
            this.dataScope(op.actor, op.target),
            'ARCHIVE_SCOPE_REQUIRED',
            '任务发起人已失去本场数据权限。',
          );
          result = await erasureOperation(this, op);
        } else throw new Error('UNKNOWN_OPERATION');
        this.db.exec(
          "UPDATE platform_operations SET status='succeeded',result=?,error='' WHERE id=?",
          JSON.stringify(result),
          op.id,
        );
      } catch (error) {
        this.db.exec(
          "UPDATE platform_operations SET status='failed',attempts=attempts+1,error=? WHERE id=?",
          error instanceof Fault ? error.message : '未取得完整收据，源数据保留；可重试原任务。',
          op.id,
        );
      }
    }
    await this.arm();
  }
}
