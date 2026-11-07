import type {BackendEnv} from '../../apps/match-worker/src/rpc/types';

declare global {
  namespace Cloudflare {
    // vitest.workers.config.ts supplies these bindings and the Wrangler DO classes.
    interface Env extends BackendEnv {
      PLATFORM_DO: NonNullable<BackendEnv['PLATFORM_DO']>;
    }
  }
}
