import type {JudgeState, Notice, AuditEntry} from '@darkforest/contracts';
/** 裁判历史分页集合键，权限分别对应通知、审计与攻击。 */
export type Collection = 'notices' | 'audits' | 'attacks';
/** 按稳定记录身份合并裁判历史页，保留已加载记录且不制造重复。 */
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
