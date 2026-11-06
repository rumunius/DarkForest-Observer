import {
  COLORS,
  validArms,
  type Arms,
  type ColorId,
} from '@darkforest/contracts';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {moveBracelet} from '../bracelets';
import {handleAsync} from '../data/async_event';
import {attackWarning} from '../rule_text';
import {useApp} from '../state';
import {ArmsView} from './bracelet_display';
import {AttackConfirmation} from './confirmation';
import {Button} from './cut_frame';
import {Icon} from './icon';

/** 维护当前目击草稿、选臂和确认流程，忙碌或离线期间保留受控状态。 */
export function ColorEditor() {
  const {
    reportError,
    draft,
    setDraft,
    selectedArm,
    setSelectedArm,
    data,
    names,
    reduced,
    busy,
    pending,
    online,
    operate,
  } = useApp();
  const [confirmation, setConfirmation] = useState<Arms | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef(new Map<string, DOMRect>());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const locked = busy || !!pending || !online;
  const valid = validArms(draft);
  const capturePositions = () => {
    root.current
      ?.querySelectorAll<HTMLElement>('[data-swatch]')
      .forEach(element => {
        previous.current.set(
          element.dataset.swatch!,
          element.getBoundingClientRect(),
        );
      });
  };
  useEffect(() => {
    setSelectedArm(0);
    root.current
      ?.querySelector<HTMLElement>('.arm-select')
      ?.focus({preventScroll: true});
  }, [setSelectedArm]);
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    root.current
      ?.querySelectorAll<HTMLElement>('[data-swatch]')
      .forEach(element => {
        const key = element.dataset.swatch!;
        const rect = element.getBoundingClientRect();
        const old = previous.current.get(key);
        if (
          old &&
          !reduced &&
          (old.x !== rect.x || old.y !== rect.y || old.width !== rect.width)
        ) {
          element.getAnimations().forEach(a => a.cancel());
          element.animate(
            [
              {
                transform: `translate(${old.x - rect.x}px,${old.y - rect.y}px) scale(${old.width / rect.width},${old.height / rect.height})`,
              },
              {transform: 'none'},
            ],
            {duration: 300, easing: 'cubic-bezier(.22,1,.36,1)'},
          );
        }
        next.set(key, rect);
      });
    previous.current = next;
  }, [draft, reduced]);
  useEffect(() => {
    const settle = () => {
      root.current
        ?.querySelectorAll('[data-swatch], .palette-color')
        .forEach(element => {
          element.getAnimations().forEach(animation => animation.cancel());
        });
      previous.current.clear();
    };
    window.addEventListener('resize', settle);
    window.addEventListener('blur', settle);
    document.addEventListener('visibilitychange', settle);
    if (reduced || locked) {
      settle();
    }
    return () => {
      window.removeEventListener('resize', settle);
      window.removeEventListener('blur', settle);
      document.removeEventListener('visibilitychange', settle);
    };
  }, [reduced, locked]);
  const rejectPaletteColor = (id: ColorId) => {
    const element = root.current?.querySelector<HTMLElement>(
      `.palette-color[data-color="${id}"]`,
    );
    if (!element) {
      return;
    }
    element.getAnimations().forEach(animation => animation.cancel());
    const still =
      reduced || matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.animate(
      still
        ? [
            {boxShadow: 'inset 0 0 0 1px var(--attention)'},
            {boxShadow: 'inset 0 0 0 1px transparent'},
          ]
        : [
            {transform: 'translateX(0)'},
            {transform: 'translateX(-4px)'},
            {transform: 'translateX(4px)'},
            {transform: 'translateX(-3px)'},
            {transform: 'translateX(3px)'},
            {transform: 'translateX(0)'},
          ],
      {duration: still ? 160 : 260, easing: 'ease-out'},
    );
  };
  const move = (id: ColorId, target: number | null) => {
    if (locked) {
      return;
    }
    const result = moveBracelet(draftRef.current, id, target);
    if ('error' in result) {
      rejectPaletteColor(id);
      return;
    }
    const next = result.arms;
    target = result.target;
    if (target !== null) {
      setSelectedArm(target);
    }
    const viewport = {x: window.scrollX, y: window.scrollY};
    capturePositions();
    setDraft(next);
    requestAnimationFrame(() => {
      root.current
        ?.querySelector<HTMLElement>(`[data-color="${id}"]`)
        ?.focus({preventScroll: true});
      // Reparenting the focused color must not scroll the player's input away.
      window.scrollTo(viewport.x, viewport.y);
    });
  };
  const click = (id: ColorId, remove = false) => {
    if (locked) {
      return;
    }
    if (remove) {
      move(id, null);
    } else if (selectedArm === null) {
      rejectPaletteColor(id);
    } else {
      move(id, selectedArm);
    }
  };
  useEffect(() => {
    if (locked) {
      setConfirmation(null);
    }
  }, [locked]);
  const wrong = data.player?.wrongCount ?? 0;
  return (
    <div ref={root} className={`color-editor ${locked ? 'input-locked' : ''}`}>
      {locked && (
        <p className="attention" role="status">
          {!online ? '连接已中断，保留当前选择。' : '正在确认攻击结果'}
        </p>
      )}
      <ArmsView
        arms={draft}
        editable={!locked}
        selected={selectedArm}
        onSelect={setSelectedArm}
        onRemove={id => click(id, true)}
      />
      <p className="arm-caption">同侧顺序不限，两侧可以交换。</p>
      {!locked && (
        <>
          <div className="palette" aria-label="共享七色盘">
            {COLORS.map(c =>
              draft.flat().includes(c.id) ? (
                <span key={c.id} className="palette-space" aria-hidden="true" />
              ) : (
                <button
                  key={c.id}
                  type="button"
                  data-color={c.id}
                  className="palette-color"
                  aria-label={`${c.name}，色盘，点击移入所选手臂`}
                  onClick={() => click(c.id)}
                >
                  <span
                    className="swatch"
                    data-swatch={c.id}
                    style={{backgroundColor: data.site.colors[c.id]}}
                  />
                  {names && <span className="color-name">{c.name}</span>}
                </button>
              ),
            )}
          </div>
          <div className="editor-tools">
            <div>
              {draft.flat().length > 0 && (
                <button
                  className="text-button"
                  onClick={() => {
                    const viewport = {x: window.scrollX, y: window.scrollY};
                    capturePositions();
                    setDraft([[], []]);
                    setSelectedArm(0);
                    requestAnimationFrame(() => {
                      root.current
                        ?.querySelector<HTMLElement>('.arm-select')
                        ?.focus({preventScroll: true});
                      window.scrollTo(viewport.x, viewport.y);
                    });
                  }}
                >
                  清空选择
                </button>
              )}
            </div>
          </div>
        </>
      )}
      <div className="attack-commit">
        <div
          className={`attack-consequence ${wrong > 0 ? 'consequence-danger' : ''}`}
        >
          <p className="secondary">
            提交错误手环颜色的次数 <strong className="numeric">{wrong}</strong>
          </p>
          <p>{attackWarning(wrong, data.parameters)}</p>
        </div>
        {valid && !locked ? (
          <Button
            className="primary full attack-submit"
            onClick={() => setConfirmation([[...draft[0]], [...draft[1]]])}
          >
            <Icon name="action" size={20} />
            确认攻击
            <Icon name="arrow" size={20} />
          </Button>
        ) : (
          !locked && (
            <p className="confirm-hint">
              {draft.every(a => a.length)
                ? '两侧数量应为两条与一条、两条与两条，或三条与一条。'
                : '请选完两侧手臂的颜色。'}
            </p>
          )
        )}
      </div>
      {confirmation && valid && !locked && (
        <AttackConfirmation
          arms={confirmation}
          wrong={wrong}
          onCancel={() => {
            setConfirmation(null);
            requestAnimationFrame(() =>
              root.current
                ?.querySelector<HTMLElement>('.attack-submit')
                ?.focus({preventScroll: true}),
            );
          }}
          onConfirm={handleAsync(async () => {
            const arms = confirmation;
            setConfirmation(null);
            const response = await operate('/action/sighting', {
              arm_a: arms[0],
              arm_b: arms[1],
            });
            if (response?.status === 'complete') {
              setDraft([[], []]);
              setSelectedArm(0);
            }
          }, reportError)}
        />
      )}
    </div>
  );
}
