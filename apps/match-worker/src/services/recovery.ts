import {
  integer,
  object,
  stableJson,
  strict,
  text,
} from '../../../../packages/contracts/src/backend';
import { decrypt, digest, encrypt } from '../security/crypto';
import { requireThat, type Actor, type CodeRow, type Match } from '../storage/store';
import { SCHEMA_VERSION } from '../storage/schema';
import type { Engine } from './engine';
import { BACKUP_TABLES } from './export';
type Row = Record<string, SqlStorageValue>;
export type Tables = Record<string, Row[]>;
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
export interface Carry {
  format: 'darkforest-recovery-v1';
  matchId: string;
  id: string;
  createdUtc: number;
  ciphertext: string;
}
type RecoveryData = { target: Checkpoint; latest: Tables; reason: string };
export function capture(e: Engine): Tables {
  return Object.fromEntries(
    BACKUP_TABLES.map((table) => [table, e.db.all(`SELECT * FROM ${table}`)]),
  );
}
function aad(checkpoint: Omit<Checkpoint, 'ciphertext'>): string {
  return stableJson(checkpoint);
}
function safeState(m: Match): void {
  requireThat(
    m.phase === 'setup' || m.phase === 'ended' || m.paused_at !== null,
    'PAUSE_REQUIRED',
    '请先暂停比赛。',
  );
}
export async function createCheckpoint(e: Engine): Promise<Checkpoint> {
  const m = e.db.match();
  safeState(m);
  requireThat(!m.recovery_state, 'RECOVERY_IN_PROGRESS', '正在处理比赛恢复，请稍后重试。');
  const marker = `checkpoint:${crypto.randomUUID()}`;
  e.db.exec('UPDATE matches SET recovery_state=?', marker);
  try {
    const tables = capture(e),
      bookmark = await e.db.storage.getCurrentBookmark();
    const header: Omit<Checkpoint, 'ciphertext'> = {
      format: 'darkforest-checkpoint-v1',
      matchId: m.id,
      schemaVersion: SCHEMA_VERSION,
      revision: m.revision,
      createdUtc: e.now(),
      bookmark,
      marker,
    };
    const keys = await e.keys();
    const ciphertext = await encrypt(keys.encryption, JSON.stringify(tables), aad(header));
    return { ...header, ciphertext };
  } finally {
    e.db.exec("UPDATE matches SET recovery_state='' WHERE recovery_state=?", marker);
  }
}
export async function openCheckpoint(
  e: Engine,
  raw: unknown,
): Promise<{ envelope: Checkpoint; tables: Tables }> {
  const c = strict(raw, [
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
    c.format === 'darkforest-checkpoint-v1' &&
      c.matchId === e.env.MATCH_ID &&
      c.schemaVersion === SCHEMA_VERSION,
    'CHECKPOINT_MISMATCH',
    '恢复文件的场次或数据版本不匹配。',
    400,
  );
  integer(c.revision, 1);
  integer(c.createdUtc, 1);
  text(c.bookmark, 256);
  text(c.marker, 100);
  text(c.ciphertext, 16_000_000);
  const envelope = c as unknown as Checkpoint,
    { ciphertext, ...header } = envelope;
  const keys = await e.keys();
  let tables: Tables;
  try {
    tables = JSON.parse(await decrypt(keys.encryption, ciphertext, aad(header))) as Tables;
  } catch {
    throw new Error('CHECKPOINT_AUTHENTICATION_FAILED');
  }
  requireThat(
    tables.matches?.length === 1 &&
      tables.matches[0]!.id === e.env.MATCH_ID &&
      tables.matches[0]!.recovery_state === envelope.marker &&
      tables.matches[0]!.key_fingerprint === keys.fingerprint,
    'CHECKPOINT_MISMATCH',
    '恢复文件校验失败。',
    400,
  );
  safeState(tables.matches[0] as unknown as Match);
  return { envelope, tables };
}
export async function prepareRecovery(e: Engine, raw: unknown): Promise<Carry> {
  const body = strict(raw, ['target', 'reason']);
  const reason = text(body.reason, 500);
  const { envelope } = await openCheckpoint(e, body.target);
  const m = e.db.match();
  safeState(m);
  requireThat(!m.recovery_state, 'RECOVERY_IN_PROGRESS', '已有恢复操作正在进行。');
  const id = crypto.randomUUID(),
    createdUtc = e.now();
  e.db.tx(() => {
    e.db.exec('UPDATE matches SET recovery_state=?', `prepared:${id}`);
    e.db.bump();
    e.audit('recovery-operator', 'prepare_recovery', m.id, reason, {
      id,
      targetRevision: envelope.revision,
    });
  });
  try {
    const latest = capture(e),
      keys = await e.keys();
    const ciphertext = await encrypt(
      keys.encryption,
      JSON.stringify({ target: envelope, latest, reason } satisfies RecoveryData),
      `recovery|${m.id}|${id}|${createdUtc}`,
    );
    const carry: Carry = {
      format: 'darkforest-recovery-v1',
      matchId: m.id,
      id,
      createdUtc,
      ciphertext,
    };
    e.db.exec(
      'INSERT INTO recovery_log VALUES(?,?,?,?)',
      id,
      'prepared',
      createdUtc,
      JSON.stringify({ carryDigest: await digest(stableJson(carry)), target: envelope.marker }),
    );
    return carry;
  } catch (error) {
    e.db.exec("UPDATE matches SET recovery_state='' WHERE recovery_state=?", `prepared:${id}`);
    throw error;
  }
}
export async function openCarry(
  e: Engine,
  raw: unknown,
): Promise<{ envelope: Carry; data: RecoveryData }> {
  const body = strict(raw, ['format', 'matchId', 'id', 'createdUtc', 'ciphertext']);
  requireThat(
    body.format === 'darkforest-recovery-v1' && body.matchId === e.env.MATCH_ID,
    'RECOVERY_MISMATCH',
    '恢复材料与本场不匹配。',
    400,
  );
  text(body.id, 100);
  integer(body.createdUtc, 1);
  text(body.ciphertext, 32_000_000);
  const envelope = body as unknown as Carry,
    keys = await e.keys();
  const data = JSON.parse(
    await decrypt(
      keys.encryption,
      envelope.ciphertext,
      `recovery|${envelope.matchId}|${envelope.id}|${envelope.createdUtc}`,
    ),
  ) as RecoveryData;
  await openCheckpoint(e, data.target);
  requireThat(
    data.latest.matches?.[0]?.key_fingerprint === keys.fingerprint,
    'RECOVERY_MISMATCH',
    '恢复材料校验失败。',
    400,
  );
  return { envelope, data };
}
export async function configureRestore(e: Engine, raw: unknown): Promise<void> {
  const { envelope, data } = await openCarry(e, raw),
    m = e.db.match();
  requireThat(
    m.recovery_state === `prepared:${envelope.id}`,
    'RECOVERY_STATE_CONFLICT',
    '恢复准备状态不匹配。',
  );
  safeState(m);
  const log = e.db.one<{ detail: string }>(
    'SELECT detail FROM recovery_log WHERE id=?',
    envelope.id,
  );
  requireThat(
    log && JSON.parse(log.detail).carryDigest === (await digest(stableJson(envelope))),
    'RECOVERY_EVIDENCE_MISSING',
    '请先保存完整恢复材料。',
  );
  await e.db.storage.onNextSessionRestoreBookmark(data.target.bookmark);
}
function insertRow(e: Engine, table: (typeof BACKUP_TABLES)[number], row: Row): void {
  const columns = e.db
    .all<{ name: string }>(`PRAGMA table_info(${table})`)
    .map((c) => c.name)
    .filter((name) => Object.hasOwn(row, name));
  requireThat(columns.length > 0, 'RECOVERY_INVALID_ROW', '恢复记录格式不正确。', 400);
  e.db.exec(
    `INSERT INTO ${table}(${columns.map((c) => `"${c}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    ...columns.map((c) => row[c]!),
  );
}
/** Used by the local runtime rehearsal, where Cloudflare PITR is unavailable. */
export function restoreCheckpointTables(e: Engine, tables: Tables): void {
  e.db.tx(() => {
    e.db.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of [...BACKUP_TABLES].reverse())
      if (table !== 'schema_meta') e.db.exec(`DELETE FROM ${table}`);
    for (const table of BACKUP_TABLES)
      if (table !== 'schema_meta') for (const row of tables[table] ?? []) insertRow(e, table, row);
  });
}
export async function completeRecovery(
  e: Engine,
  raw: unknown,
): Promise<{ id: string; issuedCount: number }> {
  const { envelope, data } = await openCarry(e, raw),
    db = e.db,
    m = db.match();
  const old = db.one<{ state: string }>('SELECT state FROM recovery_log WHERE id=?', envelope.id);
  if (old?.state === 'review' || old?.state === 'complete')
    return { id: envelope.id, issuedCount: db.all('SELECT id FROM sighting_codes').length };
  requireThat(
    m.recovery_state === data.target.marker,
    'RECOVERY_STATE_CONFLICT',
    '目标时间点尚未恢复，请核对恢复状态。',
  );
  const target = await openCheckpoint(e, data.target);
  // A native restore must have recovered the exact checkpoint state, not merely a supplied marker.
  requireThat(
    m.revision === data.target.revision &&
      stableJson(db.all('SELECT * FROM sighting_codes ORDER BY id')) ===
        stableJson(
          [...(target.tables.sighting_codes ?? [])].sort((a, b) =>
            String(a.id).localeCompare(String(b.id)),
          ),
        ),
    'RECOVERY_STATE_CONFLICT',
    '恢复后的发行记录与目标时间点不一致。',
  );
  db.tx(() => {
    for (const row of data.latest.accounts ?? []) {
      const account = db.one<Actor>('SELECT * FROM accounts WHERE id=?', String(row.id));
      requireThat(account, 'RECOVERY_ACCOUNT_MISSING', '恢复后的账号名单不完整。');
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
      const latest = rawCode as unknown as CodeRow,
        current = db.one<CodeRow>('SELECT * FROM sighting_codes WHERE mac=?', latest.mac);
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
      } else
        insertRow(e, 'sighting_codes', {
          ...rawCode,
          status: 'retired',
          retired_utc: latest.retired_utc ?? e.now(),
          retired_game: latest.retired_game ?? e.game(),
          retired_reason: 'recovery_preserved',
        });
    }
    for (const row of data.latest.request_journal ?? [])
      if (
        !db.one(
          'SELECT actor FROM request_journal WHERE actor=? AND request_id=?',
          row.actor!,
          row.request_id!,
        )
      )
        insertRow(e, 'request_journal', {
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
    for (const row of data.latest.intel_grants ?? [])
      if (
        !db.one(
          'SELECT id FROM intel_grants WHERE id=? OR (owner=? AND target=? AND source=?)',
          row.id!,
          row.owner!,
          row.target!,
          row.source!,
        )
      )
        insertRow(e, 'intel_grants', row);
    for (const row of data.latest.event_log ?? [])
      if (!db.one('SELECT id FROM event_log WHERE id=?', row.id!)) {
        const { seq, ...rest } = row;
        void seq;
        insertRow(e, 'event_log', {
          ...rest,
          audience: 'global',
          body: `${row.body}（恢复前记录）`,
        });
      }
    for (const row of data.latest.notice_queue ?? []) {
      const current = db.one('SELECT id FROM notice_queue WHERE id=?', row.id!);
      if (current)
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
      else {
        const copy = { ...row };
        delete copy.ordering_seq;
        copy.ordering_seq = db.one<{ value: number }>(
          'SELECT COALESCE(MAX(ordering_seq),0)+1 AS value FROM notice_queue',
        )!.value;
        copy.status = row.status === 'sent' ? 'sent' : 'error';
        copy.error = '请核对比赛恢复后的通知内容。';
        insertRow(e, 'notice_queue', copy);
      }
    }
    for (const row of data.latest.notice_actions ?? [])
      if (!db.one('SELECT id FROM notice_actions WHERE id=?', row.id!))
        insertRow(e, 'notice_actions', row);
    for (const row of data.latest.judge_eliminations ?? [])
      if (
        !db.one(
          'SELECT source FROM judge_eliminations WHERE source=? AND player_id=?',
          row.source!,
          row.player_id!,
        )
      )
        insertRow(e, 'judge_eliminations', row);
    for (const row of data.latest.audit_logs ?? [])
      if (!db.one('SELECT id FROM audit_logs WHERE id=?', row.id!)) {
        const { seq, ...rest } = row;
        void seq;
        insertRow(e, 'audit_logs', rest);
      }
    db.exec('UPDATE sessions SET revoked=1');
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
      e.now(),
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
    )
      throw new Error('RECOVERY_MUST_REMAIN_PAUSED');
    e.audit('recovery-operator', 'complete_recovery', m.id, data.reason, {
      id: envelope.id,
      issuedCount: db.all('SELECT id FROM sighting_codes').length,
    });
  });
  return { id: envelope.id, issuedCount: db.all('SELECT id FROM sighting_codes').length };
}
export function finishRecovery(e: Engine): void {
  const m = e.db.match();
  requireThat(
    m.recovery_state.startsWith('review:'),
    'RECOVERY_NOT_REVIEWING',
    '当前没有待核对的恢复。',
  );
  const invalid = e.db.one(
    "SELECT f.player_id FROM flights f JOIN roster_members r ON r.player_id=f.player_id WHERE (f.status='active' AND NOT EXISTS(SELECT id FROM sighting_codes c WHERE c.id=f.code_id AND c.status='active' AND c.player_id=f.player_id)) OR (f.status IN ('issued','outfitting','ready') AND NOT EXISTS(SELECT id FROM sighting_codes c WHERE c.id=f.code_id AND c.status='reserved' AND c.player_id=f.player_id))",
  );
  requireThat(!invalid, 'RECOVERY_EQUIPMENT_REVIEW', '请先核对并恢复所有待处理的手环配置。');
  e.db.exec(
    "UPDATE recovery_log SET state='complete' WHERE id=?",
    m.recovery_state.slice('review:'.length),
  );
  e.db.exec("UPDATE matches SET recovery_state=''");
}
export async function recoveryRpc(e: Engine, secret: string, raw: unknown): Promise<unknown> {
  requireThat(
    e.env.BOOTSTRAP_SECRET && (await digest(secret)) === (await digest(e.env.BOOTSTRAP_SECRET)),
    'FORBIDDEN',
    '恢复授权无效。',
    403,
  );
  const body = object(raw),
    operation = text(body.operation, 16);
  if (operation === 'status')
    return { state: e.db.match().recovery_state, revision: e.db.match().revision };
  if (operation === 'prepare') return prepareRecovery(e, body.payload);
  if (operation === 'complete') return completeRecovery(e, body.payload);
  if (operation === 'cancel') {
    if (body.payload === undefined) {
      const state = e.db.match().recovery_state;
      requireThat(
        state.startsWith('prepared:'),
        'RECOVERY_STATE_CONFLICT',
        '恢复已启动，请继续完成恢复。',
      );
      e.db.exec(
        "UPDATE recovery_log SET state='cancelled' WHERE id=?",
        state.slice('prepared:'.length),
      );
      e.db.exec("UPDATE matches SET recovery_state=''");
      e.db.bump();
      return { cancelled: true };
    }
    const { envelope } = await openCarry(e, body.payload);
    requireThat(
      e.db.match().recovery_state === `prepared:${envelope.id}`,
      'RECOVERY_STATE_CONFLICT',
      '恢复已启动，请继续完成恢复。',
    );
    e.db.exec("UPDATE matches SET recovery_state=''");
    e.db.exec("UPDATE recovery_log SET state='cancelled' WHERE id=?", envelope.id);
    e.db.bump();
    return { cancelled: true };
  }
  throw new Error('RECOVERY_OPERATION_UNSUPPORTED');
}
