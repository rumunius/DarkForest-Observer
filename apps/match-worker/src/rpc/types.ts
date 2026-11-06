import type {DarkForestMatch} from '../index';
import type {DarkForestPlatform} from '../platform/platform';

/** Worker绑定、环境和秘密的服务端类型；不能传递到前端公共契约。 */
export interface BackendEnv {
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  APP_ENV: string;
  MATCH_ID: string;
  CODE_HMAC_KEY?: string;
  CODE_ENCRYPTION_KEY?: string;
  BOOTSTRAP_SECRET?: string;
  MATCH_DO: DurableObjectNamespace<DarkForestMatch>;
  PLATFORM_DO?: DurableObjectNamespace<DarkForestPlatform>;
  PLATFORM_BOOTSTRAP_SECRET?: string;
}
/** 平台签发给某场的账号与岗位授权，消费时须核对本场持久映射。 */
export interface MatchGrant {
  accountId: string;
  authEpoch: number;
  matchId: string;
  csrf: string;
  expires: number;
  audience: 'player' | 'staff';
}
/** 网关转交的内部请求；身份令牌、请求体和边缘时间不替代本场校验。 */
export interface RpcInput {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  token?: string;
  csrf?: string;
  edgeUtc: number;
  clientKey: string;
}
/** 内部RPC响应及会话变更提示，由网关转换成私有HTTP响应。 */
export interface RpcReply {
  status: number;
  body: unknown;
  sessionToken?: string;
  clearCookie?: boolean;
}
