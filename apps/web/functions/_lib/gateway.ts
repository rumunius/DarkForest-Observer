import type { DarkForestMatch } from '../../../match-worker/src/index';
import type { RpcInput } from '../../../match-worker/src/rpc/types';
export interface GatewayEnv {
  APP_ENV: string;
  MATCH_ID: string;
  TRUSTED_ORIGINS: string;
  MATCH_DO: DurableObjectNamespace<DarkForestMatch>;
}
const MAX_BODY = 16_384;
const HEADERS = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  Vary: 'Cookie, Origin',
};
function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
}
function fail(status: number, code: string, message: string): Response {
  return json({ code, message, definitive: true }, status);
}
export async function gateway(request: Request, env: GatewayEnv): Promise<Response> {
  const edgeUtc = Date.now();
  if (!['GET', 'POST'].includes(request.method))
    return fail(405, 'METHOD_NOT_ALLOWED', '请求方式不支持。');
  if (!env.MATCH_ID || !env.TRUSTED_ORIGINS)
    return fail(503, 'ENTRY_NOT_CONFIGURED', '服务尚未配置完成。');
  const url = new URL(request.url);
  const bootstrap = url.pathname === '/api/bootstrap' && env.APP_ENV === 'preview';
  const recovery = url.pathname === '/api/recovery';
  const bodyLimit = recovery ? 32_000_000 : bootstrap ? 65_536 : MAX_BODY;
  const origins = env.TRUSTED_ORIGINS.split(',').map((v) => v.trim());
  if (request.method === 'POST') {
    const origin = request.headers.get('origin');
    if (!origin || !origins.includes(origin))
      return fail(403, 'ORIGIN_REJECTED', '请从活动网站提交操作。');
    if (request.headers.get('sec-fetch-site') === 'cross-site')
      return fail(403, 'ORIGIN_REJECTED', '请从活动网站提交操作。');
    if (
      request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      return fail(415, 'JSON_REQUIRED', '请求须使用JSON格式。');
  }
  if (Number(request.headers.get('content-length') ?? 0) > bodyLimit)
    return fail(413, 'BODY_TOO_LARGE', '提交内容过长。');
  let body: unknown;
  if (request.method === 'POST') {
    try {
      const reader = request.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > bodyLimit) {
            await reader.cancel();
            return fail(413, 'BODY_TOO_LARGE', '提交内容过长。');
          }
          chunks.push(part.value);
        }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      return fail(400, 'BAD_JSON', '提交内容格式不正确。');
    }
  }
  if ((bootstrap || recovery) && request.method === 'POST') {
    const secret = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return fail(403, 'FORBIDDEN', '无法初始化。');
    try {
      const target = env.MATCH_DO.getByName(`match:${env.MATCH_ID}`);
      const reply = recovery
        ? await target.recovery(secret, body)
        : await target.bootstrap(secret, body);
      return json(JSON.parse(reply.body), reply.status);
    } catch {
      return fail(503, 'BOOTSTRAP_UNAVAILABLE', '初始化服务暂时不可用。');
    }
  }
  const cookieName = env.APP_ENV === 'local' ? 'df_session_local' : '__Host-df_session';
  const cookies =
    request.headers
      .get('cookie')
      ?.split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(`${cookieName}=`)) ?? [];
  if (cookies.length > 1) return fail(400, 'AMBIGUOUS_COOKIE', '请清除本站Cookie后重新登录。');
  const sessionToken = cookies[0]?.slice(cookieName.length + 1);
  if (sessionToken && !/^[A-Za-z0-9_-]{43}$/.test(sessionToken))
    return fail(401, 'UNAUTHENTICATED', '请重新登录。');
  const path = `${url.pathname.slice(4)}${url.search}`;
  const input: RpcInput = {
    method: request.method as 'GET' | 'POST',
    path,
    edgeUtc,
    clientKey: request.headers.get('cf-connecting-ip') ?? 'local',
    ...(body === undefined ? {} : { body }),
    ...(sessionToken ? { token: sessionToken } : {}),
    ...(request.headers.get('x-csrf-token') ? { csrf: request.headers.get('x-csrf-token')! } : {}),
  };
  try {
    const reply = await env.MATCH_DO.getByName(`match:${env.MATCH_ID}`).call(input);
    const secure = env.APP_ENV === 'local' ? '' : '; Secure';
    const cookie = reply.sessionToken
      ? `${cookieName}=${reply.sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`
      : reply.clearCookie
        ? `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
        : undefined;
    return json(JSON.parse(reply.body), reply.status, {
      ...(cookie ? { 'Set-Cookie': cookie } : {}),
      'X-Darkforest-Worker-Version': reply.workerVersion ?? 'unreported',
    });
  } catch {
    return json(
      { code: 'SERVICE_UNAVAILABLE', message: '连接暂时中断，请重新连接。', definitive: false },
      503,
    );
  }
}
