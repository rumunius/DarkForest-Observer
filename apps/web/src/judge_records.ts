import type {JudgeState, Notice, AuditEntry} from '@darkforest/contracts';
export type Collection = 'notices' | 'audits' | 'attacks';
export function mergeRecords(
  judge: JudgeState,
  kind: Collection,
  extra: Array<{id: string}>,
): JudgeState {
  const current = judge[kind] ?? [];
  const ids = new Set(current.map(r => r.id));
  const merged = [...current, ...extra.filter(r => !ids.has(r.id))];
  return {
    ...judge,
    ...(kind === 'notices'
      ? {notices: merged as Notice[]}
      : kind === 'audits'
        ? {audits: merged as AuditEntry[]}
        : {attacks: merged as NonNullable<JudgeState['attacks']>}),
  };
}
