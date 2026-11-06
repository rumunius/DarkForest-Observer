import type { OperationResult, Session } from '@darkforest/contracts';
import { qqCopy } from '../../../../packages/contracts/src/message-copy';
import {
  ContractError,
  coordinate,
  integer,
  object,
  requestId,
  stableJson,
  strict,
  text,
} from '../../../../packages/contracts/src/backend';
import { decodeArms, enumerateCodes, gameTime, uniformInt } from '../domain/rules';
import { decrypt, digest, encrypt, mac, secretKey, token } from '../security/crypto';
import {
  DEFAULT_SITE,
  Fault,
  Store,
  permission,
  requireThat,
  type Actor,
  type CodeRow,
} from '../storage/store';
import type { BackendEnv, MatchGrant, RpcInput, RpcReply } from '../rpc/types';
import { membershipActor } from '../platform/match-control';
import { derive } from '../platform/security';
import { projectSnapshot, readEndpoint } from '../projections/snapshot';
import { playerAction } from './player';
import { judgeAction, previewAction } from './judge';
import { commandAction, recordCommand, prepareCommandCredentials } from './commands';
import {
  commandSpec,
  parseCommandTree,
  CommandSyntaxError,
} from '../../../../packages/contracts/src/commands';
import { settleDue, rearm, EventFailure, recordEventFailure } from '../scheduler/events';
import { SCHEMA_VERSION } from '../storage/schema';
import { exportData } from './export';
import { prepareCredential } from './accounts';

