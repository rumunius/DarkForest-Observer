import type { DarkForestMatch } from '../../../match-worker/src/index';
import type { RpcInput } from '../../../match-worker/src/rpc/types';
import type { DarkForestPlatform } from '../../../match-worker/src/platform/platform';
export interface GatewayEnv {
  APP_ENV: string;
  MATCH_ID: string;
  TRUSTED_ORIGINS: string;
  MATCH_DO: DurableObjectNamespace<DarkForestMatch>;
  PLATFORM_DO?: DurableObjectNamespace<DarkForestPlatform>;
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
    return fail(405, 'METHOD_NOT_ALLOWED', '无法提交这项操作，请刷新后重试。');
  if (!env.MATCH_ID || !env.TRUSTED_ORIGINS)
    return fail(503, 'ENTRY_NOT_CONFIGURED', '活动网站尚未准备好，请联系主办方。');
  const url = new URL(request.url);
  const bootstrap = url.pathname === '/api/bootstrap' && env.APP_ENV === 'preview';
  const recovery = url.pathname === '/api/recovery';
  // JSON escaping can expand a legal 256KiB command; command bytes are checked again in the DO.
  const command = /^\/api\/(?:matches\/[A-Za-z0-9_-]+\/)?judge\/command\/(preview|execute)$/.test(
    url.pathname,
  );
  const platformMaintenance =
    url.pathname === '/api/install' || url.pathname === '/api/maintenance';
  const bodyLimit =
    recovery || url.pathname === '/api/maintenance'
      ? 32_000_000
      : bootstrap
        ? 65_536
        : command
          ? 6 * 262144 + 16384
          : MAX_BODY;
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
      return fail(415, 'JSON_REQUIRED', '提交内容格式不正确，请刷新后重试。');
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
  if (platformMaintenance && request.method === 'POST') {
    if (!env.PLATFORM_DO) return fail(503, 'PLATFORM_NOT_CONFIGURED', '平台绑定尚未配置。');
    const secret = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return fail(403, 'FORBIDDEN', '维护授权无效。');
    try {
      const platform = env.PLATFORM_DO.getByName('platform:primary');
      return json(
        JSON.parse(
          url.pathname === '/api/install'
            ? await platform.bootstrap(secret, body)
            : await platform.maintenance(secret, body),
        ),
        200,
      );
    } catch (error) {
      return fail(
        409,
        'MAINTENANCE_REJECTED',
        error instanceof Error ? error.message : '维护操作未完成，请查看原任务状态。',
      );
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
  const platformPath =
    !!env.PLATFORM_DO &&
    /^\/api\/(auth(?:\/|$)|me(?:\/|$)|platform(?:\/|$)|matches(?:\/|$))/.test(url.pathname);
  const audience =
    url.pathname.startsWith('/api/platform/') ||
    request.headers.get('x-darkforest-audience') === 'staff' ||
    (body &&
      typeof body === 'object' &&
      'audience' in body &&
      ['staff', 'judge'].includes(String(body.audience)))
      ? 'staff'
      : 'player';
  const cookieName = platformPath
    ? env.APP_ENV === 'local'
      ? `df_${audience}_local`
      : `__Host-df_${audience}`
    : env.APP_ENV === 'local'
      ? 'df_session_local'
      : '__Host-df_session';
  const cookies =
    request.headers
      .get('cookie')
      ?.split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(`${cookieName}=`)) ?? [];
  if (cookies.length > 1)
    return fail(400, 'AMBIGUOUS_COOKIE', '请在浏览器中清除本站的登录信息，再重新登录。');
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
    if (env.PLATFORM_DO && !platformPath && !sessionToken)
      return fail(409, 'MATCH_REQUIRED', '请从「我的比赛」选择要进入的比赛。');
    if (env.PLATFORM_DO && !platformPath) {
      const check = await env.MATCH_DO.getByName(`match:${env.MATCH_ID}`).call({
        ...input,
        method: 'GET',
        path: '/auth/session',
      });
      if (check.status !== 200 || !JSON.parse(check.body))
        return fail(401, 'UNAUTHENTICATED', '请重新登录后选择比赛。');
    }
    const reply = platformPath
      ? await env.PLATFORM_DO!.getByName('platform:primary').call(input)
      : await env.MATCH_DO.getByName(`match:${env.MATCH_ID}`).call(input);
    const secure = env.APP_ENV === 'local' ? '' : '; Secure';
    const cookie = reply.sessionToken
      ? `${cookieName}=${reply.sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`
      : reply.clearCookie
        ? `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
        : undefined;
    return json(JSON.parse(reply.body), reply.status, {
      ...(cookie ? { 'Set-Cookie': cookie } : {}),
      'X-Darkforest-Worker-Version':
        'workerVersion' in reply ? String(reply.workerVersion ?? 'unreported') : 'platform',
    });
  } catch {
    return json(
      { code: 'SERVICE_UNAVAILABLE', message: '连接暂时中断，请重新连接。', definitive: false },
      503,
    );
  }
}
