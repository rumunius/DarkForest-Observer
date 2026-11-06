import {parseJson} from '../../../packages/contracts/src/backend';
import {DurableObject} from 'cloudflare:workers';
import {Engine} from './services/engine';
import {Store} from './storage/store';
import {migrate} from './storage/schema';
import {
  EventFailure,
  recordEventFailure,
  rearm,
  settleDue,
} from './scheduler/events';
import type {BackendEnv, MatchGrant, RpcInput, RpcReply} from './rpc/types';
import {matchControl, type ControlRequest} from './platform/match_control';
import {controlSignature} from './platform/security';
import {Fault, requireThat} from './storage/store';
import {stableJson} from '../../../packages/contracts/src/backend';
export {DarkForestPlatform} from './platform/platform';
import {configureRestore, recoveryRpc} from './services/recovery';
import {prepareCommandCredentials} from './services/commands';
import {createCheckpoint} from './services/recovery';

export class DarkForestMatch extends DurableObject<BackendEnv> {
  private engine: Engine;
  constructor(ctx: DurableObjectState, env: BackendEnv) {
    super(ctx, env);
    migrate(ctx.storage);
    this.engine = new Engine(new Store(ctx.storage), env);
  }
  private scopedEngine(grant?: MatchGrant): Engine {
    const name = this.ctx.id.name;
    const id = name?.startsWith('match:') ? name.slice(6) : this.engine.matchId;
    return new Engine(
      new Store(this.ctx.storage),
      {...this.env, MATCH_ID: id},
      grant,
    );
  }
  async control(request: ControlRequest, signature: string): Promise<string> {
    try {
      const reply = JSON.stringify(
        await matchControl(this.scopedEngine(), this.env, request, signature),
      );
      if (request.action === 'history-record') {
        requireThat(
          new TextEncoder().encode(reply).byteLength <= 8 * 1024 * 1024,
          'HISTORY_SIZE_LIMIT',
          '这份资料超过单次下载上限。请先保存战报，其他资料请联系网站维护人员。',
          413,
        );
      }
      return reply;
    } catch (error) {
      return JSON.stringify({
        controlError: true,
        status: error instanceof Fault ? error.status : 503,
        code: error instanceof Fault ? error.code : 'CONTROL_UNAVAILABLE',
        message:
          error instanceof Fault
            ? error.message
            : '本场管理操作暂未完成，请查询原操作结果。',
      });
    }
  }
  async legacyInventory(matchId: string, signature: string): Promise<string> {
    requireThat(
      signature ===
        (await controlSignature(
          this.env,
          stableJson({action: 'legacy-inventory', matchId}),
        )),
      'FORBIDDEN',
      '内部迁移授权无效。',
      403,
    );
    const e = this.scopedEngine();
    requireThat(e.matchId === matchId, 'MATCH_MISMATCH', '旧比赛编号不匹配。');
    const m = e.db.match();
    requireThat(
      m.phase === 'setup' || m.phase === 'ended' || m.paused_at !== null,
      'PAUSE_REQUIRED',
      '请先由总裁判暂停旧比赛。',
    );
    return JSON.stringify({
      id: m.id,
      phase: m.phase,
      revision: m.revision,
      accounts: e.db.all(
        'SELECT id,role,name,credential_hash,permissions FROM accounts',
      ),
      issued: e.db.one('SELECT COUNT(*) AS count FROM sighting_codes'),
      checkpoint: await createCheckpoint(e),
    });
  }
  async authorized(input: RpcInput, grant: MatchGrant, signature: string) {
    try {
      requireThat(
        signature ===
          (await controlSignature(this.env, stableJson({input, grant}))),
        'FORBIDDEN',
        '内部授权无效。',
        403,
      );
      const engine = this.scopedEngine(grant);
      // Check before any business preparation; Engine rechecks local fences at commit.
      engine.actor('platform');
      await this.authorizeTasks(engine);
      const reply = await engine.call(input);
      return {
        ...reply,
        body: JSON.stringify(reply.body),
        workerVersion: this.env.CF_VERSION_METADATA?.id ?? 'local',
      };
    } catch (error) {
      return {
        status: error instanceof Fault ? error.status : 503,
        body: JSON.stringify({
          code: error instanceof Fault ? error.code : 'MATCH_UNAVAILABLE',
          message:
            error instanceof Fault
              ? error.message
              : '本场暂时无法操作，请稍后查询原操作结果。',
          definitive: error instanceof Fault,
        }),
        workerVersion: this.env.CF_VERSION_METADATA?.id ?? 'local',
      };
    }
  }
  private async authorizeTasks(engine: Engine) {
    if (!engine.db.one('SELECT id FROM match_identity')) {
      return;
    }
    for (const row of engine.db.all<{actor: string; account_id: string}>(
      "SELECT DISTINCT c.actor,m.account_id FROM command_objects c JOIN memberships m ON m.local_id=c.actor AND m.state='bound' WHERE c.kind IN ('schedule','job') AND c.status='pending'",
    )) {
      try {
        if (
          await this.env.PLATFORM_DO?.getByName('platform:primary').taskAllowed(
            row.account_id,
            engine.matchId,
          )
        ) {
          engine.taskAuthorization.add(row.actor);
        }
      } catch {
        /* Natural events continue; management jobs require a fresh authorization. */
      }
    }
  }
  async call(
    input: RpcInput,
  ): Promise<Omit<RpcReply, 'body'> & {body: string; workerVersion: string}> {
    const reply = await this.engine.call(input);
    return {
      ...reply,
      body: JSON.stringify(reply.body),
      workerVersion: this.env.CF_VERSION_METADATA?.id ?? 'local',
    };
  }
  async bootstrap(
    secret: string,
    body: unknown,
  ): Promise<Omit<RpcReply, 'body'> & {body: string}> {
    try {
      const reply = await this.engine.bootstrap(secret, body);
      return {...reply, body: JSON.stringify(reply.body)};
    } catch (error) {
      if (error instanceof Error && 'status' in error && 'code' in error) {
        return {
          status: error.status as number,
          body: JSON.stringify({code: error.code, message: error.message}),
        };
      }
      return {
        status: 400,
        body: JSON.stringify({
          code: 'BOOTSTRAP_FAILED',
          message: '初始化失败，请核对配置与名单。',
        }),
      };
    }
  }
  async alarm(): Promise<void> {
    this.engine = this.scopedEngine();
    await this.authorizeTasks(this.engine);
    const keys = await this.engine.keys();
    if (keys.fingerprint !== this.engine.db.match().key_fingerprint) {
      throw new Error('KEY_CONFIGURATION_CHANGED');
    }
    if (
      this.engine.db.one(
        "SELECT id FROM scheduled_events WHERE status='pending' AND kind IN ('judge_command_task','judge_command_job')",
      )
    ) {
      this.engine.commandPrepared = await this.engine.prepareCode();
      await prepareCommandCredentials(
        this.engine,
        this.engine.db
          .all<{actor: string}>(
            "SELECT DISTINCT actor FROM command_objects WHERE kind IN ('schedule','job') AND status='pending'",
          )
          .map(r => r.actor),
      );
    }
    try {
      settleDue(this.engine);
    } catch (error) {
      if (error instanceof EventFailure) {
        recordEventFailure(this.engine, error);
      }
      throw error;
    }
    await rearm(this.engine);
  }
  async recovery(
    secret: string,
    raw: unknown,
    platformSignature?: string,
  ): Promise<{status: number; body: string}> {
    this.engine = this.scopedEngine();
    try {
      if (this.engine.db.one('SELECT id FROM match_identity')) {
        requireThat(
          platformSignature ===
            (await controlSignature(
              this.env,
              stableJson({matchId: this.engine.matchId, raw}),
            )),
          'PLATFORM_RECOVERY_REQUIRED',
          '跨比赛恢复请使用中文运维向导，先保存材料并核对清理记录。',
          403,
        );
      }
      const body = raw as {operation: string; payload?: unknown};
      if (body.operation === 'launch') {
        requireThat(
          !this.engine.db.one(
            'SELECT id FROM match_identity WHERE erasure_generation>0',
          ),
          'RESTORE_EXPIRED',
          '本场资料已清理，不能恢复旧检查点。',
          410,
        );
        await recoveryRpc(this.engine, secret, {operation: 'status'});
        await configureRestore(this.engine, body.payload);
        this.ctx.abort('Requested point-in-time restoration');
      }
      return {
        status: 200,
        body: JSON.stringify(await recoveryRpc(this.engine, secret, raw)),
      };
    } catch (error) {
      if (error instanceof Error && 'status' in error) {
        return {
          status: error.status as number,
          body: JSON.stringify({
            code: 'code' in error ? error.code : 'RECOVERY_FAILED',
            message: error.message,
          }),
        };
      }
      return {
        status: 409,
        body: JSON.stringify({
          code: 'RECOVERY_FAILED',
          message: '恢复操作未完成，请核对恢复材料与状态。',
        }),
      };
    }
  }
}
export default {
  async fetch(request, env) {
    // Only the local CLI uses HTTP; cloud access is exclusively an internal binding.
    if (
      env.APP_ENV !== 'local' ||
      new URL(request.url).pathname !== '/__bootstrap' ||
      request.method !== 'POST'
    ) {
      return Response.json({code: 'NOT_FOUND'}, {status: 404});
    }
    if (Number(request.headers.get('content-length') ?? 0) > 65536) {
      return Response.json({code: 'BODY_TOO_LARGE'}, {status: 413});
    }
    const input = await request.text();
    if (new TextEncoder().encode(input).length > 65536) {
      return Response.json({code: 'BODY_TOO_LARGE'}, {status: 413});
    }
    const reply = await env.MATCH_DO.getByName(
      `match:${env.MATCH_ID}`,
    ).bootstrap(
      request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
      parseJson(input),
    );
    return new Response(reply.body, {
      status: reply.status,
      headers: {'Content-Type': 'application/json'},
    });
  },
} satisfies ExportedHandler<BackendEnv>;
