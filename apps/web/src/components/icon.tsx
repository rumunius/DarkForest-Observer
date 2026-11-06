import {type ReactNode} from 'react';

const paths: Record<string, ReactNode> = {
  current: (
    <>
      <path d="M4 4h16v16H4zM4 10h16M9 10v10" />
    </>
  ),
  action: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  message: (
    <>
      <path d="M3 5h18v14H3zM3 6l9 7 9-7" />
    </>
  ),
  me: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 21v-3a7 7 0 0 1 14 0v3" />
    </>
  ),
  arrow: <path d="m9 5 7 7-7 7M3 12h12" />,
  back: <path d="m14 5-7 7 7 7M7 12h14" />,
  check: <path d="m5 12 4 4L19 6" />,
  copy: (
    <>
      <path d="M8 8h12v13H8zM16 8V3H3v13h5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  planet: (
    <g transform="rotate(-20 12 12)" strokeLinecap="round">
      <path d="M2 12A10 3.5 0 0 1 6.802 9.01M17.198 9.01A10 3.5 0 0 1 22 12" />
      <circle cx="12" cy="12" r="6" />
      <path d="M2 12A10 3.5 0 0 0 22 12" />
    </g>
  ),
  broadcast: (
    <>
      <path d="M8 8a6 6 0 0 0 0 8m8-8a6 6 0 0 1 0 8M5 4a11 11 0 0 0 0 16m14-16a11 11 0 0 1 0 16" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  photon: (
    <>
      <path d="M12 2v5m0 10v5M2 12h5m10 0h5" />
      <circle cx="12" cy="12" r="5" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  alert: (
    <>
      <path d="m12 3 10 18H2L12 3Zm0 5v6m0 3v1" />
    </>
  ),
  list: <path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1" />,
  settings: (
    <>
      <path d="M3 6h18M3 18h18M8 3v6m8 6v6" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="16" cy="18" r="2" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="m7 3 14 9-14 9V3Z" />,
  logout: <path d="M9 4H3v16h6m6-13 5 5-5 5M8 12h12" />,
};

/** 绘制注册的装饰性SVG图标，业务含义由可访问文字提供。 */
export function Icon({name, size = 24}: {name: string; size?: number}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="miter"
      strokeLinecap="square"
      aria-hidden="true"
    >
      {paths[name] ?? paths.current}
    </svg>
  );
}
