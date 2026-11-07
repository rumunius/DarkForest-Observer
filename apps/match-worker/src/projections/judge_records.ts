import {
  parseJson,
  scalarText,
} from '../../../../packages/contracts/src/backend';
import type {AuditEntry, JudgeState, Notice} from '@darkforest/contracts';
import type {Engine} from '../services/engine';
import {integer} from '../../../../packages/contracts/src/backend';
import {permission, type Actor} from '../storage/store';

/** Selected notice columns after schema migrations, before the public field mapping. */
export interface NoticeRow {
  id: string;
  target: string;
  channel: Notice['channel'];
  title: string;
  body: string;
  status: Notice['status'];
  version: number;
  game_ms: number;
  operator: string;
  priority: number;
  copied_by: string | null;
  copied_utc: number | null;
  sent_by: string | null;
  sent_utc: number | null;
  error: string;
}

interface AuditRow {
  id: string;
  action: string;
  actor: string;
  reason: string;
  detail: string;
  game_ms: number | null;
  utc_ms: number;
  target: string;
}

interface AttackRow {
  id: string;
  actor: string;
  target: string | null;
  classification: string;
  roll: number | null;
  wrong_index: number | null;
  committed_utc: number;
  valid: number;
}

type JudgeRecordRow = (NoticeRow | AuditRow | AttackRow) & {position: number};

/** 裁判分页接口支持的历史集合，各集合有独立权限和游标。 */
export type JudgeCollection = 'notices' | 'audits' | 'attacks';
/** 裁判分页响应的公开记录类型，不含存储密钥或会话字段。 */
export type JudgeItems =
  Notice[] | AuditEntry[] | NonNullable<JudgeState['attacks']>;
/** 将通知持久行转换为裁判可读记录，保留版本及复制、发送责任信息。 */
export function noticeProjection(row: NoticeRow): Notice {
  return {
    id: row.id,
    target: row.target === 'group' ? '比赛QQ群' : row.target,
    channel: row.channel,
    title: row.title,
    body: row.body,
    status: row.status,
    version: row.version,
    gameMs: row.game_ms,
    operator: row.operator,
    priority: row.priority,
    copiedBy: row.copied_by,
    copiedUtcMs: row.copied_utc,
    sentBy: row.sent_by,
    sentUtcMs: row.sent_utc,
    error: row.error,
  };
}
/** 按集合权限读取稳定顺序的历史页，并返回下一页游标。 */
export function judgeRecords(
  engine: Engine,
  actor: Actor,
  kind: JudgeCollection,
  before = Number.MAX_SAFE_INTEGER,
  limit = 100,
): {items: JudgeItems; nextCursor: string | null} {
  permission(actor, kind === 'audits' ? 'audit' : kind);
  integer(before, 1);
  integer(limit, 1, 200);
  const table =
    kind === 'notices'
      ? 'notice_queue'
      : kind === 'audits'
        ? 'audit_logs'
        : 'attacks';
  const sequence =
    kind === 'notices' ? 'ordering_seq' : kind === 'audits' ? 'seq' : 'rowid';
  const rows = engine.db.all<JudgeRecordRow>(
    `SELECT *,${sequence} AS position FROM ${table} WHERE ${sequence}<? ORDER BY ${sequence} DESC LIMIT ?`,
    before,
    limit,
  );
  // Each branch matches the selected table above; column types follow storage/schema.ts.
  const items =
    kind === 'notices'
      ? (rows as NoticeRow[]).map(noticeProjection)
      : kind === 'audits'
        ? (rows as AuditRow[]).map(row => {
            const detail = parseJson(row.detail) as {
              before?: unknown;
              after?: unknown;
              status?: string;
              preview?: unknown;
            };
            return {
              id: row.id,
              title: row.action,
              operator: row.actor,
              reason: row.reason,
              before:
                detail.before === undefined
                  ? '历史记录未保存前态'
                  : JSON.stringify(detail.before, null, 2),
              after: JSON.stringify(
                detail.after ?? detail.preview ?? detail,
                null,
                2,
              ),
              gameMs: row.game_ms ?? 0,
              utcMs: row.utc_ms,
              target: row.target,
              status: detail.status ?? 'legacy',
            };
          })
        : (rows as AttackRow[]).map(r => ({
            id: r.id,
            actor: r.actor,
            target: r.target,
            classification: r.classification,
            roll: r.roll,
            wrongIndex: r.wrong_index,
            utcMs: r.committed_utc,
            valid: !!r.valid,
          }));
  return {
    items,
    nextCursor:
      rows.length === limit ? scalarText(rows.at(-1)!.position) : null,
  };
}
