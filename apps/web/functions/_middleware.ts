import {gateway, type GatewayEnv} from './_lib/gateway';
/** Pages固定中间件入口，将API交给网关并保留静态资源的框架流程。 */
export const onRequest: PagesFunction<GatewayEnv> = context => {
  const path = new URL(context.request.url).pathname;
  return path === '/api' || path.startsWith('/api/')
    ? gateway(context.request, context.env)
    : context.next();
};
