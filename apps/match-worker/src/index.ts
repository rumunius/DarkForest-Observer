import { DurableObject } from 'cloudflare:workers';
import { Engine } from './services/engine';
import { Store } from './storage/store';
import { migrate } from './storage/schema';
import { EventFailure, recordEventFailure, rearm, settleDue } from './scheduler/events';
import type { BackendEnv, RpcInput, RpcReply } from './rpc/types';
import { configureRestore, recoveryRpc } from './services/recovery';

export class DarkForestMatch extends DurableObject<BackendEnv> {
  private engine: Engine;
  constructor(ctx: DurableObjectState, env: BackendEnv) {
    super(ctx, env);
    migrate(ctx.storage);
    this.engine = new Engine(new Store(ctx.storage), env);
  }
  async call(
    input: RpcInput,
  ): Promise<Omit<RpcReply, 'body'> & { body: string; workerVersion: string }> {
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
  ): Promise<Omit<RpcReply, 'body'> & { body: string }> {
    try {
      const reply = await this.engine.bootstrap(secret, body);
      return { ...reply, body: JSON.stringify(reply.body) };
    } catch (error) {
      if (error instanceof Error && 'status' in error && 'code' in error)
        return {
          status: error.status as number,
          body: JSON.stringify({ code: error.code, message: error.message }),
        };
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
    const keys = await this.engine.keys();
    if (keys.fingerprint !== this.engine.db.match().key_fingerprint)
      throw new Error('KEY_CONFIGURATION_CHANGED');
    try {
      settleDue(this.engine);
    } catch (error) {
      if (error instanceof EventFailure) recordEventFailure(this.engine, error);
      throw error;
    }
    await rearm(this.engine);
  }
  async recovery(secret: string, raw: unknown): Promise<{ status: number; body: string }> {
    try {
      const body = raw as { operation: string; payload?: unknown };
      if (body.operation === 'launch') {
        await recoveryRpc(this.engine, secret, { operation: 'status' });
        await configureRestore(this.engine, body.payload);
        this.ctx.abort('Requested point-in-time restoration');
      }
      return { status: 200, body: JSON.stringify(await recoveryRpc(this.engine, secret, raw)) };
    } catch (error) {
      if (error instanceof Error && 'status' in error)
        return {
          status: error.status as number,
          body: JSON.stringify({
            code: 'code' in error ? error.code : 'RECOVERY_FAILED',
            message: error.message,
          }),
        };
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
    )
      return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
    if (Number(request.headers.get('content-length') ?? 0) > 65536)
      return Response.json({ code: 'BODY_TOO_LARGE' }, { status: 413 });
    const input = await request.text();
    if (new TextEncoder().encode(input).length > 65536)
      return Response.json({ code: 'BODY_TOO_LARGE' }, { status: 413 });
    const reply = await env.MATCH_DO.getByName(`match:${env.MATCH_ID}`).bootstrap(
      request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '',
      JSON.parse(input),
    );
    return new Response(reply.body, {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  },
} satisfies ExportedHandler<BackendEnv>;