export type PreparedCode = { id: string; mac: string; ciphertext: string };
export type Codebook = {
  hmac: CryptoKey;
  encryption: CryptoKey;
  fingerprint: string;
  codes: { key: string; mac: string }[];
};
const HEAD = [
  'overview',
  'homeworlds',
  'preflight',
  'notices',
  'endgame',
  'players',
  'events',
  'attacks',
  'results',
  'clock',
  'equipment',
  'effects',
  'commands',
  'system',
  'audit',
  'settings',
  'account',
];
export class Engine {
  platformKeys = false;
  taskAuthorization = new Set<string>();
  get matchId(): string {
    return this.db.one<{ id: string }>('SELECT id FROM matches')?.id ?? this.env.MATCH_ID;
  }
  /** Scoped to one synchronous command transaction; never persisted or exposed to players. */
  commandBatch = false;
  commandPrepared: PreparedCode[] = [];
  commandSnapshot: Record<string, string[]> = {};
  commandCredentials: Record<string, Awaited<ReturnType<typeof prepareCredential>>> = {};
  resolvedKeys: Codebook | undefined;
  private materials:
    | Promise<{
        hmac: CryptoKey;
        encryption: CryptoKey;
        fingerprint: string;
        codes: { key: string; mac: string }[];
      }>
    | undefined;
  constructor(
    public db: Store,
    public env: BackendEnv,
    public grant?: MatchGrant,
  ) {}
  now(): number {
    return Date.now();
  }
  game(now = this.now()): number {
    return gameTime(this.db.match(), now);
  }
  async keys(): Promise<Codebook> {
    if (!this.materials)
      this.materials = (async () => {
        const modern =
          this.platformKeys || !!this.db.one('SELECT id FROM match_identity WHERE key_version=2');
        const [hmacRaw, encryptionRaw] = modern
          ? await Promise.all([
              derive(this.env, `match|${this.matchId}|bracelet`),
              derive(this.env, `match|${this.matchId}|encryption|${this.env.CODE_ENCRYPTION_KEY}`),
            ])
          : [this.env.CODE_HMAC_KEY, this.env.CODE_ENCRYPTION_KEY];
        const [hmac, encryption] = await Promise.all([
          secretKey(hmacRaw, 'HMAC'),
          secretKey(encryptionRaw, 'AES-GCM'),
        ]);
        const fingerprint = await digest(`${hmacRaw}|${encryptionRaw}`);
        const codes = await Promise.all(
          enumerateCodes().map(async (key) => ({
            key,
            mac: await mac(hmac, `bracelet|${this.matchId}|${key}`),
          })),
        );
        const result = { hmac, encryption, fingerprint, codes };
        this.resolvedKeys = result;
        return result;
      })().catch((error) => {
        this.materials = undefined;
        throw error;
      });
    return this.materials;
  }
  async prepareCode(): Promise<PreparedCode[]> {
    const keys = await this.keys();
    const used = new Set(
      this.db.all<{ mac: string }>('SELECT mac FROM sighting_codes').map((c) => c.mac),
    );
    const available = keys.codes.filter((c) => !used.has(c.mac));
    // Prepare all still-available candidates before the transaction; concurrent issuers recheck SQL.
    return Promise.all(
      available.map(async (c) => {
        const id = crypto.randomUUID();
        return {
          id,
          mac: c.mac,
          ciphertext: await encrypt(keys.encryption, c.key, `${this.matchId}|${id}`),
        };
      }),
    );
  }
  arms(code: CodeRow | undefined, codebook: Awaited<ReturnType<Engine['keys']>>) {
    if (!code) return null;
    const key = codebook.codes.find((c) => c.mac === code.mac)?.key;
    if (!key) throw new Error('CODE_KEY_MISMATCH');
    return decodeArms(key);
  }
  limit(key: string, max: number, window = 60_000): void {
    const bucket = Math.floor(this.now() / window);
    const count = this.db.one<{ count: number }>(
      'INSERT INTO rate_limits(key,bucket,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN bucket=excluded.bucket THEN count+1 ELSE 1 END,bucket=excluded.bucket RETURNING count',
      key,
      bucket,
    )!.count;
    requireThat(count <= max, 'RATE_LIMITED', '操作过于频繁，请稍后重试。', 429);
  }
  actor(tokenHash: string): Actor {
    if (this.grant) return membershipActor(this, this.grant);
    requireThat(
      !this.db.one('SELECT id FROM match_identity'),
      'PLATFORM_LOGIN_REQUIRED',
      '请从长期账号入口登录。',
      401,
    );
    const actor = this.db.one<Actor>(
      'SELECT a.* FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE s.token_hash=? AND s.revoked=0 AND s.expires>? AND a.enabled=1',
      tokenHash,
      this.now(),
    );
    requireThat(actor && actor.match_id === this.matchId, 'UNAUTHENTICATED', '请重新登录。', 401);
    return actor;
  }
  session(actor: Actor, tokenHash: string): Session {
    const csrf =
      this.grant?.csrf ??
      this.db.one<{ csrf: string }>('SELECT csrf FROM sessions WHERE token_hash=?', tokenHash)!
        .csrf;
    return {
      id: actor.id,
      matchId: actor.match_id,
      role: actor.role,
      name:
        actor.role === 'player' ? (this.db.player(actor.id).nickname ?? actor.name) : actor.name,
      permissions: JSON.parse(actor.permissions) as string[],
      csrfToken: csrf,
    };
  }
  result(actor: Actor, id: string): OperationResult {
    const row = this.db.one<{ result_json: string }>(
      'SELECT result_json FROM request_journal WHERE actor=? AND request_id=?',
      actor.id,
      id,
    );
    return row
      ? (JSON.parse(row.result_json) as OperationResult)
      : {
          requestId: id,
          status: 'pending',
          code: 'UNCONFIRMED',
          title: '结果待确认',
          message: '正在确认上一次操作的结果。',
        };
  }
  replay(actor: Actor, id: string, path: string, bodyDigest: string): OperationResult | null {
    const row = this.db.one<{
      digest: string | null;
      path: string | null;
      cancelled: number;
      result_json: string;
    }>('SELECT * FROM request_journal WHERE actor=? AND request_id=?', actor.id, id);
    if (!row) return null;
    if (!row.cancelled)
      requireThat(
        row.path === path && row.digest === bodyDigest,
        'REQUEST_ID_CONFLICT',
        '本次操作内容有变，请刷新后重新提交。',
      );
    return JSON.parse(row.result_json) as OperationResult;
  }
  saveResult(
    actor: Actor,
    id: string,
    path: string | null,
    bodyDigest: string | null,
    result: OperationResult,
    cancelled = 0,
  ): void {
    this.db.exec(
      'INSERT INTO request_journal(actor,request_id,path,digest,result_json,cancelled) VALUES(?,?,?,?,?,?)',
      actor.id,
      id,
      path,
      bodyDigest,
      JSON.stringify(result),
      cancelled,
    );
  }
  audit(actor: string, action: string, target: string, reason: string, detail: unknown = {}): void {
    this.db.exec(
      'INSERT INTO audit_logs(id,actor,action,target,reason,utc_ms,detail,game_ms) VALUES(?,?,?,?,?,?,?,?)',
      crypto.randomUUID(),
      actor,
      action,
      target,
      reason,
      this.now(),
      JSON.stringify(detail),
      this.game(),
    );
    const member = this.db.one<{ account_id: string; assignment_id: string | null; name: string }>(
      'SELECT account_id,assignment_id,name FROM memberships WHERE local_id=?',
      actor,
    );
    if (member)
      this.db.exec(
        'INSERT INTO audit_identities VALUES((SELECT MAX(seq) FROM audit_logs),?,?,?)',
        member.account_id,
        member.assignment_id,
        member.name,
      );
  }
  notice(source: string, target: string, title: string, body: string, game = this.game()): void {
    const trial =
      this.db.one<{ kind: string }>('SELECT kind FROM match_identity')?.kind === 'trial';
    const heading =
      title === '永久淘汰'
        ? body.includes('本次提交的手环颜色有误')
          ? '直接出局'
          : '维度跃迁'
        : title === '飞船被击毁'
          ? '飞船击毁'
          : title === '正式坐标广播'
            ? '坐标广播'
            : title === '统一开赛时间'
              ? '即将开赛'
              : title;
    const message = target === 'group' || /^C\d+$/.test(target) ? qqCopy(heading, body) : body;
    this.db.exec(
      'INSERT OR IGNORE INTO notice_queue(id,dedup_key,channel,target,title,body,game_ms,priority,ordering_seq) VALUES(?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(ordering_seq),0)+1 FROM notice_queue))',
      crypto.randomUUID(),
      `${source}|${target}|${title}`,
      target === 'group' ? 'group' : 'private',
      target,
      trial ? `【试玩】${title}` : title,
      trial ? `本场为试玩比赛。\n${message}` : message,
      game,
      title === '永久淘汰' ? 100 : title === '飞船被击毁' ? 90 : title === '母星毁灭' ? 80 : 0,
    );
  }
  identity(id: string): string {
    const p = this.db.player(id);
    return p.nickname ? `${id}（${p.nickname}）` : id;
  }
  async bootstrap(secret: string, raw: unknown): Promise<RpcReply> {
    requireThat(
      this.env.BOOTSTRAP_SECRET &&
        (await digest(secret)) === (await digest(this.env.BOOTSTRAP_SECRET)),
      'FORBIDDEN',
      '无法初始化。',
      403,
    );
    const body = strict(raw, ['match_id', 'accounts']);
    requireThat(body.match_id === this.matchId, 'MATCH_MISMATCH', '初始化场次不匹配。', 400);
    requireThat(
      Array.isArray(body.accounts) && body.accounts.length >= 5 && body.accounts.length <= 353,
      'BAD_ROSTER',
      '名单须包含2—350名玩家和3名独立裁判。',
      400,
    );
    const accounts = body.accounts.map((raw) => {
      const a = strict(raw, ['id', 'role', 'name', 'credential_hash', 'duty']);
      const id = text(a.id, 16);
      const role = text(a.role, 6);
      const name = text(a.name, 64);
      const hash = text(a.credential_hash, 44, 44);
      requireThat(
        /^[A-Za-z0-9+/]{43}=$/.test(hash),
        'BAD_CREDENTIAL_HASH',
        '凭证摘要格式不正确。',
        400,
      );
      requireThat(
        (role === 'player' && /^C\d{2,3}$/.test(id)) || (role === 'judge' && /^J\d{2}$/.test(id)),
        'BAD_ACCOUNT',
        '账号格式不正确。',
        400,
      );
      const duty = role === 'judge' ? text(a.duty, 20) : '';
      requireThat(
        role === 'player' || ['head', 'communications', 'events'].includes(duty),
        'BAD_DUTY',
        '裁判职责不正确。',
        400,
      );
      return {
        id,
        role,
        name,
        hash,
        duty,
        permissions:
          duty === 'head'
            ? HEAD
            : duty === 'communications'
              ? ['overview', 'homeworlds', 'notices', 'players', 'events', 'account']
              : duty === 'events'
                ? ['overview', 'notices', 'events', 'players', 'account']
                : [],
      };
    });
    for (const duty of ['head', 'communications', 'events'])
      requireThat(
        duty === 'head'
          ? accounts.filter((a) => a.duty === duty).length === 1
          : accounts.filter((a) => a.duty === duty).length <= 1,
        'BAD_DUTY',
        '需要一名总裁判，每种裁判职责最多设置一个账号。',
        400,
      );
    requireThat(
      new Set(accounts.map((a) => a.id)).size === accounts.length &&
        new Set(accounts.map((a) => a.hash)).size === accounts.length,
      'DUPLICATE_ACCOUNT',
      '账号与凭证须独立。',
      400,
    );
    const keys = await this.keys();
    this.db.tx(() => {
      requireThat(
        !this.db.one('SELECT id FROM matches'),
        'ALREADY_INITIALIZED',
        '本场已初始化，禁止覆盖。',
      );
      this.db.exec(
        'INSERT INTO matches(id,key_fingerprint,site_json,created_at) VALUES(?,?,?,?)',
        this.matchId,
        keys.fingerprint,
        JSON.stringify(DEFAULT_SITE),
        this.now(),
      );
      for (const a of accounts) {
        this.db.exec(
          'INSERT INTO accounts(id,match_id,role,name,credential_hash,permissions) VALUES(?,?,?,?,?,?)',
          a.id,
          this.matchId,
          a.role,
          a.name,
          a.hash,
          JSON.stringify(a.permissions),
        );
        if (a.role === 'player') {
          this.db.exec('INSERT INTO players(id) VALUES(?)', a.id);
          this.db.exec('INSERT INTO flights(player_id) VALUES(?)', a.id);
          this.db.exec('INSERT INTO attack_controls(player_id) VALUES(?)', a.id);
        }
      }
      this.db.exec(
        "INSERT INTO roster_members SELECT id FROM players WHERE entry_status='registered'",
      );
      this.audit('bootstrap', 'initialize', this.matchId, '一次性场次引导', {
        players: accounts.filter((a) => a.role === 'player').length,
      });
    });
    return {
      status: 201,
      body: { initialized: true, matchId: this.matchId, schemaVersion: SCHEMA_VERSION },
    };
  }
  async call(input: RpcInput): Promise<RpcReply> {
    try {
      return await this.handle(input);
    } catch (error) {
      if (error instanceof EventFailure) recordEventFailure(this, error);
      if (input.path.startsWith('/judge/command/') && input.token) {
        try {
          const actor = this.actor(await digest(input.token));
          if (actor.role === 'judge') {
            const body = object(input.body),
              id = typeof body.request_id === 'string' ? body.request_id.slice(0, 100) : 'unknown';
            const keys = await this.keys();
            const cipher =
              typeof body.command === 'string'
                ? await encrypt(
                    keys.encryption,
                    body.command,
                    `command|${this.matchId}|${actor.id}|${id}`,
                  )
                : null;
            let rejectedPath = 'unparsed';
            try {
              rejectedPath =
                commandSpec(parseCommandTree(String(body.command)))?.path ?? rejectedPath;
            } catch {
              /* Syntax rejection remains unparsed. */
            }
            recordCommand(
              this,
              actor,
              id,
              rejectedPath,
              'rejected',
              {
                code: error instanceof Fault ? error.code : 'BAD_REQUEST',
                reason: typeof body.reason === 'string' ? body.reason : '裁判指令被拒绝',
                reference: typeof body.preview_token === 'string' ? body.preview_token : null,
              },
              cipher,
            );
          }
        } catch {
          /* Preserve the original authentication or command error. */
        }
      }
      if (
        input.method === 'POST' &&
        input.path.startsWith('/judge/') &&
        !input.path.startsWith('/judge/command/') &&
        input.token
      ) {
        try {
          const actor = this.actor(await digest(input.token));
          if (actor.role === 'judge') {
            const body =
              input.body && typeof input.body === 'object'
                ? (input.body as Record<string, unknown>)
                : {};
            this.audit(
              actor.id,
              input.path,
              typeof body.target === 'string' ? body.target.slice(0, 180) : this.matchId,
              typeof body.reason === 'string' ? body.reason.slice(0, 500) : '管理操作失败',
              {
                requestId:
                  typeof body.request_id === 'string' ? body.request_id.slice(0, 100) : null,
                status: 'failed',
                error:
                  error instanceof Fault
                    ? error.code
                    : error instanceof ContractError
                      ? 'BAD_REQUEST'
                      : 'SERVICE_UNAVAILABLE',
              },
            );
          }
        } catch {
          /* A failed authentication must not expose or overwrite the original error. */
        }
      }
      if (error instanceof Fault)
        return {
          status: error.status,
          body: {
            code: error.code,
            message:
              error instanceof EventFailure ? '赛事暂时无法继续，请等待裁判处理。' : error.message,
            definitive: true,
          },
        };
      if (error instanceof ContractError || error instanceof CommandSyntaxError)
        return {
          status: 400,
          body: { code: 'BAD_REQUEST', message: error.message, definitive: true },
        };
      // No stack, credentials, SQL bindings, or secret body enters an HTTP error/log.
      return {
        status: 503,
        body: {
          code: 'SERVICE_UNAVAILABLE',
          message: '暂时无法连接，正在确认上一次操作的结果。',
          definitive: false,
        },
      };
    }
  }
  private settleForRequest(
    actor: Actor | null,
    path: string,
    body?: Record<string, unknown>,
  ): void {
    try {
      settleDue(this);
    } catch (error) {
      if (!(error instanceof EventFailure) || actor?.role !== 'judge') throw error;
      const url = new URL(path, 'https://internal');
      if (!body) {
        const scope = url.searchParams.get('route') ?? '';
        if (!(
          url.pathname.startsWith('/judge/') ||
          (url.pathname === '/snapshot' && scope.startsWith('/judge'))
        ))
          throw error;
        permission(actor, 'overview');
      } else {
        const action = path === '/judge/manage/preview' ? body.path : path;
        let commandAllowed = false;
        if (path.startsWith('/judge/command/') && typeof body.command === 'string') {
          let node = parseCommandTree(body.command);
          if (node.words[0] === 'confirm') {
            const plan = this.db.one<{ actor: string; data: string; status: string }>(
              "SELECT actor,data,status FROM command_objects WHERE id=? AND kind='plan'",
              node.words[1] ?? '',
            );
            if (plan?.actor === actor.id && plan.status === 'pending')
              node = (JSON.parse(plan.data) as { node: typeof node }).node;
          } else if (
            node.words[0] === 'plan' &&
            !['inspect', 'cancel'].includes(node.words[1] ?? '')
          ) {
            node = { ...node, words: node.words.slice(1) };
          }
          const spec = commandSpec(node);
          commandAllowed =
            !!spec &&
            (spec.query ||
              [
                'plan inspect',
                'plan cancel',
                'request inspect',
                'clock pause',
                'event retry',
                'event cancel',
                'scheduler rearm',
                'scheduler settle-due',
              ].includes(spec.path));
          if (commandAllowed) permission(actor, spec!.permission);
        }
        if (!(
          commandAllowed ||
          action === '/judge/pause' ||
          action === '/judge/event-control' ||
          action === '/judge/scheduler/rearm' ||
          action === '/judge/events/settle-due'
        ))
          throw error;
        if (!commandAllowed) permission(actor, 'system');
      }
      recordEventFailure(this, error);
    }
  }
  private requireRecoveryAccess(path: string, write = false): void {
    const state = this.db.match().recovery_state;
    requireThat(
      !state.startsWith('checkpoint:') && !state.startsWith('prepared:'),
      'RECOVERY_IN_PROGRESS',
      '正在恢复比赛，请稍后重新登录。',
      503,
    );
    requireThat(
      !write || !state || (!path.startsWith('/action/') && path !== '/player/nickname'),
      'RECOVERY_REVIEW',
      '裁判正在核对比赛恢复结果。',
    );
  }
  private async handle(input: RpcInput): Promise<RpcReply> {
    const { path, method } = input;
    const db = this.db;
    const keys = await this.keys();
    this.requireRecoveryAccess(path, method === 'POST');
    const creators = db
      .all<{ actor: string }>(
        "SELECT DISTINCT actor FROM command_objects WHERE kind IN ('schedule','job') AND status='pending'",
      )
      .map((r) => r.actor);
    if (path.startsWith('/judge/command/') || creators.length)
      this.commandPrepared = await this.prepareCode();
    if (creators.length) await prepareCommandCredentials(this, creators);
    requireThat(
      db.match().key_fingerprint === keys.fingerprint,
      'KEY_CONFIGURATION_CHANGED',
      '场次密钥配置发生变化，请联系总裁判恢复正确配置。',
      503,
    );
    if (path === '/auth/exchange' && method === 'POST') {
      requireThat(
        !db.one('SELECT id FROM match_identity'),
        'PLATFORM_LOGIN_REQUIRED',
        '请从长期账号入口登录。',
        401,
      );
      this.limit(`login:${input.clientKey}`, 120);
      const body = strict(input.body, ['credential', 'audience']);
      requireThat(
        body.audience === 'player' || body.audience === 'judge',
        'BAD_AUDIENCE',
        '登录入口不正确。',
        400,
      );
      const hash = await digest(text(body.credential, 128, 32));
      this.limit(`credential:${hash}`, 10);
      const sessionToken = token();
      const tokenHash = await digest(sessionToken);
      const csrf = token();
      return db.tx(() => {
        this.requireRecoveryAccess(path, true);
        const actor = db.one<Actor>(
          'SELECT * FROM accounts WHERE credential_hash=? AND role=? AND enabled=1',
          hash,
          body.audience as string,
        );
        requireThat(actor, 'INVALID_CREDENTIAL', '登录口令无效。', 401);
        db.exec(
          'INSERT INTO sessions VALUES(?,?,?,?,0)',
          tokenHash,
          actor.id,
          csrf,
          this.now() + 12 * 60 * 60_000,
        );
        return { status: 200, body: this.session(actor, tokenHash), sessionToken };
      });
    }
    const hash = input.token ? await digest(input.token) : '';
    this.requireRecoveryAccess(path, method === 'POST');
    let actor: Actor | null = null;
    if (hash) actor = this.actor(hash);
    if (path === '/auth/session' && method === 'GET')
      return { status: 200, body: actor ? this.session(actor, hash) : null };
    if (method === 'POST') {
      requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
      requireThat(
        input.csrf && input.csrf === this.session(actor, hash).csrfToken,
        'CSRF_REJECTED',
        '请刷新页面后重试。',
        403,
      );
    }
    if (path === '/auth/logout' && method === 'POST') {
      db.exec('UPDATE sessions SET revoked=1 WHERE token_hash=?', hash);
      return { status: 200, body: { loggedOut: true }, clearCookie: true };
    }
    this.limit(`readwrite:${actor?.id ?? input.clientKey}`, actor ? 300 : 90);
    if (method === 'GET') {
      if (/^\/operations\/[A-Za-z0-9_-]+$/.test(path))
        return { status: 200, body: readEndpoint(this, actor, path, keys) };
      if (path === '/judge/scheduler/health') {
        requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
        permission(actor, 'system');
        return { status: 200, body: readEndpoint(this, actor, path, keys) };
      }
      this.settleForRequest(actor, path);
      await rearm(this);
      this.requireRecoveryAccess(path);
      // All awaited preparation completes before this final synchronous snapshot transaction.
      if (actor) actor = this.actor(hash);
      const readUrl = new URL(path, 'https://internal');
      if (readUrl.pathname.startsWith('/judge/credentials/')) {
        requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
        permission(actor, 'system');
        const deliveryId = readUrl.pathname.slice('/judge/credentials/'.length);
        const row = db.one<{ actor: string; account_id: string; ciphertext: string }>(
          'SELECT * FROM credential_deliveries WHERE id=?',
          deliveryId,
        );
        requireThat(row && row.actor === actor.id, 'NOT_FOUND', '口令记录不存在。', 404);
        const credential = await decrypt(
          keys.encryption,
          row.ciphertext,
          `credential|${this.matchId}|${actor.id}|${deliveryId}`,
        );
        permission(this.actor(hash), 'system');
        return { status: 200, body: { accountId: row.account_id, credential } };
      }
      if (readUrl.pathname === '/judge/export') {
        requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
        const exported = await exportData(
          this,
          actor,
          readUrl.searchParams.get('kind') ?? 'report',
          keys,
        );
        await rearm(this);
        permission(
          this.actor(hash),
          ['backup', 'checkpoint'].includes(readUrl.searchParams.get('kind') ?? '')
            ? 'system'
            : readUrl.searchParams.get('kind') === 'audit'
              ? 'audit'
              : 'results',
        );
        return { status: 200, body: exported };
      }
      // Alarm registration is asynchronous; repeat the barrier after it.
      this.settleForRequest(actor, path);
      const body = db.tx(() => {
        if (path.startsWith('/snapshot')) {
          const scope = new URL(path, 'https://internal').searchParams.get('route') ?? '/';
          return projectSnapshot(
            this,
            actor,
            actor ? this.session(actor, hash) : null,
            scope,
            keys,
          );
        }
        return readEndpoint(this, actor, path, keys);
      });
      return { status: 200, body };
    }
    requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
    const body = object(input.body);
    const resolve = /^\/operations\/([A-Za-z0-9_-]+)\/resolve$/.exec(path);
    if (resolve) {
      strict(body, []);
      const id = requestId(resolve[1]);
      return db.tx(() => {
        const current = this.actor(hash);
        const existing = this.result(current, id);
        if (existing.status === 'complete') return { status: 200, body: existing };
        const cancelled: OperationResult = {
          requestId: id,
          status: 'complete',
          code: 'CANCELLED',
          title: '已确认未提交',
          message: '上一次操作未提交，你可以重新操作。',
        };
        this.saveResult(current, id, null, null, cancelled, 1);
        return { status: 200, body: cancelled };
      });
    }
    const id = requestId(body.request_id);
    const digestBody =
      path.startsWith('/judge/command/') && typeof body.command === 'string'
        ? {
            command: parseCommandTree(body.command),
            reason: body.reason ?? '',
            preview_token: body.preview_token ?? null,
          }
        : body;
    const bodyDigest = await digest(stableJson(digestBody));
    actor = this.actor(hash);
    const old = this.replay(actor, id, path, bodyDigest);
    if (old) return { status: 200, body: old };
    const commandCiphertext = path.startsWith('/judge/command/')
      ? await encrypt(
          keys.encryption,
          text(body.command, 262144),
          `command|${this.matchId}|${actor.id}|${id}`,
        )
      : null;
    if (path.startsWith('/judge/command/')) {
      await prepareCommandCredentials(this, [...creators, actor.id]);
    }
    const prepared =
      path.endsWith('issue-code') ||
      path === '/judge/attack-correction' ||
      path === '/judge/player-restore' ||
      (path === '/judge/correction' && body.field === 'restore') ||
      (path === '/judge/equipment-correction' && body.mode === 'reissue') ||
      path.startsWith('/judge/command/')
        ? path.startsWith('/judge/command/')
          ? this.commandPrepared
          : await this.prepareCode()
        : [];
    const credentialMaterial =
      path === '/judge/accounts' && body.operation === 'reset'
        ? await prepareCredential(this, actor.id)
        : undefined;
    const pendingEvents = db
      .all<{ id: string }>("SELECT id FROM scheduled_events WHERE status='pending'")
      .map((event) => event.id);
    this.settleForRequest(actor, path, body);
    const result = db.tx(() => {
      this.requireRecoveryAccess(path, true);
      const current = this.actor(hash);
      const replay = this.replay(current, id, path, bodyDigest);
      if (replay) return replay;
      let result: OperationResult;
      if (path.startsWith('/judge/command/'))
        result = commandAction(this, current, id, path, body, prepared, keys, commandCiphertext);
      else if (path === '/judge/manage/preview') result = previewAction(this, current, id, body);
      else if (path.startsWith('/judge/'))
        result = judgeAction(this, current, id, path, body, prepared, credentialMaterial);
      else if (path.startsWith('/action/') || path === '/player/nickname')
        result = playerAction(this, current, id, path, body, prepared, input.edgeUtc, keys);
      else throw new Fault(404, 'NOT_FOUND', '未找到这项操作。');
      if (
        [
          '/judge/events/settle-due',
          '/judge/scheduler/rearm',
          '/judge/event-control',
          '/judge/event-trigger',
        ].includes(path)
      )
        result.scheduler = {
          settledEvents: db
            .all<{ id: string }>("SELECT id FROM scheduled_events WHERE status='settled'")
            .map((event) => event.id)
            .filter(
              (event) =>
                pendingEvents.includes(event) || event.startsWith(`judge:${current.id}:${id}:`),
            ),
          remaining: db.one<{ count: number }>(
            "SELECT COUNT(*) AS count FROM scheduled_events WHERE status='pending'",
          )!.count,
        };
      this.saveResult(current, id, path, bodyDigest, result);
      return result;
    });
    await rearm(this);
    return { status: 200, body: result };
  }
  schedule(
    id: string,
    kind: string,
    clock: 'utc' | 'game',
    due: number,
    priority: number,
    payload: unknown = {},
  ): void {
    this.db.exec(
      'INSERT INTO scheduled_events(id,kind,clock,due,priority,payload) VALUES(?,?,?,?,?,?)',
      id,
      kind,
      clock,
      due,
      priority,
      JSON.stringify(payload),
    );
  }
  issue(actor: string, id: string, prepared: PreparedCode[]): CodeRow {
    const used = new Set(
      this.db.all<{ mac: string }>('SELECT mac FROM sighting_codes').map((c) => c.mac),
    );
    const candidates = prepared.filter((c) => !used.has(c.mac));
    requireThat(
      candidates.length,
      'CODEBOOK_EXHAUSTED',
      '本场手环配置已耗尽，请联系总裁判暂停处置。',
    );
    const code = candidates[uniformInt(candidates.length)]!;
    const flight = this.db.flight(actor);
    this.db.exec(
      'INSERT INTO sighting_codes(id,player_id,voyage,mac,ciphertext,status,issued_utc,request_id) VALUES(?,?,?,?,?,?,?,?)',
      code.id,
      actor,
      flight.voyage + 1,
      code.mac,
      code.ciphertext,
      'reserved',
      this.now(),
      id,
    );
    this.db.exec('UPDATE flights SET code_id=?,voyage=voyage+1 WHERE player_id=?', code.id, actor);
    const remaining = 350 - used.size - 1;
    if ([20, 10, 0].includes(remaining))
      this.notice(
        `capacity:${remaining}`,
        'J01',
        '手环码容量预警',
        `剩余可发行配置${remaining}枚，请总裁判核查。`,
      );
    return this.db.one<CodeRow>('SELECT * FROM sighting_codes WHERE id=?', code.id)!;
  }
}
export function completed(
  id: string,
  title: string,
  message = title,
  extra: Partial<OperationResult> = {},
): OperationResult {
  return { requestId: id, status: 'complete', title, message, ...extra };
}
export { coordinate, integer, permission };
