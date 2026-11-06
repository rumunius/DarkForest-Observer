import type {RpcInput} from '../rpc/types';
import type {Login} from './types';

/** 仅在服务端处理链内传递的已认证请求，不作为HTTP响应或持久负载。 */
export interface AuthenticatedRequest {
  input: RpcInput;
  path: string;
  session: Login;
  hash: string;
  requestPayload: Record<string, unknown>;
}
/** 经过共同鉴权、正文摘要和预览检查的平台写入上下文。 */
export interface PlatformMutation extends AuthenticatedRequest {
  id: string;
  reason: string;
  bodyHash: string;
}
