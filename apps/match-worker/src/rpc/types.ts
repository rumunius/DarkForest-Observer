import type { DarkForestMatch } from '../index';
import type { DarkForestPlatform } from '../platform/platform';
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
export interface MatchGrant {
  accountId: string;
  authEpoch: number;
  matchId: string;
  csrf: string;
  expires: number;
  audience: 'player' | 'staff';
}
export interface RpcInput {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  token?: string;
  csrf?: string;
  edgeUtc: number;
  clientKey: string;
}
export interface RpcReply {
  status: number;
  body: unknown;
  sessionToken?: string;
  clearCookie?: boolean;
}
