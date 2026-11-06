import type {BackendEnv} from '../rpc/types';
import type {DarkForestPlatform} from './platform';
/** Maintenance request materials captured after independent-secret authentication and operation validation. */
export interface MaintenanceContext {
  readonly host: DarkForestPlatform;
  readonly environment: BackendEnv;
  readonly requestPayload: Record<string, unknown>;
  readonly id: string;
  readonly reason: string;
  readonly hash: string;
}
