import {useEffect, useState, type Dispatch, type SetStateAction} from 'react';
import {restorePosition} from './state_navigation';

/** Schedule the next visible, online read only after the current poll finishes. */
export function useSnapshotPolling(
  route: string,
  refresh: () => Promise<void>,
): void {
  useEffect(() => {
    let stopped = false;
    let timer: number;
    const interval = route.startsWith('/judge')
      ? 3000
      : route.startsWith('/observer') || route.startsWith('/display')
        ? 5000
        : 2000;
    const poll = async () => {
      if (!document.hidden && navigator.onLine) {
        await refresh();
      }
      if (!stopped) {
        timer = window.setTimeout(() => void poll(), interval);
      }
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [route, refresh]);
}
/** Refresh on browser return and keep history navigation and network status synchronized. */
export function useBrowserEvents(
  currentPath: () => string,
  setRoute: Dispatch<SetStateAction<string>>,
  refresh: () => Promise<void>,
) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const pop = () => {
      setRoute(currentPath());
      requestAnimationFrame(restorePosition);
    };
    const resume = () => {
      setOnline(navigator.onLine);
      if (!document.hidden && navigator.onLine) {
        void refresh();
      }
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
  return online;
}
