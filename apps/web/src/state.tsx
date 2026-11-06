import type {
  Arms,
  DataSource,
  OperationResult,
  Snapshot,
} from '@darkforest/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {ApiError} from './data/http';
import {type Collection} from './judge_records';
import {useBrowserEvents, useSnapshotPolling} from './state_browser';
import {useMatchHistory} from './state_history';
import {useMessageReadState} from './state_messages';
import {useMatchNavigation} from './state_navigation';
import {useMatchOperations} from './state_operations';
import {EMPTY_SNAPSHOT as empty, mergeSnapshotHistory} from './state_snapshot';
import {
  PENDING_OPERATION_KEY as pendingKey,
  readPending,
  savePending,
  type PendingRecord,
} from './state_storage';
import {requireError} from '@darkforest/contracts';

interface AppContext {
  data: Snapshot;
  route: string;
  base: string;
  go: (path: string, replace?: boolean) => void;
  refresh: () => Promise<void>;
  loadEarlierEvents: () => Promise<void>;
  loadJudgeRecords: (kind: Collection) => Promise<void>;
  source: DataSource;
  loading: boolean;
  busy: boolean;
  error: string;
  reportError: (error: unknown) => void;
  result: OperationResult | null;
  clearFeedback: () => void;
  operate: (
    path: string,
    payload?: Record<string, unknown>,
  ) => Promise<OperationResult | undefined>;
  pending: string | null;
  recover: () => Promise<void>;
  logout: () => Promise<void>;
  names: boolean;
  setNames: (value: boolean) => void;
  reduced: boolean;
  setReduced: (value: boolean) => void;
  draft: Arms;
  setDraft: (arms: Arms) => void;
  selectedArm: number | null;
  setSelectedArm: (arm: number | null) => void;
  receivedAt: number;
  online: boolean;
  unread: number;
  markRead: (id: string) => void;
}
const Context = createContext<AppContext | null>(null);
/** 取得当前本场上下文；缺少提供器时抛错，避免页面默用其他场次状态。 */
export function useApp(): AppContext {
  const c = useContext(Context);
  if (!c) {
    throw new Error('Missing application context');
  }
  return c;
}
/** 管理本场快照、轮询、待确认操作和草稿，并隔离过时响应与账号切换。 */
export function AppProvider({
  source,
  base = '',
  children,
  epoch = 0,
}: {
  source: DataSource;
  base?: string;
  children: ReactNode;
  epoch?: number;
}) {
  const [data, setData] = useState<Snapshot>(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reportError = useCallback((error: unknown) => {
    setError(requireError(error).message);
  }, []);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [names, setNames] = useState(false);
  const [reduced, setReduced] = useState(
    matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [draft, setDraft] = useState<Arms>([[], []]);
  const [selectedArm, setSelectedArm] = useState<number | null>(null);
  const [receivedAt, setReceivedAt] = useState(performance.now());
  const sequence = useRef(0);
  const generation = useRef(0);
  const previousEpoch = useRef(epoch);
  const readError = useRef(false);
  const {route, setRoute, routeRef, currentPath, navigate} = useMatchNavigation(
    base,
    setError,
    readError,
    setResult,
  );
  const storageKey = `${pendingKey}${base.startsWith('/m/') ? `.${base}` : base ? '.preview' : ''}`;
  const pendingRecord = useRef(readPending(storageKey));
  const persistPending = useCallback(
    (value: PendingRecord | null) => {
      pendingRecord.current = value;
      savePending(value, storageKey);
    },
    [storageKey],
  );
  const submitting = useRef(false);
  const snapshotRef = useRef(data);
  snapshotRef.current = data;
  const timelineKey = useRef('');
  const {unread, markRead} = useMessageReadState(data, base);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const path = routeRef.current;
    try {
      const next = await source.read(path);
      if (request !== sequence.current || path !== routeRef.current) {
        return;
      }
      const previous = snapshotRef.current;
      if (
        previous.session?.id === next.session?.id &&
        previous.match?.id === next.match?.id &&
        previous.match &&
        next.match &&
        previous.match.revision > next.match.revision
      ) {
        return;
      }
      if (
        previous.session?.id !== next.session?.id ||
        !next.player?.actions.includes('sighting')
      ) {
        setDraft([[], []]);
        setSelectedArm(null);
      }
      const nextTimelineKey = `${next.session?.id ?? ''}|${next.match?.id ?? ''}|${path}`;
      if (nextTimelineKey === timelineKey.current) {
        mergeSnapshotHistory(next, previous);
      }
      timelineKey.current = nextTimelineKey;
      setData(next);
      snapshotRef.current = next;
      setReceivedAt(performance.now());
      if (readError.current) {
        setError('');
        readError.current = false;
      }
      const stored = pendingRecord.current ?? readPending(storageKey);
      if (
        stored &&
        next.session &&
        stored.account === next.session.id &&
        stored.match === next.session.matchId
      ) {
        setPending(stored.id);
      } else {
        setPending(null);
        persistPending(null);
      }
    } catch (error) {
      if (request !== sequence.current) {
        return;
      }
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        timelineKey.current = '';
        snapshotRef.current = {...empty, site: snapshotRef.current.site};
        setData({...empty, site: snapshotRef.current.site});
        setDraft([[], []]);
        setSelectedArm(null);
        setPending(null);
        persistPending(null);
      }
      readError.current = true;
      setError(requireError(error).message);
    } finally {
      if (request === sequence.current) {
        setLoading(false);
      }
    }
  }, [source, persistPending, storageKey, routeRef]);
  const {loadEarlierEvents, loadJudgeRecords} = useMatchHistory({
    source,
    snapshotRef,
    routeRef,
    timelineKey,
    setData,
    setError,
  });
  const {recover, operate} = useMatchOperations({
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
  });
  const logout = async () => {
    const mine = generation.current;
    try {
      await source.logout();
      if (mine !== generation.current) {
        return;
      }
      generation.current++;
      timelineKey.current = '';
      sequence.current++;
      setData({...empty, site: data.site});
      setDraft([[], []]);
      setPending(null);
      persistPending(null);
      navigate('/');
    } catch (e) {
      if (mine !== generation.current) {
        return;
      }
      setError(requireError(e).message);
    }
  };
  useEffect(() => {
    generation.current++;
    sequence.current++;
    submitting.current = false;
    setLoading(true);
    setData(empty);
    snapshotRef.current = empty;
    setDraft([[], []]);
    setSelectedArm(null);
    setResult(null);
    setPending(null);
    setBusy(false);
    if (previousEpoch.current !== epoch) {
      persistPending(null);
    }
    previousEpoch.current = epoch;
    void refresh();
  }, [epoch, refresh, persistPending]);
  useSnapshotPolling(route, refresh);
  useEffect(() => {
    if (pending && !busy) {
      const timer = window.setTimeout(() => void recover(), 2500);
      return () => window.clearTimeout(timer);
    }
  }, [pending, busy, recover, result]);
  const online = useBrowserEvents(currentPath, setRoute, refresh);
  return (
    <Context.Provider
      value={{
        data,
        route,
        base,
        go: navigate,
        refresh,
        loadEarlierEvents,
        loadJudgeRecords,
        source,
        loading,
        busy,
        error,
        reportError,
        result,
        clearFeedback: () => {
          setError('');
          setResult(null);
        },
        operate,
        pending,
        recover,
        logout,
        names,
        setNames,
        reduced,
        setReduced,
        draft,
        setDraft,
        selectedArm,
        setSelectedArm,
        receivedAt,
        online,
        unread,
        markRead,
      }}
    >
      <div className={reduced ? 'app reduce-motion' : 'app'}>{children}</div>
    </Context.Provider>
  );
}
/** 从最近服务器时刻和本地单调经过时间生成显示时钟，最终截止由服务器裁决。 */
export function useClock() {
  const {data, receivedAt} = useApp();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, performance.now() - receivedAt);
  return {
    utc: (data.match?.serverUtcMs ?? Date.now()) + elapsed,
    game:
      (data.match?.gameMs ?? 0) +
      (data.match?.running && !data.match.paused ? elapsed : 0),
  };
}
