import type {AuditEntry, JudgeState, Notice} from '@darkforest/contracts';
import type {Engine} from '../services/engine';
import {integer} from '../../../../packages/contracts/src/backend';
import {permission, type Actor} from '../storage/store';
export type JudgeCollection = 'notices' | 'audits' | 'attacks';
export type JudgeItems =
  Notice[] | AuditEntry[] | NonNullable<JudgeState['attacks']>;
export function noticeProjection(r: Record<string, SqlStorageValue>): Notice {
  return {
    id: r.id as string,
    target: r.target === 'group' ? '比赛QQ群' : (r.target as string),
    channel: r.channel as Notice['channel'],
    title: r.title as string,
    body: r.body as string,
    status: r.status as Notice['status'],
    version: r.version as number,
    gameMs: r.game_ms as number,
    operator: r.operator as string,
    priority: r.priority as number,
    copiedBy: r.copied_by as string | null,
    copiedUtcMs: r.copied_utc as number | null,
    sentBy: r.sent_by as string | null,
    sentUtcMs: r.sent_utc as number | null,
    error: r.error as string,
  };
}
export function judgeRecords(
  e: Engine,
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
  const rows = e.db.all<Record<string, SqlStorageValue>>(
    `SELECT *,${sequence} AS position FROM ${table} WHERE ${sequence}<? ORDER BY ${sequence} DESC LIMIT ?`,
    before,
    limit,
  );
  const items =
    kind === 'notices'
      ? rows.map(noticeProjection)
      : kind === 'audits'
        ? rows.map(r => {
            const detail = JSON.parse(r.detail as string) as {
              before?: unknown;
              after?: unknown;
              status?: string;
              preview?: unknown;
            };
            return {
              id: r.id as string,
              title: r.action as string,
              operator: r.actor as string,
              reason: r.reason as string,
              before:
                detail.before === undefined
                  ? '历史记录未保存前态'
                  : JSON.stringify(detail.before, null, 2),
              after: JSON.stringify(
                detail.after ?? detail.preview ?? detail,
                null,
                2,
              ),
              gameMs: (r.game_ms as number) ?? 0,
              utcMs: r.utc_ms as number,
              target: r.target as string,
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
    nextCursor: rows.length === limit ? String(rows.at(-1)!.position) : null,
  };
}
