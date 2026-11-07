import {
  object,
  requestId,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import type {BackendEnv} from '../rpc/types';
import {digest, encrypt, token} from '../security/crypto';
import {Fault, requireThat} from '../storage/store';
import type {MaintenanceContext} from './maintenance_context';
import {
  checkMaintenanceRelease,
  maintenanceDiagnostics,
} from './maintenance_diagnostics';
import {
  adoptLegacyPlatformMatch,
  inspectLegacyMatch,
} from './maintenance_legacy';
import {deliverOwnerRescue, rescuePlatformOwner} from './maintenance_owner';
import {recordCarryReceipt, recoverPlatformMatch} from './maintenance_recovery';
import type {DarkForestPlatform} from './platform';
import {platformKey} from './security';

/** 核对独立维护秘密后首次安装平台所有者，重复安装保持拒绝。 */
export async function bootstrap(
  host: DarkForestPlatform,
  environment: BackendEnv,
  secret: string,
  raw: unknown,
): Promise<string> {
  const expected =
    environment.PLATFORM_BOOTSTRAP_SECRET ??
    (environment.APP_ENV === 'local'
      ? environment.BOOTSTRAP_SECRET
      : undefined);
  requireThat(
    expected && (await digest(secret)) === (await digest(expected)),
    'FORBIDDEN',
    '安装授权无效。',
    403,
  );
  const payload = object(raw);
  const name = text(payload.name, 100);
  const id = crypto.randomUUID();
  const invitation = token();
  const invitationId = crypto.randomUUID();
  const ciphertext = await encrypt(
    await platformKey(environment),
    invitation,
    `invitation|${invitationId}`,
  );
  const invitationHash = await digest(invitation);
  host.db.tx(() => {
    requireThat(
      !host.db.one<Record<string, SqlStorageValue>>(
        "SELECT key FROM platform_meta WHERE key='installed'",
      ),
      'ALREADY_INSTALLED',
      '平台已安装；所有者失联请使用独立救援流程。',
    );
    host.db.exec(
      "INSERT INTO platform_accounts(id,kind,name,status,created_utc) VALUES(?,'staff',?,'pending',?)",
      id,
      name,
      host.now(),
    );
    host.db.exec("INSERT INTO platform_roles VALUES(?,'owner')", id);
    host.db.exec(
      'INSERT INTO invitations VALUES(?,?,?,?,0,?,?,?)',
      invitationId,
      id,
      invitationHash,
      host.now() + 7 * 86400000,
      ciphertext,
      host.now() + 86400000,
      'installer',
    );
    host.db.exec("INSERT INTO platform_meta VALUES('installed','1')");
    host.audit('installer', 'install', id, '首次建立平台所有者');
  });
  return JSON.stringify({
    accountId: id,
    invitationId,
    invitation,
    expiresUtc: host.now() + 7 * 86400000,
    environment: environment.APP_ENV,
  });
}

/** 执行经过独立秘密认证的救援、旧场接入或恢复协议，保留持久收据。 */
export async function maintenance(
  host: DarkForestPlatform,
  environment: BackendEnv,
  state: DurableObjectState,
  secret: string,
  raw: unknown,
): Promise<string> {
  requireThat(
    environment.PLATFORM_BOOTSTRAP_SECRET &&
      (await digest(secret)) ===
        (await digest(environment.PLATFORM_BOOTSTRAP_SECRET)),
    'FORBIDDEN',
    '独立维护凭据无效。',
    403,
  );
  const requestPayload = object(raw);
  const operation = text(requestPayload.operation, 100);
  if (operation === 'release-check') {
    return checkMaintenanceRelease(host, environment);
  }
  if (operation === 'diagnostics') {
    return maintenanceDiagnostics(environment, host, state);
  }
  const id = requestId(requestPayload.operationId);
  const reason = text(requestPayload.reason, 500);
  const hash = await digest(stableJson(requestPayload));
  const context: MaintenanceContext = {
    host,
    environment,
    requestPayload,
    id,
    reason,
    hash,
  };
  if (operation === 'rescue-owner') {
    return rescuePlatformOwner(context);
  }
  if (operation === 'rescue-delivery') {
    return deliverOwnerRescue(context);
  }
  if (operation === 'inspect-legacy') {
    return inspectLegacyMatch(context);
  }
  if (operation === 'adopt-legacy') {
    return adoptLegacyPlatformMatch(context);
  }
  const directoryEntry = host.directory(text(requestPayload.matchId, 100));
  if (operation === 'carry-receipt') {
    return recordCarryReceipt(context, directoryEntry);
  }
  if (operation === 'recovery') {
    return recoverPlatformMatch(context, directoryEntry);
  }
  throw new Fault(
    400,
    'UNSUPPORTED_MAINTENANCE',
    '此操作需要兼容性检查与基础设施工具，当前向导不会伪装执行。',
  );
}
