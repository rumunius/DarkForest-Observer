import {
  object,
  parseJson,
  requestId,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import type {BackendEnv} from '../rpc/types';
import {decrypt, digest, encrypt, token} from '../security/crypto';
import {Fault, requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import {erasureFloor} from './retention';
import {controlSignature, platformKey} from './security';
import type {Directory, Operation} from './types';

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
  const p = object(raw);
  const name = text(p.name, 100);
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
  const p = object(raw);
  const operation = text(p.operation, 100);
  if (operation === 'release-check') {
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
  if (operation === 'diagnostics') {
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
  const id = requestId(p.operationId);
  const reason = text(p.reason, 500);
  const hash = await digest(stableJson(p));
  if (operation === 'rescue-owner') {
    const old = host.db.one<{value: string}>(
      'SELECT value FROM platform_meta WHERE key=?',
      `rescue:${id}`,
    );
    if (old) {
      const stored = parseJson(old.value) as {
        hash: string;
        invitationId: string;
        accountId: string;
      };
      requireThat(
        stored.hash === hash,
        'OPERATION_CONFLICT',
        '救援编号已用于不同内容。',
      );
      return JSON.stringify(stored);
    }
    requireThat(
      p.confirm === '恢复平台所有者访问',
      'CONFIRM_REQUIRED',
      '请输入“恢复平台所有者访问”。',
    );
    const accountId = crypto.randomUUID();
    const invite = token();
    const inviteId = crypto.randomUUID();
    const inviteHash = await digest(invite);
    const cipher = await encrypt(
      await platformKey(environment),
      invite,
      `invitation|${inviteId}`,
    );
    host.db.tx(() => {
      host.db.exec('UPDATE platform_sessions SET revoked=1');
      host.db.exec("DELETE FROM platform_roles WHERE role='owner'");
      host.db.exec(
        "INSERT INTO platform_accounts(id,kind,name,status,created_utc) VALUES(?,'staff',?,'pending',?)",
        accountId,
        text(p.name, 100),
        host.now(),
      );
      host.db.exec("INSERT INTO platform_roles VALUES(?,'owner')", accountId);
      host.db.exec(
        'INSERT INTO invitations VALUES(?,?,?,?,0,?,?,?)',
        inviteId,
        accountId,
        inviteHash,
        host.now() + 86400000,
        cipher,
        host.now() + 86400000,
        'root-rescue',
      );
      host.db.exec(
        'INSERT INTO platform_meta VALUES(?,?)',
        `rescue:${id}`,
        JSON.stringify({hash, invitationId: inviteId, accountId}),
      );
      host.audit('root-maintainer', 'owner-rescue', accountId, reason, {
        operationId: id,
      });
    });
    return JSON.stringify({
      accountId,
      invitationId: inviteId,
      invitation: invite,
    });
  }
  if (operation === 'rescue-delivery') {
    const row = host.db.one<{ciphertext: string; delivery_expires: number}>(
      "SELECT ciphertext,delivery_expires FROM invitations WHERE id=? AND issuer='root-rescue'",
      text(p.invitationId, 100),
    );
    requireThat(
      row?.ciphertext && row.delivery_expires > host.now(),
      'DELIVERY_EXPIRED',
      '救援材料已过期，请建立新的救援任务。',
    );
    return JSON.stringify({
      invitation: await decrypt(
        await platformKey(environment),
        row.ciphertext,
        `invitation|${text(p.invitationId, 100)}`,
      ),
    });
  }
  if (operation === 'inspect-legacy') {
    const matchId = text(p.matchId, 100);
    requireThat(
      /^[A-Za-z0-9_-]+$/.test(matchId),
      'BAD_MATCH_ID',
      '旧比赛编号格式不正确。',
      400,
    );
    const inventory = parseJson(
      await environment.MATCH_DO.getByName(`match:${matchId}`).legacyInventory(
        matchId,
        await controlSignature(
          environment,
          stableJson({action: 'legacy-inventory', matchId}),
        ),
      ),
    );
    host.db.exec(
      'INSERT OR REPLACE INTO platform_meta VALUES(?,?)',
      `legacy:${id}`,
      JSON.stringify(inventory),
    );
    return JSON.stringify(inventory);
  }
  if (operation === 'adopt-legacy') {
    const matchId = text(p.matchId, 100);
    const existing = host.db.one<Operation>(
      'SELECT * FROM platform_operations WHERE id=?',
      id,
    );
    if (existing?.status === 'succeeded') {
      requireThat(
        existing.body_hash === hash,
        'OPERATION_CONFLICT',
        '迁移编号对应不同内容。',
      );
      return JSON.stringify({matchId, receipt: parseJson(existing.result)});
    }
    const row = host.db.one<{value: string}>(
      'SELECT value FROM platform_meta WHERE key=?',
      `legacy:${id}`,
    );
    requireThat(row, 'INSPECTION_REQUIRED', '请先检查旧比赛并保存加密检查点。');
    const inventory = parseJson(row.value) as {
      id: string;
      revision: number;
      accounts: Array<{
        id: string;
        role: string;
        name: string;
        credential_hash: string;
      }>;
      checkpoint: unknown;
    };
    requireThat(
      inventory.id === matchId &&
        p.checkpointDigest === (await digest(stableJson(inventory.checkpoint))),
      'BACKUP_RECEIPT_REQUIRED',
      '请保存检查点、回读校验后再登记旧比赛。',
    );
    requireThat(
      p.confirm === `接入旧比赛 ${matchId}`,
      'CONFIRM_REQUIRED',
      `请输入“接入旧比赛 ${matchId}”。`,
    );
    let op = existing;
    if (!op) {
      const mappings = inventory.accounts.map(a => ({
        ...a,
        accountId: crypto.randomUUID(),
      }));
      host.db.tx(() => {
        requireThat(
          !host.db.one<Record<string, SqlStorageValue>>(
            'SELECT id FROM match_directory WHERE id=?',
            matchId,
          ),
          'MATCH_EXISTS',
          '该场次已登记，禁止重建。',
        );
        host.db.exec(
          "INSERT INTO match_directory(id,name,kind,state,object_name,created_utc,retention_days,audit_days,config) VALUES(?,?,'official','provisioning',?,?,44,365,'{}')",
          matchId,
          text(p.name, 100),
          `match:${matchId}`,
          host.now(),
        );
        for (const a of mappings) {
          host.db.exec(
            "INSERT INTO platform_accounts(id,kind,name,status,created_utc) VALUES(?,?,?,'pending',?)",
            a.accountId,
            a.role === 'judge' ? 'staff' : 'player',
            a.name,
            host.now(),
          );
          host.db.exec(
            'INSERT INTO invitations VALUES(?,?,?,?,0,NULL,?,?)',
            crypto.randomUUID(),
            a.accountId,
            a.credential_hash,
            host.now() + 7 * 86400000,
            host.now(),
            'legacy-migration',
          );
          host.db.exec(
            'INSERT INTO account_match_index VALUES(?,?)',
            a.accountId,
            matchId,
          );
        }
        host.insertOperation(
          id,
          'root-maintainer',
          'adopt-legacy',
          matchId,
          hash,
          {mappings, expectedRevision: inventory.revision},
          reason,
        );
      });
      op = host.db.one<Operation>(
        'SELECT * FROM platform_operations WHERE id=?',
        id,
      )!;
    }
    requireThat(
      op.body_hash === hash,
      'OPERATION_CONFLICT',
      '迁移编号对应不同内容。',
    );
    const saved = parseJson(op.payload) as {
      mappings: Array<{id: string; accountId: string}>;
      expectedRevision: number;
    };
    const d = host.directory(matchId);
    const receipt = await host.control(
      d,
      `${id}:adopt`,
      'adopt-legacy',
      'root-maintainer',
      reason,
      {
        kind: 'official',
        expectedRevision: saved.expectedRevision,
        accounts: saved.mappings.map(a => ({
          localId: a.id,
          accountId: a.accountId,
        })),
      },
    );
    host.db.tx(() => {
      host.db.exec(
        "UPDATE match_directory SET state='available',version=version+1 WHERE id=?",
        matchId,
      );
      host.db.exec(
        "UPDATE platform_operations SET status='succeeded',result=?,payload='{}' WHERE id=?",
        JSON.stringify(receipt),
        id,
      );
      host.db.exec('DELETE FROM platform_meta WHERE key=?', `legacy:${id}`);
    });
    return JSON.stringify({
      matchId,
      receipt,
      message:
        '原对象、码本和比赛记录已保留；旧口令仅可在领取页面兑换一次长期口令，7天后失效。未知旧日志人员保持未确认。',
    });
  }
  const d = host.directory(text(p.matchId, 100));
  if (operation === 'carry-receipt') {
    const carry = object(p.carry);
    const savedDigest = text(p.sha256, 100);
    requireThat(
      savedDigest === (await digest(stableJson(carry))),
      'CARRY_MISMATCH',
      '本地回读材料的摘要不匹配。',
    );
    host.db.exec(
      'INSERT OR REPLACE INTO platform_meta VALUES(?,?)',
      `carry:${d.id}:${id}`,
      JSON.stringify({digest: savedDigest, carryId: carry.id}),
    );
    host.audit('root-maintainer', 'carry-saved', d.id, reason, {
      operationId: id,
    });
    return JSON.stringify({saved: true});
  }
  if (operation === 'recovery') {
    requireThat(
      environment.BOOTSTRAP_SECRET,
      'RECOVERY_NOT_CONFIGURED',
      '比赛恢复凭据未配置。',
    );
    const payload = object(p.payload);
    const action = text(payload.operation, 100);
    if (action === 'prepare' || action === 'launch') {
      requireThat(
        erasureFloor(host, d.id) === 0,
        'RESTORE_EXPIRED',
        '本场完整信息已清理，旧检查点不能重新开放比赛；请查看保留的正式战报。',
        410,
      );
    }
    if (action === 'launch') {
      const receipt = host.db.one<{value: string}>(
        'SELECT value FROM platform_meta WHERE key=?',
        `carry:${d.id}:${id}`,
      );
      requireThat(
        receipt &&
          object(parseJson(receipt.value)).digest ===
            (await digest(stableJson(payload.payload))),
        'CARRY_RECEIPT_REQUIRED',
        '必须保存并回读校验carry材料，再登记收据后执行恢复。',
      );
      requireThat(
        p.confirm === `恢复比赛 ${d.id}`,
        'CONFIRM_REQUIRED',
        `请输入“恢复比赛 ${d.id}”。`,
      );
    }
    const signature = await controlSignature(
      environment,
      stableJson({matchId: d.id, raw: payload}),
    );
    if (action === 'launch') {
      requireThat(
        erasureFloor(host, d.id) === 0,
        'RESTORE_EXPIRED',
        '本场资料已清理，不能恢复旧检查点。',
        410,
      );
    }
    const reply = await environment.MATCH_DO.getByName(d.object_name).recovery(
      environment.BOOTSTRAP_SECRET,
      payload,
      signature,
    );
    requireThat(
      reply.status < 400,
      'RECOVERY_FAILED',
      (parseJson(reply.body) as {message?: string}).message ??
        '比赛恢复未完成。',
    );
    if (action === 'complete') {
      // The platform timeline never rolls back with a match. Reapply its current security facts.
      for (const row of host.db.all<{account_id: string}>(
        'SELECT account_id FROM account_match_index WHERE match_id=?',
        d.id,
      )) {
        const a = host.account(row.account_id);
        await host.control(
          d,
          `${id}:security:${a.id}:${a.auth_epoch}`,
          'fence',
          'root-maintainer',
          '恢复后应用最新平台撤销',
          {
            accountId: a.id,
            authEpoch: a.auth_epoch,
            disabled: a.status !== 'active',
          },
        );
      }
      const generation = erasureFloor(host, d.id);
      if (generation > 0) {
        await host.control(
          d,
          `${id}:erase:${generation}`,
          'erase',
          'root-maintainer',
          '恢复后应用独立清理账本',
          {generation},
        );
      }
    }
    host.audit('root-maintainer', `recovery:${action}`, d.id, reason, {
      operationId: id,
    });
    return reply.body;
  }
  throw new Fault(
    400,
    'UNSUPPORTED_MAINTENANCE',
    '此操作需要兼容性检查与基础设施工具，当前向导不会伪装执行。',
  );
}
