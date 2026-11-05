import type { DarkForestMatch } from '../index';
export interface BackendEnv {
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  APP_ENV: string;
  MATCH_ID: string;
  CODE_HMAC_KEY?: string;
  CODE_ENCRYPTION_KEY?: string;
  BOOTSTRAP_SECRET?: string;
  MATCH_DO: DurableObjectNamespace<DarkForestMatch>;
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
