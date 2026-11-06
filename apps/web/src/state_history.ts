import type {DataSource, Snapshot} from '@darkforest/contracts';
import {
  useCallback,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import {ApiError} from './data/http';
import {mergeRecords, type Collection} from './judge_records';
import {EMPTY_SNAPSHOT as empty} from './state_snapshot';
interface HistoryContext {
  readonly source: DataSource;
  readonly snapshotRef: RefObject<Snapshot>;
  readonly routeRef: RefObject<string>;
  readonly timelineKey: RefObject<string>;
  readonly setData: Dispatch<SetStateAction<Snapshot>>;
  readonly setError: Dispatch<SetStateAction<string>>;
}
/** Page authorized history with one shared in-flight guard, rejecting responses from an old timeline. */
export function useMatchHistory({
  source,
  snapshotRef,
  routeRef,
  timelineKey,
  setData,
  setError,
}: HistoryContext) {
  const historyLoading = useRef(false);
  const loadEarlierEvents = useCallback(async () => {
    const current = snapshotRef.current;
    const cursor = current.eventCursor;
    const path = routeRef.current;
    const key = timelineKey.current;
    if (!source.eventsPage || !cursor || historyLoading.current) {
      return;
    }
    historyLoading.current = true;
    try {
      const page = await source.eventsPage(path, cursor);
      if (key !== timelineKey.current || path !== routeRef.current) {
        return;
      }
      const latest = snapshotRef.current;
      const ids = new Set(latest.events.map(event => event.id));
      const next = {
        ...latest,
        events: [
          ...latest.events,
          ...page.items.filter(event => !ids.has(event.id)),
        ],
        eventCursor: page.nextCursor,
      };
      snapshotRef.current = next;
      setData(next);
    } catch (error) {
      if (key !== timelineKey.current) {
        return;
      }
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        timelineKey.current = '';
        const next = {...empty, site: snapshotRef.current.site};
        snapshotRef.current = next;
        setData(next);
      }
      setError(
        error instanceof Error ? error.message : '暂时无法取得历史记录。',
      );
    } finally {
      historyLoading.current = false;
    }
  }, [source, snapshotRef, routeRef, timelineKey, setData, setError]);
  const loadJudgeRecords = useCallback(
    async (kind: Collection) => {
      const cursor = snapshotRef.current.judge?.cursors?.[kind];
      const key = timelineKey.current;
      if (!cursor || !source.judgePage || historyLoading.current) {
        return;
      }
      historyLoading.current = true;
      try {
        const page = await source.judgePage(kind, cursor);
        if (key !== timelineKey.current || !snapshotRef.current.judge) {
          return;
        }
        const latest = snapshotRef.current;
        const judge = mergeRecords(latest.judge!, kind, page.items);
        judge.cursors = {...judge.cursors, [kind]: page.nextCursor};
        const next = {...latest, judge};
        snapshotRef.current = next;
        setData(next);
      } catch (error) {
        if (key !== timelineKey.current) {
          return;
        }
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          timelineKey.current = '';
          const next = {...empty, site: snapshotRef.current.site};
          snapshotRef.current = next;
          setData(next);
        }
        setError(error instanceof Error ? error.message : '暂时无法读取记录。');
      } finally {
        historyLoading.current = false;
      }
    },
    [source, snapshotRef, timelineKey, setData, setError],
  );
  return {loadEarlierEvents, loadJudgeRecords};
}
