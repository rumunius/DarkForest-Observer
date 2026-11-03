import { braceletColors, events, type Arms, type ColorId } from '../lib/model';
const iconPaths: Record<string, string> = {
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  target:
    '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v5m0 12v5M1 12h5m12 0h5"/>',
  wave: '<path d="M2 12h3l3-8 5 16 4-12 2 4h3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  mail: '<rect x="2.5" y="4.5" width="19" height="15"/><path d="m3 5 9 8 9-8"/>',
  person: '<circle cx="12" cy="7" r="4"/><path d="M4 21c0-4.5 3.5-7 8-7s8 2.5 8 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  shield: '<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z"/><path d="m8 12 3 3 5-6"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  bell: '<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H3v13h5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  reset: '<path d="M3 10a9 9 0 1 1 2 8M3 3v7h7"/>',
};
export function icon(name: string, cls = ''): string {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.globe}</svg>`;
}
export function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export function brand(): string {
  return `<a href="#/" class="brand" aria-label="黑暗森林首页"><span>黑暗森林</span></a>`;
}
export function swatch(id: ColorId, large = false): string {
  const c = braceletColors.find((item) => item.id === id)!;
  return `<svg class="swatch ${large ? 'large' : ''}" viewBox="0 0 32 32" role="img" aria-label="${c.name}"><rect x="1" y="1" width="30" height="30" fill="${c.hex}" stroke="currentColor" stroke-opacity=".55"/></svg>`;
}
export function configuration(value: Arms, compact = false): string {
  return `<div class="configuration ${compact ? 'compact' : ''}">${value.map((arm, i) => `<div class="arm-config">${!compact ? `<span class="muted">${i === 0 ? '一侧手臂' : '另一侧手臂'}</span>` : ''}<div class="swatches">${arm.map((id) => swatch(id)).join('')}${arm.length === 0 ? '<span class="muted">尚未选择</span>' : ''}</div></div>`).join('<span class="arm-divider" aria-hidden="true"></span>')}</div>`;
}
export function button(text: string, action: string, style = '', extra = ''): string {
  return `<button class="btn ${style}" data-action="${action}" ${extra}>${text}</button>`;
}
export function sectionTitle(label: string, _n: string, extra = ''): string {
  return `<div class="section-heading"><h2>${label}</h2>${extra}</div>`;
}
export function tag(text: string, tone = ''): string {
  return `<span class="tag ${tone}">${text}</span>`;
}

export function navItem(path: string, name: string, ico: string, activeRoute: string): string {
  const active = activeRoute === path;
  return `<a href="#${path}" class="nav-item ${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}>${icon(ico)}<span>${name}</span>${active ? '<span class="nav-marker"></span>' : ''}</a>`;
}
export function shell(
  content: string,
  judge = false,
  isPaused = false,
  activeRoute = judge ? '/judge' : '/play',
): string {
  const nav = (path: string, name: string, ico: string) => navItem(path, name, ico, activeRoute);
  const playerNav = `${nav('/play', '状态', 'target')}${nav('/play/sighting', '目击', 'eye')}${nav('/play/messages', '消息', 'mail')}${nav('/play/self', '我的', 'person')}`;
  const sectionNav = judge
    ? `${nav('/judge', '裁判工作台', 'grid')}${nav('/judge/display', '观战大屏', 'globe')}`
    : playerNav;
  const secondaryNav = `<a class="nav-item" href="#/rules">${icon('globe')}<span>比赛规则</span></a><a class="nav-item" href="#${judge ? '/play' : '/judge'}">${icon('shield')}<span>${judge ? '玩家界面' : '裁判工作台'}</span></a>`;
  return `<div class="app-shell"><aside class="sidebar">${brand()}<nav aria-label="${judge ? '裁判' : '玩家'}导航">${sectionNav}</nav><div class="sidebar-bottom">${secondaryNav}<div class="identity"><span class="avatar">${judge ? icon('shield') : '07'}</span><div><strong>${judge ? '总裁判' : 'C07 远星'}</strong><span>${judge ? '裁判' : '第二次航行'}</span></div></div></div></aside><div class="app-body"><header class="topbar"><div class="breadcrumb"><a href="#/">黑暗森林</a><span aria-hidden="true">›</span><span>${judge ? '裁判' : '玩家'}</span></div><div class="mobile-identity"><strong>${judge ? '总裁判' : 'C07 远星'}</strong></div><div class="topbar-right"><span class="connection">${isPaused ? '比赛已暂停' : '比赛进行中'}</span></div></header><main id="main" class="workspace">${content}</main></div><nav class="mobile-nav ${judge ? 'judge-nav' : 'player-nav'}" aria-label="${judge ? '裁判' : '玩家'}导航">${judge ? sectionNav : playerNav}</nav></div>`;
}
export function pageHeading(eyebrow: string, title: string, desc: string, trailing = ''): string {
  return `<div class="page-heading"><div>${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}<h1>${title}</h1>${desc ? `<p>${desc}</p>` : ''}</div>${trailing}</div>`;
}
export function eventList(max = 3, civilization?: string): string {
  return `<ol class="event-list">${events
    .filter((event) => !civilization || event.text.includes(civilization))
    .slice(0, max)
    .map(
      (event) =>
        `<li><span class="event-marker ${event.kind}">${icon(event.kind === 'broadcast' ? 'wave' : event.kind === 'hit' ? 'target' : 'globe')}</span><div><time class="mono">${event.time}</time><h3>${event.title}</h3><p>${event.text}</p></div></li>`,
    )
    .join('')}</ol>`;
}
