import {
  COLORS,
  type Arms,
  type Bracelet,
  type Civilization,
  type ColorId,
  type SiteConfig,
} from '@darkforest/contracts';
import { flightLabels, homeLabels } from './core/model';

export const e = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const link = (href: string, label: string, primary = false) =>
  `<a class="${primary ? 'button primary' : 'text-link'}" href="${e(href)}" data-link>${e(label)}${primary ? '<span aria-hidden="true">↗</span>' : ''}</a>`;
export const button = (label: string, action: string, primary = false) =>
  `<button class="${primary ? 'primary' : 'secondary'}" data-command="${e(action)}">${e(label)}</button>`;
export const heading = (title: string, back?: string) =>
  `<header class="page-heading">${back ? link(back, '返回') : ''}<h1 tabindex="-1">${e(title)}</h1></header>`;
export const empty = (message = '当前没有相应记录。') => `<p class="empty">${e(message)}</p>`;
export const identity = (c: Pick<Civilization, 'id' | 'nickname'>) =>
  `<div class="identity"><span class="civilization-id">${e(c.id)}</span><span>${e(c.nickname || '尚未设置昵称')}</span></div>`;
export const field = (label: string, name: string, value = '', type = 'text', extra = '') =>
  `<label class="field">${e(label)}<input name="${e(name)}" type="${type}" value="${e(value)}" ${extra}></label>`;
export const coordinate = (value = '') =>
  `${field('六位母星口令', 'code', value, 'text', 'inputmode="numeric" autocomplete="off" maxlength="6" pattern="[0-9]{6}" required aria-describedby="code-help"')}<p class="muted" id="code-help">请输入6位数字，开头的0也需要保留。</p>`;
export const icon = (name: string) => {
  const paths: Record<string, string> = {
    current: '<path d="M4 4h16v16H4zM8 9h8M8 14h5"/>',
    action:
      '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    message: '<path d="M3 5h18v14H3zM3 6l9 7 9-7"/>',
    me: '<circle cx="12" cy="7" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>',
    home: '<circle cx="12" cy="12" r="7"/><path d="M3 18 21 6"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${paths[name] ?? paths.current}</svg>`;
};
export const armSvg = `<svg class="arm-drawing" viewBox="0 0 160 230" fill="none" aria-hidden="true"><path d="M47 228V104L27 78 20 61 27 55 44 71 45 30 52 23 59 29 61 56 63 17 70 11 77 17 78 55 83 10 90 6 97 12 94 57 104 24 112 21 118 29 111 75 112 89 103 106 108 228" stroke="currentColor" stroke-width="1.7" stroke-linejoin="bevel"/></svg>`;
export function setColors(config: SiteConfig) {
  for (const c of COLORS)
    document.documentElement.style.setProperty(
      `--ring-${c.id}`,
      /^#[0-9a-f]{6}$/i.test(config.colors[c.id]) ? config.colors[c.id] : c.hex,
    );
}
export const swatch = (id: ColorId) =>
  `<span class="swatch ring-${id}" role="img" aria-label="${COLORS.find((c) => c.id === id)?.name}"></span>`;
export const smallArms = (arms: Arms) =>
  `<div class="small-arms" aria-label="两侧手环配置">${arms
    .map(
      (arm, i) =>
        `<span class="small-arm" aria-label="${i === 0 ? '一侧手臂' : '另一侧手臂'}">${COLORS.filter(
          (c) => arm.includes(c.id),
        )
          .map((c) => swatch(c.id))
          .join('')}</span>`,
    )
    .join('<span class="arm-divider" aria-hidden="true"></span>')}</div>`;
export function bracelets(b: Bracelet, showNames = false): string {
  return `<div class="bracelet-caption"><span>第${b.flight}航次</span><span>${b.status === 'retired' ? '已失效' : b.status === 'reserved' ? '等待佩戴确认' : '本航次手环'}</span></div><div class="arms readonly">${b.arms
    .map(
      (arm, i) =>
        `<section class="arm"><h2>${i === 0 ? '一侧手臂' : '另一侧手臂'}</h2><span class="muted">${arm.length}条</span><div class="arm-visual">${armSvg}<div class="bands">${COLORS.filter(
          (c) => arm.includes(c.id),
        )
          .map(
            (c) =>
              `<div class="band-readonly">${swatch(c.id)}${showNames ? `<span>${c.name}</span>` : ''}</div>`,
          )
          .join('')}</div></div></section>`,
    )
    .join(
      '',
    )}</div><p class="muted">同侧顺序不限，两侧可以交换。</p>${b.activated_at ? `<p>生效时间：${e(b.activated_at)}</p>` : ''}${b.retired_at ? `<p>失效时间：${e(b.retired_at)}</p>` : ''}`;
}
export const civilizationSummary = (c: Civilization) =>
  `${identity(c)}<dl class="facts"><div><dt>飞船状态</dt><dd>${flightLabels[c.flight_status]}</dd></div><div><dt>母星状态</dt><dd>${homeLabels[c.home_status]}</dd></div>${c.home_code ? `<div><dt>母星口令</dt><dd class="code">${e(c.home_code)}</dd></div>` : ''}<div><dt>已击毁的不同文明数</dt><dd>${c.unique_sight_kills}</dd></div><div><dt>正式广播剩余次数</dt><dd>${c.broadcast_remaining}</dd></div><div><dt>持有光粒</dt><dd>${c.photon_remaining}枚</dd></div></dl>`;
