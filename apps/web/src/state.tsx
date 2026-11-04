import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Arms, DataSource, OperationResult, Snapshot } from '@darkforest/contracts';
import { DEFAULT_SITE } from './config';
import { ApiError } from './data/http';

const empty: Snapshot = {
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
interface AppContext {
  data: Snapshot;
  route: string;
  base: string;
  go: (path: string, replace?: boolean) => void;
  refresh: () => Promise<void>;
  source: DataSource;
  loading: boolean;
  busy: boolean;
  error: string;
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
export function useApp(): AppContext {
  const c = useContext(Context);
  if (!c) throw new Error('Missing application context');
  return c;
}
const positions = new Map<string, number>();
// Fragment navigation wins over page-position restoration, including browser Back/Forward.
function restorePosition() {
  const id = location.hash.slice(1).replace(/^rule-/, 'rules-');
  const target = id && document.getElementById(id);
  if (target) target.scrollIntoView({ block: 'start' });
  else if (!id) window.scrollTo(0, positions.get(location.pathname) ?? 0);
}
const pendingKey = 'darkforest.pending-operation';
type PendingRecord = { id: string; account: string; match: string; path?: string };
function readPending(key = pendingKey): PendingRecord | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as PendingRecord | null;
  } catch {
    return null;
  }
}
function savePending(value: PendingRecord | null, key = pendingKey) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* Memory state remains authoritative for this page. */
  }
}
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
  const currentPath = () => location.pathname.slice(base.length).replace(/\/$/, '') || '/';
  const [route, setRoute] = useState(currentPath);
  const [data, setData] = useState<Snapshot>(empty);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<OperationResult | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [names, setNames] = useState(false);
  const [reduced, setReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [draft, setDraft] = useState<Arms>([[], []]);
  const [selectedArm, setSelectedArm] = useState<number | null>(null);
  const [receivedAt, setReceivedAt] = useState(performance.now());
  const [online, setOnline] = useState(navigator.onLine);
  const [readIds, setReadIds] = useState<string[]>([]);
  const sequence = useRef(0);
  const generation = useRef(0);
  const previousEpoch = useRef(epoch);
  const readError = useRef(false);
  const storageKey = `${pendingKey}${base ? '.preview' : ''}`;
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
  const routeRef = useRef(route);
  routeRef.current = route;
  const accountKey = `${base ? 'preview.' : ''}darkforest.read.${data.session?.id ?? 'guest'}`;
  useEffect(() => {
    try {
      setReadIds(JSON.parse(sessionStorage.getItem(accountKey) ?? '[]') as string[]);
    } catch {
      setReadIds([]);
    }
  }, [accountKey]);
  const markRead = useCallback(
    (id: string) => {
      setReadIds((previous) => {
        if (previous.includes(id)) return previous;
        const next = [...previous, id];
        try {
          sessionStorage.setItem(accountKey, JSON.stringify(next));
        } catch {
          /* Reading preferences can stay in memory. */
        }
        return next;
      });
    },
    [accountKey],
  );
  const go = useCallback(
    (path: string, replace = false) => {
      positions.set(location.pathname, scrollY);
      const next = `${base}${path === '/' ? '/' : path}`;
      history[replace ? 'replaceState' : 'pushState']({}, '', next);
      setRoute(
        new URL(next, location.origin).pathname.slice(base.length).replace(/\/$/, '') || '/',
      );
      setError('');
      readError.current = false;
      setResult(null);
      requestAnimationFrame(restorePosition);
    },
    [base],
  );
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const path = routeRef.current;
    try {
      const next = await source.read(path);
      if (request !== sequence.current || path !== routeRef.current) return;
      const previous = snapshotRef.current;
      if (
        previous.session?.id === next.session?.id &&
        previous.match?.id === next.match?.id &&
        previous.match &&
        next.match &&
        previous.match.revision > next.match.revision
      )
        return;
      if (previous.session?.id !== next.session?.id || !next.player?.actions.includes('sighting')) {
        setDraft([[], []]);
        setSelectedArm(null);
      }
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
      )
        setPending(stored.id);
      else {
        setPending(null);
        persistPending(null);
      }
    } catch (e) {
      if (request !== sequence.current) return;
      if (e instanceof ApiError && [401, 403].includes(e.status)) {
        setData({ ...empty, site: snapshotRef.current.site });
        setDraft([[], []]);
        setSelectedArm(null);
        setPending(null);
        persistPending(null);
      }
      readError.current = true;
      setError(e instanceof Error ? e.message : '连接已中断，正在重新连接。');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [source, persistPending, storageKey]);
  const recover = useCallback(async () => {
    const stored = pendingRecord.current ?? readPending(storageKey);
    if (!stored || submitting.current) return;
    const mine = generation.current;
    submitting.current = true;
    setBusy(true);
    try {
      const response = await source.result(stored.id);
      if (mine !== generation.current) return;
      setResult(response);
      if (response.status === 'complete') {
        persistPending(null);
        setPending(null);
        if (stored.path === '/action/sighting') {
          setDraft([[], []]);
          setSelectedArm(0);
        }
        await refresh();
      }
    } catch (e) {
      if (mine !== generation.current) return;
      setError(e instanceof Error ? e.message : '暂时无法取得操作结果，请稍后查询。');
    } finally {
      if (mine === generation.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }, [source, refresh, persistPending, storageKey]);
  const operate = useCallback(
    async (path: string, payload: Record<string, unknown> = {}) => {
      if (submitting.current || pendingRecord.current || readPending(storageKey)) {
        setError('正在确认上一次操作结果。');
        return;
      }
      if (!navigator.onLine) {
        setError('连接已中断，请恢复网络后再提交。');
        return;
      }
      const session = snapshotRef.current.session;
      if (!session) return;
      const id = crypto.randomUUID();
      const mine = generation.current;
      submitting.current = true;
      setBusy(true);
      setError('');
      readError.current = false;
      setResult(null);
      persistPending({ id, account: session.id, match: session.matchId, path });
      setPending(id);
      try {
        const response = await source.submit({ path, payload, requestId: id });
        if (mine !== generation.current) return;
        setResult(response);
        if (response.status === 'complete') {
          persistPending(null);
          setPending(null);
          await refresh();
        }
        return response;
      } catch (e) {
        if (mine !== generation.current) return;
        const definitive =
          e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408;
        if (definitive) {
          persistPending(null);
          setPending(null);
          await refresh();
        }
        setError(e instanceof Error ? e.message : '操作结果尚未取得，正在确认上一次操作结果。');
      } finally {
        if (mine === generation.current) {
          submitting.current = false;
          setBusy(false);
        }
      }
    },
    [source, refresh, persistPending, storageKey],
  );
  const logout = async () => {
    try {
      await source.logout();
      generation.current++;
      sequence.current++;
      setData({ ...empty, site: data.site });
      setDraft([[], []]);
      setPending(null);
      persistPending(null);
      go('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : '退出登录未完成，请重试。');
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
    if (previousEpoch.current !== epoch) persistPending(null);
    previousEpoch.current = epoch;
    void refresh();
  }, [epoch, refresh, persistPending]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(
      () => {
        if (!document.hidden && navigator.onLine) void refresh();
      },
      route.startsWith('/judge')
        ? 3000
        : route.startsWith('/observer') || route.startsWith('/display')
          ? 5000
          : 2000,
    );
    return () => window.clearInterval(timer);
  }, [route, refresh]);
  useEffect(() => {
    if (pending && !busy) {
      const timer = window.setTimeout(() => void recover(), 2500);
      return () => window.clearTimeout(timer);
    }
  }, [pending, busy, recover, result]);
  useEffect(() => {
    const pop = () => {
      setRoute(currentPath());
      requestAnimationFrame(restorePosition);
    };
    const resume = () => {
      setOnline(navigator.onLine);
      if (!document.hidden && navigator.onLine) void refresh();
    };
    addEventListener('popstate', pop);
    addEventListener('online', resume);
    addEventListener('offline', resume);
    addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      removeEventListener('popstate', pop);
      removeEventListener('online', resume);
      removeEventListener('offline', resume);
      removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  });
  return (
    <Context.Provider
      value={{
        data,
        route,
        base,
        go,
        refresh,
        source,
        loading,
        busy,
        error,
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
        unread: data.events.filter((e) => e.audience === 'personal' && !readIds.includes(e.id))
          .length,
        markRead,
      }}
    >
      <div className={reduced ? 'app reduce-motion' : 'app'}>{children}</div>
    </Context.Provider>
  );
}
export function useClock() {
  const { data, receivedAt } = useApp();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, performance.now() - receivedAt);
  return {
    utc: (data.match?.serverUtcMs ?? Date.now()) + elapsed,
    game: (data.match?.gameMs ?? 0) + (data.match?.running && !data.match.paused ? elapsed : 0),
  };
}
