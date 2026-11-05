import { gateway, type GatewayEnv } from './_lib/gateway';
export const onRequest: PagesFunction<GatewayEnv> = (context) => {
  const path = new URL(context.request.url).pathname;
  return path === '/api' || path.startsWith('/api/')
    ? gateway(context.request, context.env)
    : context.next();
};
