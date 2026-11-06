import type {OperationResult} from '@darkforest/contracts';
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
const positions = new Map<string, number>();
/** Fragment destinations take precedence over remembered page scroll positions. */
export function restorePosition() {
  const id = location.hash.slice(1).replace(/^rule-/, 'rules-');
  const target = id && document.getElementById(id);
  if (target) {
    target.scrollIntoView({block: 'start'});
  } else if (!id) {
    window.scrollTo(0, positions.get(location.pathname) ?? 0);
  }
}
/** Own the route and scroll restoration; navigation clears feedback without resetting pending operations. */
export function useMatchNavigation(
  base: string,
  setError: Dispatch<SetStateAction<string>>,
  readError: RefObject<boolean>,
  setResult: Dispatch<SetStateAction<OperationResult | null>>,
) {
  const currentPath = () =>
    location.pathname.slice(base.length).replace(/\/$/, '') || '/';
  const [route, setRoute] = useState(currentPath);
  const routeRef = useRef(route);
  routeRef.current = route;
  const navigate = useCallback(
    (path: string, replace = false) => {
      positions.set(location.pathname, scrollY);
      const next = `${base}${path === '/' ? '/' : path}`;
      history[replace ? 'replaceState' : 'pushState']({}, '', next);
      setRoute(
        new URL(next, location.origin).pathname
          .slice(base.length)
          .replace(/\/$/, '') || '/',
      );
      setError('');
      readError.current = false;
      setResult(null);
      requestAnimationFrame(restorePosition);
    },
    [base, setError, readError, setResult],
  );
  return {route, setRoute, routeRef, currentPath, navigate};
}
