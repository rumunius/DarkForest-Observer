import { COLORS, validArms, type Arms, type ColorId } from '@darkforest/contracts';
import { moveColor, wrongConsequence } from '../core/model';
import { armSvg, e, swatch } from '../ui';

export interface SightingDraft {
  arms: Arms;
  side: 0 | 1 | null;
  names: boolean;
}
export class SightingEditor {
  private abort = new AbortController();
  private drag: {
    id: ColorId;
    pointer: number;
    x: number;
    y: number;
    active: boolean;
    element: HTMLElement;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private suppressClick = false;
  private locked = false;
  private placeholder: HTMLElement | null = null;
  constructor(
    private host: HTMLElement,
    public draft: SightingDraft,
    private wrong: number,
    private submit: (arms: Arms) => void,
    private offline: () => boolean,
  ) {
    this.render();
    host.addEventListener('click', (event) => this.click(event), { signal: this.abort.signal });
    host.addEventListener('pointerdown', (event) => this.down(event), {
      signal: this.abort.signal,
    });
    host.addEventListener(
      'touchmove',
      (event) => {
        if (this.drag?.active) event.preventDefault();
      },
      { signal: this.abort.signal, passive: false },
    );
    window.addEventListener('pointermove', (event) => this.move(event), {
      signal: this.abort.signal,
      passive: false,
    });
    window.addEventListener('pointerup', (event) => this.up(event), { signal: this.abort.signal });
    for (const type of ['pointercancel', 'blur', 'resize'])
      window.addEventListener(type, () => this.cancel(), { signal: this.abort.signal });
    document.addEventListener('visibilitychange', () => this.cancel(), {
      signal: this.abort.signal,
    });
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') this.cancel();
      },
      { signal: this.abort.signal },
    );
  }
  destroy() {
    this.cancel();
    this.abort.abort();
  }
  lock() {
    this.locked = true;
    this.cancel();
    this.render();
  }
  private announce(message: string) {
    const live = this.host.querySelector('[role="status"]');
    if (live) live.textContent = message;
  }
  private render(focusId?: string) {
    const old = new Map<string, DOMRect>();
    this.host
      .querySelectorAll<HTMLElement>('[data-color]')
      .forEach((el) => old.set(el.dataset.color!, el.getBoundingClientRect()));
    const { arms, side, names } = this.draft;
    this.host.innerHTML = `<div class="arms editor" aria-label="目击手环输入">${arms
      .map(
        (arm, i) =>
          `<section class="arm ${side === i ? 'selected' : ''}" data-drop="${i}"><button class="arm-select" data-side="${i}" ${this.locked ? 'disabled' : ''} aria-pressed="${side === i}"><strong>${i === 0 ? '一侧手臂' : '另一侧手臂'}</strong><span>${side === i ? '正在选择' : arm.length ? `${arm.length}条` : '尚未选择'}</span></button><div class="arm-visual" data-side="${i}">${armSvg}<div class="bands">${COLORS.filter(
            (c) => arm.includes(c.id),
          )
            .map((c) =>
              this.colorButton(c.id, `${c.name}，${i === 0 ? '一侧手臂' : '另一侧手臂'}，点击移除`),
            )
            .join('')}</div></div></section>`,
      )
      .join(
        '',
      )}</div><p class="selection-help" role="status">${this.locked ? '正在确认攻击结果' : side === null ? '先选一侧手臂，再选颜色' : '点击手环可退回色盘，也可以拖到另一侧。'}</p><div class="palette" data-drop="palette" aria-label="可选手环颜色">${COLORS.map((c) => (arms.flat().includes(c.id) ? '<span class="palette-space" aria-hidden="true"></span>' : this.colorButton(c.id, `${c.name}，点击移入当前手臂`))).join('')}</div><div class="editor-tools"><button class="text-button" data-edit="names" aria-pressed="${names}">${names ? '隐藏' : '显示'}颜色名称</button>${!this.locked && arms.flat().length ? '<button class="text-button" data-edit="clear">清空选择</button>' : ''}${!this.locked && arms.every((a) => a.length) ? '<button class="text-button" data-edit="swap">交换两侧</button>' : ''}</div><p class="muted compact">同侧顺序不限，两侧可以交换。</p><div class="consequence"><p>提交错误目击码的次数：${this.wrong}次</p><p>${wrongConsequence(this.wrong)}</p></div><div class="confirm-area">${this.locked ? '<p>正在确认攻击结果，请勿重复提交。</p>' : validArms(arms) ? '<button class="primary" data-edit="submit">确认攻击<span aria-hidden="true">↗</span></button>' : '<p class="muted">请选完两侧手臂的颜色。两侧数量应为两条与一条、两条与两条，或三条与一条。</p>'}</div>`;
    if (focusId)
      this.host
        .querySelector<HTMLElement>(`[data-color="${focusId}"]`)
        ?.focus({ preventScroll: true });
    if (
      !matchMedia('(prefers-reduced-motion: reduce)').matches &&
      document.documentElement.dataset.motion !== 'reduce'
    ) {
      this.host.querySelectorAll<HTMLElement>('[data-color]').forEach((el) => {
        const rect = old.get(el.dataset.color!);
        const now = el.getBoundingClientRect();
        if (rect && (rect.x !== now.x || rect.y !== now.y))
          el.animate(
            [
              {
                transform: `translate(${rect.x - now.x}px, ${rect.y - now.y}px) scale(${rect.width / now.width}, ${rect.height / now.height})`,
              },
              { transform: 'none' },
            ],
            { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)' },
          );
      });
    }
  }
  private colorButton(id: ColorId, label: string) {
    return `<button class="color-button" data-color="${id}" aria-label="${e(label)}" ${this.locked ? 'disabled' : ''}>${swatch(id)}${this.draft.names ? `<span class="color-name">${COLORS.find((c) => c.id === id)!.name}</span>` : ''}</button>`;
  }
  private commit(id: ColorId, target: 0 | 1 | null) {
    const result = moveColor(this.draft.arms, id, target);
    if (result.error) {
      this.announce(result.error);
      return;
    }
    this.draft.arms = result.arms;
    this.render(id);
    this.announce(
      `${COLORS.find((c) => c.id === id)!.name}已${target === null ? '退回色盘' : `移到${target === 0 ? '一侧手臂' : '另一侧手臂'}，共${this.draft.arms[target].length}条`}`,
    );
  }
  private click(event: MouseEvent) {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const el = (event.target as Element).closest<HTMLElement>(
      '[data-color],[data-side],[data-edit]',
    );
    if (!el) return;
    if (el.dataset.edit === 'names') {
      this.draft.names = !this.draft.names;
      this.render();
      return;
    }
    if (this.locked || this.drag?.active) return;
    const id = el.dataset.color as ColorId | undefined;
    if (id) {
      if (this.draft.arms.flat().includes(id)) this.commit(id, null);
      else if (this.draft.side === null) this.announce('请先选择一侧手臂。');
      else this.commit(id, this.draft.side);
    } else if (el.dataset.side !== undefined) {
      this.draft.side = Number(el.dataset.side) as 0 | 1;
      this.render();
      this.host
        .querySelector<HTMLButtonElement>(`button[data-side="${this.draft.side}"]`)
        ?.focus({ preventScroll: true });
    } else if (el.dataset.edit === 'clear') {
      this.draft.arms = [[], []];
      this.draft.side = null;
      this.render();
      this.host.querySelector<HTMLButtonElement>('[data-side]')?.focus();
    } else if (el.dataset.edit === 'swap') {
      this.draft.arms = [this.draft.arms[1], this.draft.arms[0]];
      this.render();
    } else if (el.dataset.edit === 'submit' && validArms(this.draft.arms)) {
      if (this.offline()) {
        this.announce('连接中断，请恢复连接后再提交。');
        return;
      }
      const arms = structuredClone(this.draft.arms);
      this.lock();
      this.submit(arms);
    }
  }
  private down(event: PointerEvent) {
    const element = (event.target as Element).closest<HTMLElement>('[data-color]');
    if (!element || this.locked || event.button !== 0 || this.drag) return;
    this.drag = {
      id: element.dataset.color as ColorId,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      active: false,
      element,
      timer: null,
    };
    if (event.pointerType !== 'mouse') this.drag.timer = setTimeout(() => this.lift(), 180);
  }
  private lift() {
    const drag = this.drag;
    if (!drag) return;
    drag.active = true;
    const rect = drag.element.getBoundingClientRect();
    this.placeholder = document.createElement('span');
    this.placeholder.style.cssText = `display:block;width:${rect.width}px;height:${rect.height}px;min-height:${rect.height}px`;
    this.placeholder.setAttribute('aria-hidden', 'true');
    drag.element.before(this.placeholder);
    drag.element.style.width = `${rect.width}px`;
    drag.element.style.height = `${rect.height}px`;
    drag.element.classList.add('dragging');
    drag.element.style.left = `${drag.x - rect.width / 2}px`;
    drag.element.style.top = `${drag.y - rect.height / 2 - 20}px`;
    this.host.classList.add('is-dragging');
  }
  private move(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
    if (!drag.active && event.pointerType === 'mouse' && distance > 6) this.lift();
    else if (!drag.active && distance > 8) {
      this.cancel();
      return;
    }
    if (!drag.active) return;
    event.preventDefault();
    drag.element.style.left = `${event.clientX - drag.element.offsetWidth / 2}px`;
    drag.element.style.top = `${event.clientY - drag.element.offsetHeight / 2 - 20}px`;
    this.host.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest('[data-drop]')
      ?.classList.add('drop-target');
  }
  private up(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.active) {
      this.cancel();
      return;
    }
    const drop = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-drop]')?.dataset.drop;
    this.suppressClick = true;
    setTimeout(() => {
      this.suppressClick = false;
    }, 0);
    this.cancel();
    if (drop === 'palette') this.commit(drag.id, null);
    else if (drop === '0' || drop === '1') {
      this.draft.side = Number(drop) as 0 | 1;
      this.commit(drag.id, this.draft.side);
    }
  }
  private cancel() {
    if (!this.drag) return;
    if (this.drag.timer) clearTimeout(this.drag.timer);
    this.drag.element.classList.remove('dragging');
    this.drag.element.removeAttribute('style');
    this.placeholder?.remove();
    this.placeholder = null;
    this.drag = null;
    this.host.classList.remove('is-dragging');
    this.host.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  }
}
