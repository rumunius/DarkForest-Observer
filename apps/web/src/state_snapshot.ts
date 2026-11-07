import type {Snapshot} from '@darkforest/contracts';
import {DEFAULT_SITE} from './config';
import {mergeRecords} from './judge_records';

/** Public empty view used when no authorized match snapshot is available. */
export const EMPTY_SNAPSHOT: Snapshot = {
  site: DEFAULT_SITE,
  session: null,
  match: null,
  player: null,
  events: [],
  intel: [],
  civilizations: [],
  judge: null,
  results: null,
};
/** Retain already loaded history only within the caller's matching timeline and permissions. */
export function mergeSnapshotHistory(next: Snapshot, previous: Snapshot): void {
  if (next.session && next.eventCursor !== undefined) {
    const ids = new Set(next.events.map(event => event.id));
    next.events = [
      ...next.events,
      ...previous.events.filter(event => !ids.has(event.id)),
    ];
    next.eventCursor = previous.eventCursor ?? null;
    if (next.judge && previous.judge && next.session.role === 'judge') {
      for (const kind of ['notices', 'audits', 'attacks'] as const) {
        if (
          !next.session.permissions.includes(kind === 'audits' ? 'audit' : kind)
        ) {
          continue;
        }
        next.judge = mergeRecords(next.judge, kind, previous.judge[kind] ?? []);
        next.judge.cursors = {
          ...next.judge.cursors,
          [kind]: previous.judge.cursors?.[kind] ?? null,
        };
      }
    }
  }
}
