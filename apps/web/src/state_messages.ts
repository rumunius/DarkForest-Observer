import type {Snapshot} from '@darkforest/contracts';
import {useCallback, useEffect, useState} from 'react';
import {personalMessage} from './data/messages';
import {readMessageIds} from './state_storage';

/** Scope read preferences to this browser, match and account; count only the recipient's personal messages. */
export function useMessageReadState(data: Snapshot, base: string) {
  const [readIds, setReadIds] = useState<string[]>([]);
  const accountKey = `${base}.darkforest.read.${data.session?.matchId ?? ''}.${data.session?.role ?? ''}.${data.session?.id ?? 'guest'}`;
  useEffect(() => {
    setReadIds(readMessageIds(accountKey));
  }, [accountKey]);
  const markRead = useCallback(
    (id: string) => {
      setReadIds(previous => {
        if (previous.includes(id)) {
          return previous;
        }
        const next = [...previous, id];
        try {
          localStorage.setItem(accountKey, JSON.stringify(next));
        } catch {
          /* Reading preferences can stay in memory. */
        }
        return next;
      });
    },
    [accountKey],
  );
  const unread = data.events.filter(
    e =>
      personalMessage(e, data.player?.id ?? data.session?.id) &&
      !readIds.includes(e.id),
  ).length;
  return {unread, markRead};
}
