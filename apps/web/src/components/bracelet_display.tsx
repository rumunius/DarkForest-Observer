import {COLORS, type Arms, type ColorId} from '@darkforest/contracts';
import {useApp} from '../state';
import {CutOutline} from './cut_frame';

/** 紧凑展示双臂颜色集合，遵循站点统一七色色值。 */
export function MiniArms({arms}: {arms: Arms | null}) {
  const {data} = useApp();
  if (!arms) {
    return <span className="muted">暂无手环配置</span>;
  }
  return (
    <div className="mini-arms" aria-label="两侧手环配置">
      {arms.map((arm, i) => (
        <span
          className="mini-arm"
          key={i}
          aria-label={i ? '另一侧手臂' : '一侧手臂'}
        >
          {COLORS.filter(c => arm.includes(c.id)).map(c => (
            <span
              className="mini-band"
              key={c.id}
              title={c.name}
              aria-label={c.name}
              style={{backgroundColor: data.site.colors[c.id]}}
            />
          ))}
        </span>
      ))}
    </div>
  );
}

function Hand({mirror = false}: {mirror?: boolean}) {
  // Adapted from Tabler Icons hand-stop (MIT), with adjusted finger lengths and a forearm.
  // Source and license: docs/手部SVG参考与许可.md
  return (
    <svg className="hand" viewBox="0 0 180 360" aria-hidden="true">
      <g transform={mirror ? 'translate(180 0) scale(-1 1)' : undefined}>
        <path
          className="hand-silhouette"
          transform="translate(20 -1) scale(5 7)"
          vectorEffect="non-scaling-stroke"
          d="M6.8 51.6C7.4 42 8.3 32 9 26C9.2 24 8.8 22.7 7.196 20.3C6.884 19.821 5.489 17.312 3.21 13.172A1.5 1.5 0 0 1 3.746 11.15A1.867 1.867 0 0 1 6.026 11.43L8 14.1L7.6 5.5a1.3 1.3 0 0 1 2.6 0L10.8 10.3Q11 10.8 11.2 10.3V3.5a1.3 1.3 0 0 1 2.6 0V10.2Q14 10.7 14.2 10.2L14.7 5.75a1.3 1.3 0 0 1 2.6 0L17.1 10.7Q17.2 11.2 17.4 10.7L17.8 7.75a1.15 1.15 0 0 1 2.3 0L20 16C20 19 18.8 20.5 18.8 23L19 26C19.7 32 20.6 42 21.2 51.6Z"
        />
        <path
          className="hand-detail"
          d="M60 98C69 106 74 115 75 126M66 168Q90 173 114 168"
        />
      </g>
    </svg>
  );
}

/** 以两臂无序分组展示手环；编辑回调只修改草稿，不提交攻击。 */
export function ArmsView({
  arms,
  editable = false,
  selected = null,
  onSelect,
  onRemove,
}: {
  arms: Arms;
  editable?: boolean;
  selected?: number | null;
  onSelect?: (arm: number) => void;
  onRemove?: (id: ColorId) => void;
}) {
  const {data, names} = useApp();
  return (
    <div className={`arms ${editable ? 'editable-arms' : 'readonly-arms'}`}>
      {arms.map((arm, index) => (
        <div
          key={index}
          className={`arm ${selected === index ? 'selected' : ''}`}
          role="group"
          aria-label={index ? '另一侧手臂' : '一侧手臂'}
        >
          {editable ? (
            <button
              className="arm-select cut"
              onClick={() => onSelect?.(index)}
              aria-pressed={selected === index}
            >
              <CutOutline cut={10} />
              <span className="arm-title">
                {index ? '另一侧手臂' : '一侧手臂'}
              </span>
            </button>
          ) : (
            <div className="arm-title">{index ? '另一侧手臂' : '一侧手臂'}</div>
          )}
          <div className="arm-figure">
            <Hand mirror={index === 1} />
            <div className="arm-bands">
              {COLORS.filter(c => arm.includes(c.id)).map(c =>
                editable ? (
                  <button
                    key={c.id}
                    data-color={c.id}
                    className="wrist-band"
                    aria-label={`${c.name}，${index ? '另一侧手臂' : '一侧手臂'}，点击移除`}
                    onClick={() => onRemove?.(c.id)}
                  >
                    <span
                      data-swatch={c.id}
                      className="swatch"
                      style={{backgroundColor: data.site.colors[c.id]}}
                    />
                    {names && <span className="band-name">{c.name}</span>}
                  </button>
                ) : (
                  <div key={c.id} className="wrist-band">
                    <span
                      className="swatch"
                      style={{backgroundColor: data.site.colors[c.id]}}
                      role="img"
                      aria-label={c.name}
                    />
                    {names && <span className="band-name">{c.name}</span>}
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
