import {object, parseJson} from '../../../packages/contracts/src/backend';

/** Storage namespace for original operation IDs; each provider adds its match scope. */
export const PENDING_OPERATION_KEY = 'darkforest.pending-operation';

/** Minimal recovery metadata; credentials and operation payloads stay out of storage. */
export interface PendingRecord {
  id: string;
  account: string;
  match: string;
  path?: string;
}

/** Treat malformed or unavailable browser storage as absent recovery metadata. */
export function readPending(key = PENDING_OPERATION_KEY): PendingRecord | null {
  try {
    const stored = object(parseJson(sessionStorage.getItem(key) ?? 'null'));
    if (
      typeof stored.id !== 'string' ||
      typeof stored.account !== 'string' ||
      typeof stored.match !== 'string' ||
      (stored.path !== undefined && typeof stored.path !== 'string')
    ) {
      return null;
    }
    return {
      id: stored.id,
      account: stored.account,
      match: stored.match,
      ...(typeof stored.path === 'string' ? {path: stored.path} : {}),
    };
  } catch {
    return null;
  }
}

/** Persist only recovery identifiers; the caller retains authoritative memory state. */
export function savePending(
  value: PendingRecord | null,
  key = PENDING_OPERATION_KEY,
): void {
  try {
    if (value) {
      sessionStorage.setItem(key, JSON.stringify(value));
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    /* Memory state remains authoritative for this page. */
  }
}

/** Load this account's read-message IDs, discarding invalid cache shapes. */
export function readMessageIds(key: string): string[] {
  try {
    const stored = parseJson(
      localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? '[]',
    );
    return Array.isArray(stored) && stored.every(id => typeof id === 'string')
      ? stored
      : [];
  } catch {
    return [];
  }
}
