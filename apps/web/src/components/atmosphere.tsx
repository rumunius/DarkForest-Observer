import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {useApp, useClock} from '../state';

// A true 4D wireframe: sixteen vertices, joined only along one coordinate.
const vertices = Array.from({length: 16}, (_, i) =>
  Array.from({length: 4}, (_, axis) => (i & (1 << axis) ? 1 : -1)),
);
const edges = vertices.flatMap((_, i) =>
  [0, 1, 2, 3]
    .filter(axis => !(i & (1 << axis)))
    .map(axis => [i, i | (1 << axis)]),
);

function projectHypercube(time: number) {
  const points = vertices.map(vertex => {
    const p: number[] = [...vertex];
    const rotations: Array<[number, number, number]> = [
      [0, 3, time * 0.12 + 0.4],
      [1, 2, time * 0.07 + 0.3],
      [0, 2, time * 0.04 + 0.45],
    ];
    for (const [a, b, angle] of rotations) {
      const x = p[a]!;
      const y = p[b]!;
      p[a] = x * Math.cos(angle) - y * Math.sin(angle);
      p[b] = x * Math.sin(angle) + y * Math.cos(angle);
    }
    const w = 2.8 / (3.6 - p[3]!);
    const depth = 3.6 / (4.5 - p[2]! * w);
    return [p[0]! * w * depth * 112, p[1]! * w * depth * 112];
  });
  // Perspective shifts the projected silhouette even when the SVG itself is centered.
  const center = [0, 1].map(axis => {
    const coordinates = points.map(point => point[axis]!);
    return (Math.min(...coordinates) + Math.max(...coordinates)) / 2;
  });
  const centered = points.map(point =>
    point.map((value, axis) => 300 + value - center[axis]!),
  );
  return edges
    .map(([a, b]) => `M${centered[a!]!.join(',')}L${centered[b!]!.join(',')}`)
    .join('');
}

function Hypercube({still}: {still: boolean}) {
  const path = useRef<SVGPathElement>(null);
  const phase = useRef(0);
  useEffect(() => {
    if (still) {
      return;
    }
    let frame = 0;
    let previous = 0;
    const draw = (now: number) => {
      if (now - previous >= 32) {
        // Resume at the same pose after a hidden tab or a paused match.
        phase.current += previous ? Math.min(now - previous, 64) / 1000 : 0;
        path.current?.setAttribute('d', projectHypercube(phase.current));
        previous = now;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [still]);
  return (
    <svg className="dimension-projection" viewBox="0 0 600 600" fill="none">
      <path ref={path} d={projectHypercube(0)} />
    </svg>
  );
}

function SignalFracture({
  mode,
  still,
}: {
  mode: 'impact' | 'hunt';
  still: boolean;
}) {
  const [expired, setExpired] = useState(still);
  useEffect(() => {
    if (mode !== 'impact') {
      return;
    }
    // Consume an interrupted entry effect; never replay it when resuming.
    const timer = setTimeout(() => setExpired(true), still ? 0 : 900);
    return () => clearTimeout(timer);
  }, [mode, still]);
  if (still || (mode === 'impact' && expired)) {
    return null;
  }
  const bands =
    'M0 182h96m12 0h42M890 228h110M0 416h46m9 0h35M918 584h82M0 762h112M864 816h52m12 0h72';
  return (
    <svg
      className="signal-fracture"
      data-mode={mode}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      fill="none"
    >
      <path d={bands} vectorEffect="non-scaling-stroke" />
      <path d={bands} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** 按已发生赛事状态和动效偏好绘制气氛覆盖层，不阻挡页面交互。 */
export function Atmosphere() {
  const {data, route, reduced} = useApp();
  const {utc} = useClock();
  const attachLayer = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      return;
    }
    if (typeof element.showPopover !== 'function') {
      element.removeAttribute('popover');
      return;
    }
    // The native top layer also clears transformed ancestors and modal stacking contexts.
    // A manual, non-focusable popover adds no backdrop, focus trap or light dismissal.
    const lift = () => {
      if (!element.isConnected) {
        return;
      }
      if (element.matches(':popover-open')) {
        element.hidePopover();
      }
      element.showPopover();
    };
    lift();
    const dialogs = new MutationObserver(records => {
      if (
        records.some(
          ({target}) => target instanceof HTMLDialogElement && target.open,
        )
      ) {
        lift();
      }
    });
    dialogs.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    return () => {
      dialogs.disconnect();
      if (element.matches(':popover-open')) {
        element.hidePopover();
      }
    };
  }, []);
  const [hidden, setHidden] = useState(document.hidden);
  const [systemReduced, setSystemReduced] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const preference = () => setSystemReduced(media.matches);
    document.addEventListener('visibilitychange', visibility);
    media.addEventListener('change', preference);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      media.removeEventListener('change', preference);
    };
  }, []);
  const me = data.player;
  const match = data.match;
  if (
    data.session?.role !== 'player' ||
    !me ||
    !match ||
    match.stage === 'ended' ||
    !/^\/(player|observer)(\/|$)/.test(route)
  ) {
    return null;
  }

  const restricted = me.flight === 'active' && me.attackLockedUntil > utc;
  const state =
    me.flight === 'eliminated'
      ? me.observerAllowed
        ? 'observer'
        : 'eliminated'
      : ['returning', 'preparing', 'issued'].includes(me.flight) &&
          me.respawnDeadline !== null
        ? 'wreck'
        : me.flight !== 'active'
          ? 'none'
          : match.stage === 'transfer' || match.verification
            ? 'transfer'
            : match.stage === 'hunt'
              ? 'hunt'
              : !me.homeAlive
                ? 'last-life'
                : restricted
                  ? 'restricted'
                  : 'none';
  if (state === 'none') {
    return null;
  }
  const still = reduced || systemReduced || hidden || match.paused;
  return (
    <div
      ref={attachLayer}
      className="state-atmosphere"
      popover="manual"
      data-state={state}
      data-restricted={restricted || undefined}
      data-still={still || undefined}
      aria-hidden="true"
    >
      <div className="atmosphere-edge" />
      {state === 'observer' ? (
        <Hypercube still={still} />
      ) : (
        <svg className="signal-orbit" viewBox="0 0 520 520" fill="none">
          <circle cx="260" cy="260" r="202" strokeDasharray="410 45 150 665" />
          <circle cx="260" cy="260" r="210" strokeDasharray="64 1255" />
          <path d="m111 123 12 12m274 250 12 12M57 260h16m374 0h16" />
        </svg>
      )}
      <div className="atmosphere-dust">
        {Array.from({length: 10}, (_, i) => (
          <i
            key={i}
            style={
              {
                '--x': `${(i * 37 + 7) % 100}%`,
                '--y': `${(i * 23 + 11) % 100}%`,
                '--delay': `${-i * 2.7}s`,
                '--drift': `${(i % 2 ? 1 : -1) * (12 + i * 2)}px`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      {(state === 'wreck' || state === 'eliminated' || state === 'hunt') && (
        <SignalFracture
          key={state}
          mode={state === 'hunt' ? 'hunt' : 'impact'}
          still={still}
        />
      )}
    </div>
  );
}
