import { DurableObject } from 'cloudflare:workers';

// Deployment shell only: no RPC methods, HTTP handler, SQL, or alarms.
export class DarkForestMatch extends DurableObject {}

export default {} satisfies ExportedHandler<MatchWorkerEnv>;
