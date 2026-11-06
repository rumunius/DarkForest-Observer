import {
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

/** Build the shared closed outline, including both diagonal cut edges. */
export function notchPath(
  width: number,
  height: number,
  cut: number,
  inset = 0.5,
): string {
  return `M ${cut} ${inset} H ${width - inset} V ${height - cut} L ${width - cut} ${height - inset} H ${inset} V ${cut} Z`;
}
/** A closed stroked path draws BOTH diagonal edges; clip-path alone cannot. */
export function CutOutline({cut = 6}: {cut?: number}) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({width: 1, height: 1});
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) {
      return;
    }
    const update = () => {
      const {width, height} = parent.getBoundingClientRect();
      setSize({width, height});
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  return (
    <svg
      ref={ref}
      className="cut-outline"
      width="100%"
      height="100%"
      aria-hidden="true"
    >
      <path className="cut-fill" d={notchPath(size.width, size.height, cut)} />
      <path
        className="cut-focus"
        d={notchPath(size.width + 6, size.height + 6, cut + 2)}
        transform="translate(-3 -3)"
      />
    </svg>
  );
}
/** Wrap content with the shared outline without changing the inner layout. */
export function Frame({
  children,
  className = '',
  cut = 10,
}: {
  children: ReactNode;
  className?: string;
  cut?: number;
}) {
  return (
    <div className={`cut frame ${className}`}>
      <CutOutline cut={cut} />
      <div className="frame-content">{children}</div>
    </div>
  );
}
/** Native button semantics with the shared cut outline and content wrapper. */
export function Button({
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`cut button ${className}`} {...props}>
      <CutOutline />
      <span className="button-content">{children}</span>
    </button>
  );
}
