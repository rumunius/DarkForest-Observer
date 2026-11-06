import type {BackendEnv} from '../rpc/types';
import {digest} from '../security/crypto';
import {requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import type {Directory} from './types';

/** Inspect up to fifty current official matches before allowing a release. */
export async function checkMaintenanceRelease(
  host: DarkForestPlatform,
  environment: BackendEnv,
): Promise<string> {
  const matches = host.db.all<Directory>(
    "SELECT * FROM match_directory WHERE kind='official' AND state IN ('available','archiving','archived','purge_pending') LIMIT 51",
  );
  requireThat(
    matches.length <= 50,
    'RELEASE_CHECK_LIMIT',
    '正式比赛数量超过本次检查范围，请分批完成维护核对后再发布。',
  );
  const checked = [];
  for (const d of matches) {
    const state = await host.summary(d, 'root-maintainer');
    checked.push({
      id: d.id,
      name: d.name,
      kind: d.kind,
      summary: {phase: state.phase},
    });
  }
  return JSON.stringify({environment: environment.APP_ENV, matches: checked});
}

/** Read deployment and queue diagnostics without creating a maintenance operation. */
export async function maintenanceDiagnostics(
  environment: BackendEnv,
  host: DarkForestPlatform,
  state: DurableObjectState,
): Promise<string> {
  return JSON.stringify({
    environment: environment.APP_ENV,
    version: environment.CF_VERSION_METADATA?.id ?? 'local',
    platformSchema: 1,
    matchSchema: 8,
    matches: host.db.all<Record<string, SqlStorageValue>>(
      'SELECT id,name,kind,state,object_name,summary FROM match_directory',
    ),
    operations: host.db.all<Record<string, SqlStorageValue>>(
      "SELECT id,action,target,status,error FROM platform_operations WHERE status!='succeeded'",
    ),
    bindingFingerprint: await digest(
      `${environment.APP_ENV}|${state.id.toString()}|${environment.MATCH_DO.idFromName('match:binding-probe').toString()}`,
    ),
  });
}
