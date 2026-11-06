import {
  parseJson,
  scalarText,
} from '../../../../packages/contracts/src/backend';
import {
  integer,
  object,
  stableJson,
  strict,
  text,
} from '../../../../packages/contracts/src/backend';
import {decrypt, digest, encrypt} from '../security/crypto';
import {requireThat, type Actor, type CodeRow} from '../storage/store';
import {SCHEMA_VERSION} from '../storage/schema';
import type {Engine} from './engine';
import {BACKUP_TABLES} from './export';

type Row = Record<string, SqlStorageValue>;
/** 检查点中的表到SQL行集合；表名仅允许恢复白名单中的固定表。 */
export type Tables = Record<string, Row[]>;
/** 认证加密的本场检查点信封，绑定Schema、世代、时间和数据库书签。 */
export interface Checkpoint {
  format: 'darkforest-checkpoint-v1';
  matchId: string;
  schemaVersion: number;
  revision: number;
  createdUtc: number;
  bookmark: string;
  marker: string;
  ciphertext: string;
}
/** 恢复期间保留新事实的加密材料，不能与其他场次或恢复编号交换使用。 */
export interface Carry {
  format: 'darkforest-recovery-v1';
  matchId: string;
  id: string;
  createdUtc: number;
  ciphertext: string;
}
interface RecoveryData {
  target: Checkpoint;
  latest: Tables;
  reason: string;
}
/** 捕获命令依赖的权威状态快照，供模拟和确认时检查变化。 */
export function capture(engine: Engine): Tables {
  return Object.fromEntries(
    BACKUP_TABLES.map(table => [
      table,
      engine.db.all<Record<string, SqlStorageValue>>(`SELECT * FROM ${table}`),
    ]),
  );
}
function aad(checkpoint: Omit<Checkpoint, 'ciphertext'>): string {
  return stableJson(checkpoint);
}
function safeState(matchState: {phase: unknown; paused_at: unknown}): void {
  requireThat(
    typeof matchState.phase === 'string' &&
      (matchState.paused_at === null ||
        (typeof matchState.paused_at === 'number' &&
          Number.isSafeInteger(matchState.paused_at))),
    'CHECKPOINT_MISMATCH',
    '恢复文件中的比赛状态不完整。',
    400,
  );
  requireThat(
    matchState.phase === 'setup' ||
      matchState.phase === 'ended' ||
      matchState.paused_at !== null,
    'PAUSE_REQUIRED',
    '请先暂停比赛。',
  );
}
/** 在安全状态捕获检查点并绑定数据库书签，失败时解除临时恢复标记。 */
export async function createCheckpoint(engine: Engine): Promise<Checkpoint> {
  const matchState = engine.db.match();
  safeState(matchState);
  requireThat(
    !matchState.recovery_state,
    'RECOVERY_IN_PROGRESS',
    '正在处理比赛恢复，请稍后重试。',
  );
  const marker = `checkpoint:${crypto.randomUUID()}`;
  engine.db.exec('UPDATE matches SET recovery_state=?', marker);
  try {
    const tables = capture(engine);
    const bookmark = await engine.db.storage.getCurrentBookmark();
    const header: Omit<Checkpoint, 'ciphertext'> = {
      format: 'darkforest-checkpoint-v1',
      matchId: matchState.id,
      schemaVersion: SCHEMA_VERSION,
      revision: matchState.revision,
      createdUtc: engine.now(),
      bookmark,
      marker,
    };
    const keys = await engine.keys();
    const ciphertext = await encrypt(
      keys.encryption,
      JSON.stringify(tables),
      aad(header),
    );
    return {...header, ciphertext};
  } finally {
    engine.db.exec(
      "UPDATE matches SET recovery_state='' WHERE recovery_state=?",
      marker,
    );
  }
}
/** 校验场次、版本、密钥及认证数据后打开检查点，不直接修改数据库。 */
export async function openCheckpoint(
  engine: Engine,
  raw: unknown,
): Promise<{envelope: Checkpoint; tables: Tables}> {
  const character = strict(raw, [
    'format',
    'matchId',
    'schemaVersion',
    'revision',
    'createdUtc',
    'bookmark',
    'marker',
    'ciphertext',
  ]);
  requireThat(
    character.format === 'darkforest-checkpoint-v1' &&
      character.matchId === engine.matchId &&
      character.schemaVersion === SCHEMA_VERSION,
    'CHECKPOINT_MISMATCH',
    '恢复文件的场次或数据版本不匹配。',
    400,
  );
  const envelope: Checkpoint = {
    format: 'darkforest-checkpoint-v1',
    matchId: engine.matchId,
    schemaVersion: SCHEMA_VERSION,
    revision: integer(character.revision, 1),
    createdUtc: integer(character.createdUtc, 1),
    bookmark: text(character.bookmark, 256),
    marker: text(character.marker, 100),
    ciphertext: text(character.ciphertext, 16_000_000),
  };
  const {ciphertext, ...header} = envelope;
  const keys = await engine.keys();
  let tables: Tables;
  try {
    tables = parseJson(
      await decrypt(keys.encryption, ciphertext, aad(header)),
    ) as Tables;
  } catch {
    throw new Error('CHECKPOINT_AUTHENTICATION_FAILED');
  }
  requireThat(
    tables.matches?.length === 1 &&
      tables.matches[0]!.id === engine.matchId &&
      tables.matches[0]!.recovery_state === envelope.marker &&
      tables.matches[0]!.key_fingerprint === keys.fingerprint,
    'CHECKPOINT_MISMATCH',
    '恢复文件校验失败。',
    400,
  );
  safeState({
    phase: tables.matches[0]!.phase,
    paused_at: tables.matches[0]!.paused_at,
  });
  return {envelope, tables};
}
/** 冻结恢复入口并保存前滚材料，供基础设施恢复后保留期间新增事实。 */
export async function prepareRecovery(
  engine: Engine,
  raw: unknown,
): Promise<Carry> {
  const body = strict(raw, ['target', 'reason']);
  const reason = text(body.reason, 500);
  const {envelope} = await openCheckpoint(engine, body.target);
  const matchState = engine.db.match();
  safeState(matchState);
  requireThat(
    !matchState.recovery_state,
    'RECOVERY_IN_PROGRESS',
    '已有恢复操作正在进行。',
  );
  const id = crypto.randomUUID();
  const createdUtc = engine.now();
  engine.db.tx(() => {
    engine.db.exec('UPDATE matches SET recovery_state=?', `prepared:${id}`);
    engine.db.bump();
    engine.audit(
      'recovery-operator',
      'prepare_recovery',
      matchState.id,
      reason,
      {
        id,
        targetRevision: envelope.revision,
      },
    );
  });
  try {
    const latest = capture(engine);
    const keys = await engine.keys();
    const ciphertext = await encrypt(
      keys.encryption,
      JSON.stringify({target: envelope, latest, reason} satisfies RecoveryData),
      `recovery|${matchState.id}|${id}|${createdUtc}`,
    );
    const carry: Carry = {
      format: 'darkforest-recovery-v1',
      matchId: matchState.id,
      id,
      createdUtc,
      ciphertext,
    };
    engine.db.exec(
      'INSERT INTO recovery_log VALUES(?,?,?,?)',
      id,
      'prepared',
      createdUtc,
      JSON.stringify({
        carryDigest: await digest(stableJson(carry)),
        target: envelope.marker,
      }),
    );
    return carry;
  } catch (error) {
    engine.db.exec(
      "UPDATE matches SET recovery_state='' WHERE recovery_state=?",
      `prepared:${id}`,
    );
    throw error;
  }
}
/** 认证并打开恢复前滚材料，校验其场次和操作身份。 */
export async function openCarry(
  engine: Engine,
  raw: unknown,
): Promise<{envelope: Carry; data: RecoveryData}> {
  const body = strict(raw, [
    'format',
    'matchId',
    'id',
    'createdUtc',
    'ciphertext',
  ]);
  requireThat(
    body.format === 'darkforest-recovery-v1' && body.matchId === engine.matchId,
    'RECOVERY_MISMATCH',
    '恢复材料与本场不匹配。',
    400,
  );
  const envelope: Carry = {
    format: 'darkforest-recovery-v1',
    matchId: engine.matchId,
    id: text(body.id, 100),
    createdUtc: integer(body.createdUtc, 1),
    ciphertext: text(body.ciphertext, 32_000_000),
  };
  const keys = await engine.keys();
  const data = parseJson(
    await decrypt(
      keys.encryption,
      envelope.ciphertext,
      `recovery|${envelope.matchId}|${envelope.id}|${envelope.createdUtc}`,
    ),
  ) as RecoveryData;
  await openCheckpoint(engine, data.target);
  requireThat(
    data.latest.matches?.[0]?.key_fingerprint === keys.fingerprint,
    'RECOVERY_MISMATCH',
    '恢复材料校验失败。',
    400,
  );
  return {envelope, data};
}
/** 确认恢复材料及回读证据后安排恢复书签，防止无材料回退。 */
export async function configureRestore(
  engine: Engine,
  raw: unknown,
): Promise<void> {
  const {envelope, data} = await openCarry(engine, raw);
  const matchState = engine.db.match();
  requireThat(
    matchState.recovery_state === `prepared:${envelope.id}`,
    'RECOVERY_STATE_CONFLICT',
    '恢复准备状态不匹配。',
  );
  safeState(matchState);
  const log = engine.db.one<{detail: string}>(
    'SELECT detail FROM recovery_log WHERE id=?',
    envelope.id,
  );
  requireThat(
    log &&
      object(parseJson(log.detail)).carryDigest ===
        (await digest(stableJson(envelope))),
    'RECOVERY_EVIDENCE_MISSING',
    '请先保存完整恢复材料。',
  );
  await engine.db.storage.onNextSessionRestoreBookmark(data.target.bookmark);
}
function insertRow(
  engine: Engine,
  table: (typeof BACKUP_TABLES)[number],
  row: Row,
): void {
  const columns = engine.db
    .all<{name: string}>(`PRAGMA table_info(${table})`)
    .map(c => c.name)
    .filter(name => Object.hasOwn(row, name));
  requireThat(
    columns.length > 0,
    'RECOVERY_INVALID_ROW',
    '恢复记录格式不正确。',
    400,
  );
  engine.db.exec(
    `INSERT INTO ${table}(${columns.map(c => `"${c}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    ...columns.map(c => row[c]!),
  );
}
/** Used by the local runtime rehearsal, where Cloudflare PITR is unavailable. */
export function restoreCheckpointTables(engine: Engine, tables: Tables): void {
  engine.db.tx(() => {
    engine.db.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of [...BACKUP_TABLES].reverse()) {
      if (table !== 'schema_meta') {
        engine.db.exec(`DELETE FROM ${table}`);
      }
    }
    for (const table of BACKUP_TABLES) {
      if (table !== 'schema_meta') {
        for (const row of tables[table] ?? []) {
          insertRow(engine, table, row);
        }
      }
    }
  });
}
/** 恢复后重放必须保留的事实并撤销旧会话，等待网站人工核对。 */
export async function completeRecovery(
  engine: Engine,
  raw: unknown,
): Promise<{id: string; issuedCount: number}> {
  const {envelope, data} = await openCarry(engine, raw);
  const db = engine.db;
  const matchState = db.match();
  const old = db.one<{state: string}>(
    'SELECT state FROM recovery_log WHERE id=?',
    envelope.id,
  );
  if (old?.state === 'review' || old?.state === 'complete') {
    return {
      id: envelope.id,
      issuedCount: db.all<Record<string, SqlStorageValue>>(
        'SELECT id FROM sighting_codes',
      ).length,
    };
  }
  requireThat(
    matchState.recovery_state === data.target.marker,
    'RECOVERY_STATE_CONFLICT',
    '目标时间点尚未恢复，请核对恢复状态。',
  );
  const target = await openCheckpoint(engine, data.target);
  // A native restore must have recovered the exact checkpoint state, not merely a supplied marker.
  requireThat(
    matchState.revision === data.target.revision &&
      stableJson(
        db.all<Record<string, SqlStorageValue>>(
          'SELECT * FROM sighting_codes ORDER BY id',
        ),
      ) ===
        stableJson(
          [...(target.tables.sighting_codes ?? [])].sort((a, b) =>
            scalarText(a.id).localeCompare(scalarText(b.id)),
          ),
        ),
    'RECOVERY_STATE_CONFLICT',
    '恢复后的发行记录与目标时间点不一致。',
  );
  db.tx(() => {
    for (const row of data.latest.accounts ?? []) {
      const account = db.one<Actor>(
        'SELECT * FROM accounts WHERE id=?',
        scalarText(row.id),
      );
      requireThat(
        account,
        'RECOVERY_ACCOUNT_MISSING',
        '恢复后的账号名单不完整。',
      );
      db.exec(
        'UPDATE accounts SET credential_hash=?,enabled=?,permissions=?,version=MAX(version,?)+1 WHERE id=?',
        row.credential_hash!,
        row.enabled!,
        row.permissions!,
        row.version!,
        row.id!,
      );
    }
    for (const rawCode of data.latest.sighting_codes ?? []) {
      const latest = {
        id: text(rawCode.id, 100),
        mac: text(rawCode.mac, 100),
        ciphertext: text(rawCode.ciphertext, 16_000_000),
        status: text(rawCode.status, 100),
        retired_game:
          rawCode.retired_game === null ? null : integer(rawCode.retired_game),
        retired_utc:
          rawCode.retired_utc === null ? null : integer(rawCode.retired_utc),
        retired_reason:
          rawCode.retired_reason === null
            ? null
            : text(rawCode.retired_reason, 1000, 0),
      };
      const current = db.one<CodeRow>(
        'SELECT * FROM sighting_codes WHERE mac=?',
        latest.mac,
      );
      if (current) {
        requireThat(
          current.id === latest.id && current.ciphertext === latest.ciphertext,
          'CODEBOOK_CONFLICT',
          '历史手环配置存在冲突，请保持暂停。',
        );
        if (latest.status === 'retired') {
          db.exec(
            "UPDATE sighting_codes SET status='retired',retired_game=?,retired_utc=?,retired_reason=? WHERE id=?",
            latest.retired_game,
            latest.retired_utc,
            latest.retired_reason,
            latest.id,
          );
          db.exec('UPDATE flights SET code_id=NULL WHERE code_id=?', latest.id);
        }
      } else {
        insertRow(engine, 'sighting_codes', {
          ...rawCode,
          status: 'retired',
          retired_utc: latest.retired_utc ?? engine.now(),
          retired_game: latest.retired_game ?? engine.game(),
          retired_reason: 'recovery_preserved',
        });
      }
    }
    for (const row of data.latest.request_journal ?? []) {
      if (
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT actor FROM request_journal WHERE actor=? AND request_id=?',
          row.actor!,
          row.request_id!,
        )
      ) {
        insertRow(engine, 'request_journal', {
          ...row,
          result_json: JSON.stringify({
            requestId: row.request_id,
            status: 'complete',
            code: 'CANCELLED_BY_RECOVERY',
            title: '比赛已恢复',
            message: '该操作已随比赛恢复结束，请查看当前状态。',
          }),
          cancelled: 1,
        });
      }
    }
    for (const row of data.latest.intel_grants ?? []) {
      if (
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM intel_grants WHERE id=? OR (owner=? AND target=? AND source=?)',
          row.id!,
          row.owner!,
          row.target!,
          row.source!,
        )
      ) {
        insertRow(engine, 'intel_grants', row);
      }
    }
    for (const row of data.latest.event_log ?? []) {
      if (
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM event_log WHERE id=?',
          row.id!,
        )
      ) {
        const {seq, ...rest} = row;
        void seq;
        insertRow(engine, 'event_log', {
          ...rest,
          audience: 'global',
          body: `${scalarText(row.body)}（恢复前记录）`,
        });
      }
    }
    for (const row of data.latest.notice_queue ?? []) {
      const current = db.one<Record<string, SqlStorageValue>>(
        'SELECT id FROM notice_queue WHERE id=?',
        row.id!,
      );
      if (current) {
        db.exec(
          'UPDATE notice_queue SET status=?,version=MAX(version,?)+1,operator=?,error=?,copied_by=?,copied_utc=?,sent_by=?,sent_utc=? WHERE id=?',
          row.status!,
          row.version!,
          row.operator!,
          row.error!,
          row.copied_by ?? null,
          row.copied_utc ?? null,
          row.sent_by ?? null,
          row.sent_utc ?? null,
          row.id!,
        );
      } else {
        const copy = {...row};
        delete copy.ordering_seq;
        copy.ordering_seq = db.one<{value: number}>(
          'SELECT COALESCE(MAX(ordering_seq),0)+1 AS value FROM notice_queue',
        )!.value;
        copy.status = row.status === 'sent' ? 'sent' : 'error';
        copy.error = '请核对比赛恢复后的通知内容。';
        insertRow(engine, 'notice_queue', copy);
      }
    }
    for (const row of data.latest.notice_actions ?? []) {
      if (
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM notice_actions WHERE id=?',
          row.id!,
        )
      ) {
        insertRow(engine, 'notice_actions', row);
      }
    }
    for (const row of data.latest.judge_eliminations ?? []) {
      if (
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT source FROM judge_eliminations WHERE source=? AND player_id=?',
          row.source!,
          row.player_id!,
        )
      ) {
        insertRow(engine, 'judge_eliminations', row);
      }
    }
    for (const row of data.latest.audit_logs ?? []) {
      if (
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM audit_logs WHERE id=?',
          row.id!,
        )
      ) {
        const {seq, ...rest} = row;
        void seq;
        insertRow(engine, 'audit_logs', rest);
      }
    }
    // Carry the latest authorization and progress, preserving original due times and late policy.
    for (const row of data.latest.judge_command_log ?? []) {
      if (
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM judge_command_log WHERE id=?',
          row.id!,
        )
      ) {
        const {seq, ...rest} = row;
        void seq;
        insertRow(engine, 'judge_command_log', rest);
      }
    }
    for (const row of data.latest.command_objects ?? []) {
      db.exec('DELETE FROM command_objects WHERE id=?', row.id!);
      insertRow(engine, 'command_objects', row);
    }
    db.exec(
      "UPDATE command_objects SET status='cancelled' WHERE kind='plan' AND status='pending'",
    );
    db.exec(
      "DELETE FROM scheduled_events WHERE kind IN ('judge_command_task','judge_command_job')",
    );
    for (const row of data.latest.scheduled_events ?? []) {
      if (
        ['judge_command_task', 'judge_command_job'].includes(
          scalarText(row.kind),
        )
      ) {
        insertRow(engine, 'scheduled_events', row);
      }
    }
    db.exec('UPDATE sessions SET revoked=1');
    if (data.latest.match_identity?.length) {
      for (const table of [
        'memberships',
        'staff_assignments',
        'authorization_fences',
        'participation_history',
      ] as const) {
        db.exec(`DELETE FROM ${table}`);
        for (const row of data.latest[table] ?? []) {
          insertRow(engine, table, row);
        }
      }
      db.exec(
        'UPDATE memberships SET epoch=(SELECT version FROM accounts WHERE id=memberships.local_id) WHERE local_id IS NOT NULL',
      );
      db.exec(
        'UPDATE match_identity SET recovery_generation=MAX(recovery_generation,?)+1,erasure_generation=MAX(erasure_generation,?)',
        Number(data.latest.match_identity[0]!.recovery_generation ?? 0),
        Number(data.latest.match_identity[0]!.erasure_generation ?? 0),
      );
    }
    db.exec('DELETE FROM previews');
    db.exec(
      'UPDATE matches SET recovery_state=?,revision=MAX(revision,?)+1',
      `review:${envelope.id}`,
      data.latest.matches![0]!.revision!,
    );
    db.exec(
      'INSERT INTO recovery_log VALUES(?,?,?,?)',
      envelope.id,
      'review',
      engine.now(),
      JSON.stringify({
        reason: data.reason,
        targetRevision: data.target.revision,
        evidence: envelope,
      }),
    );
    if (
      db.match().phase !== 'setup' &&
      db.match().phase !== 'ended' &&
      db.match().paused_at === null
    ) {
      throw new Error('RECOVERY_MUST_REMAIN_PAUSED');
    }
    engine.audit(
      'recovery-operator',
      'complete_recovery',
      matchState.id,
      data.reason,
      {
        id: envelope.id,
        issuedCount: db.all<Record<string, SqlStorageValue>>(
          'SELECT id FROM sighting_codes',
        ).length,
      },
    );
  });
  return {
    id: envelope.id,
    issuedCount: db.all<Record<string, SqlStorageValue>>(
      'SELECT id FROM sighting_codes',
    ).length,
  };
}
/** 结束已核对的恢复审查；比赛仍保持暂停，恢复计时需另行确认。 */
export function finishRecovery(engine: Engine): void {
  const matchState = engine.db.match();
  requireThat(
    matchState.recovery_state.startsWith('review:'),
    'RECOVERY_NOT_REVIEWING',
    '当前没有待核对的恢复。',
  );
  const invalid = engine.db.one<Record<string, SqlStorageValue>>(
    "SELECT f.player_id FROM flights f JOIN roster_members r ON r.player_id=f.player_id WHERE (f.status='active' AND NOT EXISTS(SELECT id FROM sighting_codes c WHERE c.id=f.code_id AND c.status='active' AND c.player_id=f.player_id)) OR (f.status IN ('issued','outfitting','ready') AND NOT EXISTS(SELECT id FROM sighting_codes c WHERE c.id=f.code_id AND c.status='reserved' AND c.player_id=f.player_id))",
  );
  requireThat(
    !invalid,
    'RECOVERY_EQUIPMENT_REVIEW',
    '请先核对并恢复所有待处理的手环配置。',
  );
  engine.db.exec(
    "UPDATE recovery_log SET state='complete' WHERE id=?",
    matchState.recovery_state.slice('review:'.length),
  );
  engine.db.exec("UPDATE matches SET recovery_state=''");
}
/** 受限恢复RPC入口，验证恢复材料和操作范围后调用对应恢复步骤。 */
export async function recoveryRpc(
  engine: Engine,
  secret: string,
  raw: unknown,
): Promise<unknown> {
  requireThat(
    engine.env.BOOTSTRAP_SECRET &&
      (await digest(secret)) === (await digest(engine.env.BOOTSTRAP_SECRET)),
    'FORBIDDEN',
    '恢复授权无效。',
    403,
  );
  const body = object(raw);
  const operation = text(body.operation, 16);
  if (operation === 'status') {
    return {
      state: engine.db.match().recovery_state,
      revision: engine.db.match().revision,
    };
  }
  if (operation === 'prepare') {
    return prepareRecovery(engine, body.payload);
  }
  if (operation === 'complete') {
    return completeRecovery(engine, body.payload);
  }
  if (operation === 'cancel') {
    if (body.payload === undefined) {
      const state = engine.db.match().recovery_state;
      requireThat(
        state.startsWith('prepared:'),
        'RECOVERY_STATE_CONFLICT',
        '恢复已启动，请继续完成恢复。',
      );
      engine.db.exec(
        "UPDATE recovery_log SET state='cancelled' WHERE id=?",
        state.slice('prepared:'.length),
      );
      engine.db.exec("UPDATE matches SET recovery_state=''");
      engine.db.bump();
      return {cancelled: true};
    }
    const {envelope} = await openCarry(engine, body.payload);
    requireThat(
      engine.db.match().recovery_state === `prepared:${envelope.id}`,
      'RECOVERY_STATE_CONFLICT',
      '恢复已启动，请继续完成恢复。',
    );
    engine.db.exec("UPDATE matches SET recovery_state=''");
    engine.db.exec(
      "UPDATE recovery_log SET state='cancelled' WHERE id=?",
      envelope.id,
    );
    engine.db.bump();
    return {cancelled: true};
  }
  throw new Error('RECOVERY_OPERATION_UNSUPPORTED');
}
