import {
  parseJson,
  scalarText,
} from '../../../../packages/contracts/src/backend';
import type {AuditEntry, JudgeState, Notice} from '@darkforest/contracts';
import type {Engine} from '../services/engine';
import {integer} from '../../../../packages/contracts/src/backend';
import {permission, type Actor} from '../storage/store';
/** 裁判分页接口支持的历史集合，各集合有独立权限和游标。 */
export type JudgeCollection = 'notices' | 'audits' | 'attacks';
/** 裁判分页响应的公开记录类型，不含存储密钥或会话字段。 */
export type JudgeItems =
  Notice[] | AuditEntry[] | NonNullable<JudgeState['attacks']>;
/** 将通知持久行转换为裁判可读记录，保留版本及复制、发送责任信息。 */
export function noticeProjection(row: Record<string, SqlStorageValue>): Notice {
  return {
    id: row.id as string,
    target: row.target === 'group' ? '比赛QQ群' : (row.target as string),
    channel: row.channel as Notice['channel'],
    title: row.title as string,
    body: row.body as string,
    status: row.status as Notice['status'],
    version: row.version as number,
    gameMs: row.game_ms as number,
    operator: row.operator as string,
    priority: row.priority as number,
    copiedBy: row.copied_by as string | null,
    copiedUtcMs: row.copied_utc as number | null,
    sentBy: row.sent_by as string | null,
    sentUtcMs: row.sent_utc as number | null,
    error: row.error as string,
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
  const rows = engine.db.all<Record<string, SqlStorageValue>>(
    `SELECT *,${sequence} AS position FROM ${table} WHERE ${sequence}<? ORDER BY ${sequence} DESC LIMIT ?`,
    before,
    limit,
  );
  const items =
    kind === 'notices'
      ? rows.map(noticeProjection)
      : kind === 'audits'
        ? rows.map(row => {
            const detail = parseJson(row.detail as string) as {
              before?: unknown;
              after?: unknown;
              status?: string;
              preview?: unknown;
            };
            return {
              id: row.id as string,
              title: row.action as string,
              operator: row.actor as string,
              reason: row.reason as string,
              before:
                detail.before === undefined
                  ? '历史记录未保存前态'
                  : JSON.stringify(detail.before, null, 2),
              after: JSON.stringify(
                detail.after ?? detail.preview ?? detail,
                null,
                2,
              ),
              gameMs: (row.game_ms as number) ?? 0,
              utcMs: row.utc_ms as number,
              target: row.target as string,
              status: detail.status ?? 'legacy',
            };
          })
        : rows.map(r => ({
            id: r.id as string,
            actor: r.actor as string,
            target: r.target as string | null,
            classification: r.classification as string,
            roll: r.roll as number | null,
            wrongIndex: r.wrong_index as number | null,
            utcMs: r.committed_utc as number,
            valid: !!r.valid,
          }));
  return {
    items,
    nextCursor:
      rows.length === limit ? scalarText(rows.at(-1)!.position) : null,
  };
}
