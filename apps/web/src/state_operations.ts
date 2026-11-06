import type {
  Arms,
  DataSource,
  OperationResult,
  Snapshot,
} from '@darkforest/contracts';
import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import {ApiError} from './data/http';
import {readPending, type PendingRecord} from './state_storage';

interface MatchOperationContext {
  readonly source: DataSource;
  readonly refresh: () => Promise<void>;
  readonly persistPending: (value: PendingRecord | null) => void;
  readonly storageKey: string;
  readonly pendingRecord: RefObject<PendingRecord | null>;
  readonly submitting: RefObject<boolean>;
  readonly generation: RefObject<number>;
  readonly setBusy: Dispatch<SetStateAction<boolean>>;
  readonly setResult: Dispatch<SetStateAction<OperationResult | null>>;
  readonly setPending: Dispatch<SetStateAction<string | null>>;
  readonly setDraft: Dispatch<SetStateAction<Arms>>;
  readonly setSelectedArm: Dispatch<SetStateAction<number | null>>;
  readonly timelineKey: RefObject<string>;
  readonly setError: Dispatch<SetStateAction<string>>;
  readonly snapshotRef: RefObject<Snapshot>;
  readonly readError: RefObject<boolean>;
}
/** 提交一次稳定编号操作或恢复原结果，共用提供器的互斥、授权世代及反馈。 */
export function useMatchOperations({
  source,
  refresh,
  persistPending,
  storageKey,
  pendingRecord,
  submitting,
  generation,
  setBusy,
  setResult,
  setPending,
  setDraft,
  setSelectedArm,
  timelineKey,
  setError,
  snapshotRef,
  readError,
}: MatchOperationContext) {
  const recover = useCallback(async () => {
    const stored = pendingRecord.current ?? readPending(storageKey);
    if (!stored || submitting.current) {
      return;
    }
    const mine = generation.current;
    submitting.current = true;
    setBusy(true);
    try {
      const response = await source.result(stored.id);
      if (mine !== generation.current) {
        return;
      }
      setResult(response);
      if (response.status === 'complete') {
        persistPending(null);
        setPending(null);
        if (stored.path === '/action/sighting') {
          setDraft([[], []]);
          setSelectedArm(0);
        }
        timelineKey.current = '';
        await refresh();
      }
    } catch (error) {
      if (mine !== generation.current) {
        return;
      }
      setError(
        error instanceof Error
          ? error.message
          : '暂时无法取得操作结果，请稍后查询。',
      );
    } finally {
      if (mine === generation.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }, [
    source,
    refresh,
    persistPending,
    storageKey,
    pendingRecord,
    submitting,
    generation,
    setBusy,
    setResult,
    setPending,
    setDraft,
    setSelectedArm,
    timelineKey,
    setError,
  ]);
  const operate = useCallback(
    async (path: string, payload: Record<string, unknown> = {}) => {
      if (
        submitting.current ||
        pendingRecord.current ||
        readPending(storageKey)
      ) {
        setError('正在确认上一次操作结果。');
        return;
      }
      if (!navigator.onLine) {
        setError('连接已中断，请恢复网络后再提交。');
        return;
      }
      const session = snapshotRef.current.session;
      if (!session) {
        return;
      }
      const id = crypto.randomUUID();
      const mine = generation.current;
      submitting.current = true;
      setBusy(true);
      setError('');
      readError.current = false;
      setResult(null);
      persistPending({id, account: session.id, match: session.matchId, path});
      setPending(id);
      try {
        const response = await source.submit({path, payload, requestId: id});
        if (mine !== generation.current) {
          return;
        }
        setResult(response);
        if (response.status === 'complete') {
          persistPending(null);
          setPending(null);
          timelineKey.current = '';
          await refresh();
          if (mine !== generation.current) {
            return;
          }
        }
        return response;
      } catch (error) {
        if (mine !== generation.current) {
          return;
        }
        const definitive = error instanceof ApiError && error.definitive;
        if (definitive) {
          persistPending(null);
          setPending(null);
          await refresh();
          if (mine !== generation.current) {
            return;
          }
        }
        setError(
          error instanceof Error
            ? error.message
            : '操作结果尚未取得，正在确认上一次操作结果。',
        );
      } finally {
        if (mine === generation.current) {
          submitting.current = false;
          setBusy(false);
        }
      }
    },
    [
      source,
      refresh,
      persistPending,
      storageKey,
      pendingRecord,
      submitting,
      generation,
      setBusy,
      setResult,
      setPending,
      timelineKey,
      setError,
      snapshotRef,
      readError,
    ],
  );
  return {recover, operate};
}
