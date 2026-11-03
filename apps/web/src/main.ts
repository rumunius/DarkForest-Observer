import './styles.css';
import {
  COLORS,
  isCoordinateCode,
  validNickname,
  type Action,
  type OperationResult,
  type PageData,
  type Preview,
  type SessionState,
  type SiteConfig,
} from '@darkforest/contracts';
import { ApiError, Client } from './core/api';
import { actionPaths, canAct, clockNow, formatDuration, phaseLabels } from './core/model';
import { knownRoute, mayRead, pageEndpoint } from './core/routes';
import { SightingEditor, type SightingDraft } from './components/sighting';
import { playerPage } from './pages/player';
import { has, judgePage, judgePages } from './pages/judge';
import { observePage } from './pages/observe';
import { rulesPage } from './pages/rules';
import { e, empty, heading, icon, link, setColors } from './ui';

const root = document.querySelector<HTMLDivElement>('#app')!;
const client = new Client();
let config: SiteConfig = {
  version: 0,
  name: '黑暗森林：观察者效应',
  description: '一场以现场观察、文明生存与信息博弈为核心的实景游戏。请使用独立参赛口令进入比赛。',
  timezone: 'Asia/Shanghai',
  qq_group: '',
  judge_contact: '',
  endgame_file: '终局圈图片',
  room_file: '裁判室说明',
  colors: Object.fromEntries(COLORS.map((c) => [c.id, c.hex])) as SiteConfig['colors'],
};
let path = location.pathname;
let pageData: PageData | null = null;
let editor: SightingEditor | null = null;
let draft: SightingDraft = { arms: [[], []], side: null, names: false };
let loading = true;
let connected = navigator.onLine;
let networkMessage = '';
let lastSync = '';
let pageFailure = '';
let pageRequest = 0;
let busy = false;
let feedback = '';
let lastStateSignature = '';
let expiryRefresh = 0;
let liveTimeout: ReturnType<typeof setTimeout> | undefined;
let pollTimeout: ReturnType<typeof setTimeout>;
let autoTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight = false;
const scrollPositions = new Map<string, number>();
const formDrafts = new Map<string, Record<string, string>>();
const readEvents = new Set<string>();
const channel =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('forest.session') : null;
let previewPayload: { endpoint: string; body: Record<string, unknown>; preview: Preview } | null =
  null;
let pendingReturn = '';
let devPreview = '';
let renderedPath = path;
let booted = false;
let lastPagePoll = 0;
let boundaryPending = false;
let deferredPageData: PageData | null = null;

const guest = () => ['/', '/login', '/judge/login', '/rules'].includes(path);
const home = () => (client.state?.role === 'judge' ? '/judge' : '/player');
function announce(message: string, persistent = false) {
  const node = document.querySelector('#live-message');
  if (node) node.textContent = message;
  clearTimeout(liveTimeout);
  if (!persistent)
    liveTimeout = setTimeout(() => {
      if (node) node.textContent = '';
    }, 3000);
}
function signature(s: SessionState) {
  return JSON.stringify({
    account: s.account_id,
    match: s.match.id,
    phase: s.match.phase,
    pause: s.match.paused,
    reason: s.match.pause_reason,
    review: s.match.hunt_review,
    me: s.me,
    actions: s.allowed_actions,
    permissions: s.permissions,
    observer: s.observer_allowed,
    results: s.results_allowed,
    status: s.status_message,
  });
}
function saveDrafts() {
  if (!renderedPath || !client.state) return;
  const values: Record<string, string> = {};
  root
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('form [name]')
    .forEach((input) => {
      if (
        input.name !== 'credential' &&
        input.type !== 'password' &&
        input.type !== 'hidden' &&
        input.type !== 'checkbox'
      )
        values[input.name] = input.value;
    });
  if (Object.keys(values).length) formDrafts.set(renderedPath, values);
}
function restoreDrafts() {
  const values = formDrafts.get(path);
  root
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('form [name]')
    .forEach((input) => {
      if (values && input.name in values && input.type !== 'hidden')
        input.value = values[input.name]!;
    });
  const code = new URLSearchParams(location.search).get('code');
  const codeInput = root.querySelector<HTMLInputElement>('input[name=code]');
  if (codeInput && code && isCoordinateCode(code) && !values?.code) codeInput.value = code;
  updateFormValidity();
}
function navItems(s: SessionState, mobile: boolean): [string, string, string][] {
  if (path.startsWith('/observer'))
    return [
      ['/observer', '战况', 'current'],
      ['/observer/civilizations', '文明', 'action'],
      ['/observer/events', '事件', 'message'],
      ['/player/me', '我的', 'me'],
    ];
  if (s.role === 'judge') {
    if (mobile)
      return [
        ['/judge', '工作台', 'current'],
        ['/judge/tasks', '待办', 'message'],
        ['/judge/players', '文明', 'action'],
        ['/judge/more', '更多', 'me'],
      ];
    return judgePages
      .filter((p) => has(s, p[0]) || p[0] === 'account')
      .map((p) => [p[2], p[1], '']);
  }
  return [
    ['/player', '当前', 'current'],
    ['/player/actions', '行动', 'action'],
    ['/player/messages', '消息', 'message'],
    ['/player/me', '我的', 'me'],
  ];
}
function nav(s: SessionState, mobile: boolean) {
  const items = navItems(s, mobile);
  const active = path.startsWith('/player/actions')
    ? '/player/actions'
    : path.startsWith('/player/messages')
      ? '/player/messages'
      : [
            '/player/me',
            '/player/bracelets',
            '/player/account',
            '/player/help',
            '/player/records',
            '/player/intel',
            '/player/exception',
          ].includes(path)
        ? '/player/me'
        : path;
  return `<nav class="${mobile ? 'bottom-nav' : 'side-nav'}" aria-label="${mobile ? '主要功能' : '工作空间'}">${items.map(([href, label, ico]) => `<a href="${href}" data-link class="nav-item" ${active === href || (href !== '/judge' && href !== '/player' && active.startsWith(href + '/')) ? 'aria-current="page"' : ''}>${ico ? icon(ico) : ''}<span>${label}</span></a>`).join('')}</nav>`;
}
function render() {
  const openSections =
    renderedPath === path
      ? [...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map(
          (el) => el.querySelector('summary')?.textContent,
        )
      : [];
  saveDrafts();
  editor?.destroy();
  editor = null;
  const s =
    client.state && boundaryPending
      ? { ...client.state, allowed_actions: [], status_message: '比赛状态正在更新，请稍候。' }
      : client.state;
  const entry = !s || ['/login', '/judge/login'].includes(path);
  const display = path === '/display';
  let content: string;
  if (!knownRoute(path))
    content = heading('页面不存在') + link(s ? home() : '/', '返回当前页面', true);
  else if (path === '/rules') content = rulesPage();
  else if (loading && !guest()) content = heading('正在连接') + empty('正在读取账号与比赛状态…');
  else if (path === '/')
    content = `<div class="entry-topline"></div><h1 class="entry-title">黑暗森林<span>观察者效应</span></h1><p class="muted">${e(config.description)}</p><div class="entry-actions">${link('/login', '玩家登录', true)}${link('/judge/login', '裁判入口')}${link('/rules', '阅读比赛规则')}</div>`;
  else if (path === '/login' || path === '/judge/login')
    content =
      heading(path === '/login' ? '玩家登录' : '裁判登录', '/') +
      `<p class="muted">${path === '/login' ? '输入你收到的独立参赛口令。' : '使用独立裁判凭证进入工作空间。'}</p><form data-login><label class="field">${path === '/login' ? '参赛口令' : '裁判凭证'}<input name="credential" type="password" autocomplete="current-password" required></label><label class="check"><input type="checkbox" id="show-credential">显示输入内容</label><button class="primary" type="submit">进入比赛<span aria-hidden="true">↗</span></button><p class="field-error" id="login-error" role="alert"></p></form>${link('/rules', '比赛规则')}`;
  else if (!s)
    content =
      heading('请重新登录') +
      `<p>${e(networkMessage || '登录后查看本场比赛。')}</p>${link('/login', '玩家登录', true)}${link('/judge/login', '裁判登录')}`;
  else if (!mayRead(path, s))
    content =
      heading('无查看权限') +
      empty('当前账号不能查看这项内容。') +
      link(home(), '返回当前页面', true);
  else if (path.startsWith('/player')) content = playerPage(path, s, config, pageData);
  else if (path.startsWith('/judge')) content = judgePage(path, s, config, pageData);
  else content = observePage(path, s, pageData);
  const title = content.match(/<h1[^>]*>([^<]+)/)?.[1] ?? config.name;
  document.title = `${title} — 黑暗森林`;
  root.innerHTML = `<a class="skip-link" href="#main">跳到主要内容</a>${!entry && s ? `<header class="app-top"><span class="space-name">${display ? '宇宙观测' : s.role === 'judge' ? '赛事工作空间' : (s.me?.id ?? '')}</span><span class="phase">${phaseLabels[s.match.phase]}${s.match.paused ? '　已暂停' : ''}</span><span class="top-clock">比赛时间 <strong data-game-time></strong></span></header>` : ''}${networkMessage ? `<div class="connection" role="status">${e(networkMessage)}${lastSync ? ` 最近同步：${e(lastSync)}` : ''} <button data-command="refresh" class="text-button">重新连接</button></div>` : ''}<div class="app-layout ${entry ? 'entry-layout' : s?.role === 'judge' && !display ? 'judge-layout' : ''} ${display ? 'display-layout' : ''}">${!entry && s && !display ? nav(s, false) : ''}<main id="main">${feedback ? `<div class="feedback" role="status">${feedback}<button data-command="dismiss-feedback" class="text-button">收起结果</button></div>` : ''}${client.pending ? `<div class="feedback"><p>正在确认上一次操作结果。</p><button data-command="recover">查询操作结果</button></div>` : ''}${pageFailure ? `<div class="feedback" role="alert">${e(pageFailure)}<button data-command="reload-page">重新读取</button></div>` : ''}${content}</main>${!entry && s && !display ? nav(s, true) : ''}</div><div id="live-message" role="status" aria-live="polite"></div><dialog id="confirmation" aria-labelledby="dialog-title"></dialog>`;
  renderedPath = path;
  restoreDrafts();
  root.querySelectorAll<HTMLDetailsElement>('details').forEach((el) => {
    if (openSections.includes(el.querySelector('summary')?.textContent)) el.open = true;
  });
  const host = root.querySelector<HTMLElement>('#sighting-editor');
  if (host && s) {
    editor = new SightingEditor(
      host,
      draft,
      s.me!.wrong_count,
      (arms) => void perform(actionPaths.sighting, { arm_a: arms[0], arm_b: arms[1] }, true),
      () => !connected || busy,
    );
    if (client.pending || busy) editor.lock();
  }
  tick();
}
function navigate(url: string, replace = false) {
  const target = new URL(url, location.origin);
  if (target.origin !== location.origin) return;
  if (import.meta.env.DEV && devPreview && !target.searchParams.has('preview'))
    target.searchParams.set('preview', devPreview);
  saveDrafts();
  scrollPositions.set(path + location.search, window.scrollY);
  if (replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  path = target.pathname;
  pageData = null;
  deferredPageData = null;
  pageFailure = '';
  pageRequest++;
  previewPayload = null;
  clearInterval(autoTimer);
  render();
  void loadPage();
  requestAnimationFrame(() => {
    root.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
    if (target.hash) document.getElementById(target.hash.slice(1))?.scrollIntoView();
    else window.scrollTo(0, scrollPositions.get(path + location.search) ?? 0);
  });
}
async function loadPage(append = false, cursor?: string) {
  if (!client.state || !mayRead(path, client.state)) return;
  let endpoint = pageEndpoint(path, location.search);
  if (!endpoint) return;
  if (cursor)
    endpoint += `${endpoint.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
  const request = ++pageRequest;
  const account = client.state.account_id;
  const scope = path;
  try {
    const data = await client.get<PageData>(endpoint);
    if (
      request !== pageRequest ||
      account !== client.state?.account_id ||
      scope !== path ||
      !mayRead(path, client.state)
    )
      return;
    if (pageData && data.version < pageData.version) return;
    if (pageData && JSON.stringify(data) === JSON.stringify(pageData)) return;
    if (
      pageData &&
      !append &&
      data.events?.some((ev) => !pageData?.events?.some((old) => old.id === ev.id)) &&
      (path.endsWith('/messages') || path.endsWith('/events')) &&
      scrollY > 80
    ) {
      deferredPageData = data;
      if (!root.querySelector('[data-command="new-events"]')) {
        const trigger = document.createElement('button');
        trigger.dataset.command = 'new-events';
        trigger.textContent = '有新消息，点击更新';
        root.querySelector('main')?.prepend(trigger);
      }
      return;
    }
    if (root.querySelector('dialog[open]')) return;
    if (append && pageData) {
      data.events = [...(pageData.events ?? []), ...(data.events ?? [])];
      data.civilizations = [...(pageData.civilizations ?? []), ...(data.civilizations ?? [])];
    }
    pageData = data;
    pageFailure = '';
    if (data.event) readEvents.add(data.event.id);
    const y = scrollY;
    render();
    window.scrollTo(0, y);
    if (path === '/judge/commands') {
      const historyData = await client.get<PageData>('/api/judge/command/history');
      if (request === pageRequest && path === scope && mayRead(path, client.state!)) {
        pageData.events = historyData.events ?? [];
        render();
      }
    }
  } catch (error) {
    if (request !== pageRequest) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      pageData = null;
      if (error.status === 401) expire();
      else {
        pageFailure = '当前账号不能查看这项内容。';
        render();
      }
    } else {
      pageFailure = error instanceof Error ? error.message : '记录读取失败。';
      render();
    }
  }
}
function expire() {
  client.clear();
  pageData = null;
  draft = { arms: [[], []], side: null, names: false };
  formDrafts.clear();
  feedback = '';
  previewPayload = null;
  pageRequest++;
  renderedPath = '';
  deferredPageData = null;
  boundaryPending = false;
  networkMessage = '请重新登录';
  loading = false;
  lastStateSignature = '';
  render();
}
async function refresh() {
  if (refreshInFlight || !booted) return;
  refreshInFlight = true;
  try {
    const previous = client.state;
    const s = await client.refresh();
    connected = true;
    networkMessage = '';
    lastSync = new Intl.DateTimeFormat('zh-CN', {
      timeZone: config.timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());
    loading = false;
    if (!s) return;
    boundaryPending =
      !!s.match.clock.phase_end_game_ms && s.match.clock.game_ms >= s.match.clock.phase_end_game_ms;
    if (
      previous &&
      (previous.account_id !== s.account_id ||
        previous.match.id !== s.match.id ||
        (previous.observer_allowed && !s.observer_allowed) ||
        (previous.results_allowed && !s.results_allowed))
    ) {
      pageData = null;
      pageRequest++;
      formDrafts.clear();
      feedback = '';
      previewPayload = null;
    }
    if (!canAct(s, 'sighting')) {
      draft = { arms: [[], []], side: null, names: draft.names };
      editor?.destroy();
    }
    const sig = signature(s);
    if (path === '/' || path === '/login' || path === '/judge/login') {
      navigate(pendingReturn && mayRead(pendingReturn, s) ? pendingReturn : home(), true);
      pendingReturn = '';
    } else if (sig !== lastStateSignature || root.querySelector('.connection')) {
      render();
      if (!mayRead(path, s)) {
        pageData = null;
        render();
      }
    }
    lastStateSignature = sig;
    if (!previous || sig !== signature(previous) || performance.now() - lastPagePoll > 5000) {
      lastPagePoll = performance.now();
      void loadPage();
    }
    if (client.pending) {
      const result = await client.recover();
      if (result.status === 'completed') await showResult(result, false);
    }
  } catch (error) {
    loading = false;
    if (error instanceof ApiError && error.status === 401) {
      if (!guest()) pendingReturn = path;
      if (client.state || !guest() || !root.querySelector('main')) expire();
    } else {
      connected = false;
      networkMessage = navigator.onLine
        ? '连接已中断，正在重新连接。'
        : '当前处于离线状态，恢复连接后可继续提交。';
      if (!client.state || !root.querySelector('.connection')) render();
    }
  } finally {
    refreshInFlight = false;
    schedulePoll();
  }
}
function schedulePoll() {
  clearTimeout(pollTimeout);
  const interval = document.hidden
    ? 30000
    : path === '/display' || path.startsWith('/observer') || path.startsWith('/results')
      ? 5000
      : client.state?.role === 'judge'
        ? 3000
        : 2000;
  pollTimeout = setTimeout(() => void refresh(), interval);
}
function tick() {
  const s = client.state;
  if (!s) return;
  const now = clockNow(s, performance.now() - client.synchronizedAt);
  if (
    s.match.clock.phase_end_game_ms &&
    now.game >= s.match.clock.phase_end_game_ms &&
    !boundaryPending
  ) {
    boundaryPending = true;
    render();
    return;
  }
  root.querySelectorAll('[data-game-time]').forEach((el) => {
    el.textContent = formatDuration(now.game);
  });
  root.querySelectorAll('[data-real-time]').forEach((el) => {
    el.textContent = new Intl.DateTimeFormat('zh-CN', {
      timeZone: config.timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(now.utc);
  });
  root.querySelectorAll<HTMLElement>('[data-countdown]').forEach((el) => {
    const remaining =
      Number(el.dataset.countdown) - (el.dataset.base === 'utc' ? now.utc : now.game);
    el.textContent = remaining > 0 ? formatDuration(remaining) : '正在更新';
    if (remaining <= 0 && performance.now() - expiryRefresh > 1800) {
      expiryRefresh = performance.now();
      void refresh();
    }
  });
  if (
    s.match.clock.phase_end_game_ms &&
    now.game >= s.match.clock.phase_end_game_ms &&
    performance.now() - expiryRefresh > 1800
  ) {
    expiryRefresh = performance.now();
    void refresh();
  }
}
async function showResult(result: OperationResult, sighting: boolean) {
  if (result.status !== 'completed') {
    feedback = '正在确认上一次操作结果。';
    render();
    return;
  }
  if (sighting || result.result) {
    draft = { arms: [[], []], side: null, names: draft.names };
  }
  feedback =
    result.result === 'hit'
      ? `<h2>已击毁目标飞船</h2><p>${e(result.target?.id)}（${e(result.target?.nickname)}）</p><p>获得母星情报：<span class="code">${e(result.homeworld_intel)}</span></p>${link('/player/intel', '查看母星情报')}`
      : result.result === 'no_hit'
        ? `<h2>本次目击未产生击毁</h2><p>提交错误目击码的次数：${result.wrong_count ?? client.state?.me?.wrong_count ?? 0}次</p>`
        : e(result.message ?? '操作已完成。');
  await refresh();
  render();
  void loadPage();
}
async function perform(endpoint: string, body: Record<string, unknown>, sighting = false) {
  if (busy || !connected || !navigator.onLine) {
    announce('请恢复连接后再提交。');
    return;
  }
  busy = true;
  editor?.lock();
  root
    .querySelectorAll<HTMLButtonElement>('form button[type=submit]')
    .forEach((el) => (el.disabled = true));
  try {
    const result = await client.submit(endpoint, body);
    formDrafts.delete(path);
    renderedPath = '';
    if (endpoint === '/api/judge/site-config' && result.status === 'completed') {
      config = await client.get<SiteConfig>('/api/public/site-config');
      setColors(config);
      channel?.postMessage('config');
    }
    await showResult(result, sighting);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) expire();
    else {
      feedback = e(error instanceof Error ? error.message : '提交未完成。');
      if (error instanceof ApiError && error.status === 409) {
        previewPayload = null;
        formDrafts.delete(path);
        feedback = '这项记录已更新，请核对最新版本后重新确认。';
        await refresh();
        await loadPage();
      } else if (error instanceof ApiError && error.status === 403) {
        await refresh();
      }
    }
  } finally {
    busy = false;
    render();
  }
}
function formBody(form: HTMLFormElement): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const eliminations: { player_id: string; reason: string }[] = [];
  const colors: Record<string, string> = {};
  for (const [key, value] of new FormData(form)) {
    if (typeof value !== 'string' || key === 'confirmed') continue;
    if (key.startsWith('eliminate:')) {
      if (value) eliminations.push({ player_id: key.slice(10), reason: value });
    } else if (key.startsWith('color:')) colors[key.slice(6)] = value;
    else if (key === 'expected_version' || key === 'duration_seconds') body[key] = Number(value);
    else if (key === 't0_utc_ms' || key === 't1_utc_ms') body[key] = new Date(value).getTime();
    else body[key] = value;
  }
  if (form.dataset.admin === '/api/judge/hunt-finalize') body.eliminations = eliminations;
  if (Object.keys(colors).length) body.colors = colors;
  if (body.elimination_reason) {
    body.reason = body.elimination_reason;
    delete body.elimination_reason;
  }
  return body;
}
async function preview(endpoint: string, body: Record<string, unknown>, command = false) {
  if (busy || !connected || client.pending) {
    announce('请先完成当前操作或恢复连接。');
    return;
  }
  busy = true;
  try {
    const response = await client.post<Preview & { read_only?: boolean; message?: string }>(
      command ? '/api/judge/command/preview' : '/api/judge/operations/preview',
      command ? body : { endpoint, payload: body },
    );
    if (response.read_only) {
      feedback = e(response.message ?? response.summary);
      render();
      return;
    }
    previewPayload = { endpoint, body, preview: response };
    const dialog = root.querySelector<HTMLDialogElement>('#confirmation')!;
    dialog.innerHTML = `<h2 id="dialog-title">确认操作影响</h2><p>${e(response.summary)}</p><dl class="facts">${response.changes.map((c) => `<div><dt>${e(c.label)}<br>${e(c.before)}</dt><dd>${e(c.after)}</dd></div>`).join('')}</dl><ul>${response.consequences.map((c) => `<li>${e(c)}</li>`).join('')}</ul><p class="muted">预览版本：${response.version}</p><div class="dialog-actions"><button data-command="cancel-preview">返回修改</button><button class="primary" data-command="execute-preview">确认执行</button></div>`;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button')?.focus();
  } catch (error) {
    announce(error instanceof Error ? error.message : '预览失败。', true);
  } finally {
    busy = false;
  }
}
function updateFormValidity() {
  root.querySelectorAll<HTMLFormElement>('form').forEach((form) => {
    const code = form.querySelector<HTMLInputElement>('[name=code]');
    const submit = form.querySelector<HTMLElement>('[data-valid-submit]');
    if (code && submit) submit.hidden = !isCoordinateCode(code.value);
    const nickname = form.querySelector<HTMLInputElement>('[name=nickname]');
    if (nickname) {
      const out = form.querySelector('[data-nickname-preview]');
      if (out)
        out.textContent = nickname.value ? `${client.state?.me?.id}（${nickname.value}）` : '';
    }
  });
}
root.addEventListener('submit', (event) => {
  const form = event.target as HTMLFormElement;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const body = formBody(form);
  if (form.hasAttribute('data-login')) {
    if (busy) return;
    busy = true;
    const credential = String(body.credential ?? '');
    void client
      .post('/api/auth/exchange', { credential })
      .then(() => {
        (form.elements.namedItem('credential') as HTMLInputElement).value = '';
        channel?.postMessage('changed');
        return refresh();
      })
      .catch((error) => {
        const el = root.querySelector('#login-error');
        if (el) el.textContent = error instanceof Error ? error.message : '登录失败，请重试。';
      })
      .finally(() => {
        busy = false;
      });
    return;
  }
  if (form.hasAttribute('data-event-filter')) {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) if (value) q.set(key, String(value));
    navigate(path + '?' + q);
    return;
  }
  if (form.dataset.action) {
    const action = form.dataset.action as Action;
    if (!client.state || !canAct(client.state, action)) {
      void refresh();
      return;
    }
    if ('code' in body && !isCoordinateCode(body.code)) {
      announce('请输入6位数字，开头的0也需要保留。');
      return;
    }
    if (action === 'nickname' && !validNickname(String(body.nickname))) {
      announce('昵称需要2—8个汉字或等长字符。');
      return;
    }
    void perform(actionPaths[action], body);
    return;
  }
  if (form.dataset.directAdmin) {
    void perform(form.dataset.directAdmin, body);
    return;
  }
  if (form.dataset.admin) {
    void preview(form.dataset.admin, body);
    return;
  }
  if (form.hasAttribute('data-console')) void preview('/api/judge/command/execute', body, true);
});
root.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLElement>('a,button');
  if (!target) return;
  if (target.matches('a[data-link]')) {
    const anchor = target as HTMLAnchorElement;
    if (event.ctrlKey || event.metaKey || event.shiftKey || anchor.target) return;
    if (anchor.getAttribute('href')?.startsWith('#')) return;
    event.preventDefault();
    navigate(anchor.href);
    return;
  }
  if (target.dataset.copy !== undefined) {
    void (async () => {
      try {
        await navigator.clipboard.writeText(target.dataset.copy!);
        announce('已复制，请到QQ粘贴。');
        if (target.dataset.notice && has(client.state!, 'notice-write'))
          await perform(`/api/judge/notices/${encodeURIComponent(target.dataset.notice)}/copied`, {
            expected_version: Number(target.dataset.version),
          });
      } catch {
        const dialog = root.querySelector<HTMLDialogElement>('#confirmation')!;
        dialog.innerHTML = `<h2 id="dialog-title">手动复制消息</h2><p>请长按下方消息，选择复制。</p><textarea readonly rows="8">${e(target.dataset.copy)}</textarea><button data-command="cancel-preview">关闭</button>`;
        dialog.showModal();
      }
    })();
    return;
  }
  if (target.dataset.tab) {
    const q = new URLSearchParams(location.search);
    q.set('tab', target.dataset.tab);
    q.delete('page');
    navigate(path + '?' + q);
    return;
  }
  if (target.dataset.page !== undefined) {
    const q = new URLSearchParams(location.search);
    q.set('page', target.dataset.page);
    navigate(path + '?' + q);
    return;
  }
  if (target.dataset.fillCommand) {
    const input = root.querySelector<HTMLTextAreaElement>('[name=command]');
    if (input) {
      input.value = target.dataset.fillCommand;
      input.focus();
    }
    return;
  }
  if (target.dataset.export) {
    void exportReport(target.dataset.export);
    return;
  }
  const command = target.dataset.command;
  if (command === 'refresh') void refresh();
  if (command === 'reload-page') void loadPage();
  if (command === 'new-events' && deferredPageData) {
    pageData = deferredPageData;
    deferredPageData = null;
    render();
  }
  if (command === 'dismiss-feedback') {
    feedback = '';
    render();
  }
  if (command === 'more') void loadPage(true, target.dataset.cursor);
  if (command === 'recover')
    void client
      .recover()
      .then((r) => showResult(r, false))
      .catch((error) => announce(error instanceof Error ? error.message : '暂时无法确认结果。'));
  if (command === 'logout')
    void client
      .post('/api/auth/logout', {})
      .then(() => {
        client.clearPending();
        expire();
        channel?.postMessage('logout');
        navigate('/', true);
      })
      .catch((error) => announce(error instanceof Error ? error.message : '退出未完成，请重试。'));
  if (command === 'cancel-preview') {
    root.querySelector<HTMLDialogElement>('dialog')?.close();
    previewPayload = null;
  }
  if (command === 'execute-preview' && previewPayload) {
    const p = previewPayload;
    previewPayload = null;
    root.querySelector<HTMLDialogElement>('dialog')?.close();
    void perform(p.endpoint, {
      ...p.body,
      preview_token: p.preview.token,
      expected_version: p.preview.version,
    });
  }
  if (command === 'reset-colors') {
    for (const c of COLORS) {
      const input = root.querySelector<HTMLInputElement>(`[name="color:${c.id}"]`);
      const picker = root.querySelector<HTMLInputElement>(`[data-color-input="${c.id}"]`);
      if (input) input.value = c.hex;
      if (picker) picker.value = c.hex;
    }
    announce('本表已恢复初始色值，尚未保存。');
  }
});
async function exportReport(scope: string) {
  try {
    const report = await client.get<{ filename: string; content: string }>(
      `/api/judge/export?scope=${encodeURIComponent(scope)}`,
    );
    const url = URL.createObjectURL(
      new Blob([report.content], { type: 'text/plain;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = report.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    announce(error instanceof Error ? error.message : '导出失败。');
  }
}
function applyFilters() {
  const term =
    root.querySelector<HTMLInputElement>('[data-filter]')?.value.toLocaleLowerCase() ?? '';
  const status = root.querySelector<HTMLSelectElement>('[data-status-filter]')?.value ?? '';
  root
    .querySelectorAll<HTMLElement>('[data-search]')
    .forEach(
      (row) =>
        (row.hidden =
          !row.dataset.search!.toLocaleLowerCase().includes(term) ||
          (!!status && row.dataset.flight !== status)),
    );
}
root.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  updateFormValidity();
  if (target.dataset.filter) applyFilters();
  if (target.dataset.colorInput) {
    const input = root.querySelector<HTMLInputElement>(
      `[name="color:${target.dataset.colorInput}"]`,
    );
    if (input) input.value = target.value;
  }
  if (target.name?.startsWith('color:')) {
    const picker = root.querySelector<HTMLInputElement>(
      `[data-color-input="${target.name.slice(6)}"]`,
    );
    if (picker && /^#[\da-f]{6}$/i.test(target.value)) picker.value = target.value;
  }
});
root.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'show-credential') {
    const input = root.querySelector<HTMLInputElement>('[name=credential]');
    if (input) input.type = target.checked ? 'text' : 'password';
  }
  if (target.id === 'reduce-motion') {
    document.documentElement.dataset.motion = target.checked ? 'reduce' : 'auto';
    localStorage.setItem('forest.motion', target.checked ? 'reduce' : 'auto');
    clearInterval(autoTimer);
  }
  if (target.hasAttribute('data-status-filter')) applyFilters();
  if (target.hasAttribute('data-notice-filter')) {
    const q = new URLSearchParams(location.search);
    q.set('status', target.value);
    navigate(path + '?' + q);
  }
  if (target.id === 'exception-kind') {
    const q = new URLSearchParams();
    q.set('kind', target.value);
    navigate(path + '?' + q);
  }
  if (target.id === 'autoplay') {
    clearInterval(autoTimer);
    if (
      target.checked &&
      document.documentElement.dataset.motion !== 'reduce' &&
      !matchMedia('(prefers-reduced-motion:reduce)').matches
    )
      autoTimer = setInterval(() => {
        if (document.hidden) return;
        const tabs = [
          'overview',
          'civilizations',
          'events',
          ...(client.state?.match.phase === 'ended' ? ['results'] : []),
        ];
        const current = new URLSearchParams(location.search).get('tab') ?? 'overview';
        const next = tabs[(tabs.indexOf(current) + 1) % tabs.length]!;
        history.replaceState(null, '', `/display?tab=${next}`);
        render();
        const input = root.querySelector<HTMLInputElement>('#autoplay');
        if (input) input.checked = true;
      }, 12000);
    else target.checked = false;
  }
});
window.addEventListener('popstate', () => {
  path = location.pathname;
  pageData = null;
  pageRequest++;
  render();
  void refresh();
  void loadPage();
  requestAnimationFrame(() => window.scrollTo(0, scrollPositions.get(path + location.search) ?? 0));
});
window.addEventListener('online', () => void refresh());
window.addEventListener('offline', () => {
  connected = false;
  networkMessage = '当前处于离线状态，恢复连接后可继续提交。';
  render();
});
window.addEventListener('focus', () => void refresh());
window.addEventListener('pageshow', () => void refresh());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
  else schedulePoll();
});
channel?.addEventListener('message', (event) => {
  if (event.data === 'config') {
    void client.get<SiteConfig>('/api/public/site-config').then((value) => {
      config = value;
      setColors(config);
      render();
    });
  } else if (event.data === 'logout') expire();
  else {
    expire();
    void refresh();
  }
});
setInterval(tick, 1000);
document.documentElement.dataset.motion = localStorage.getItem('forest.motion') ?? 'auto';
setColors(config);
async function boot() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('preview')) {
    const { createPreviewTransport } = await import('./dev/preview');
    devPreview = new URLSearchParams(location.search).get('preview') ?? 'active';
    client.transport = createPreviewTransport(devPreview);
  }
  render();
  try {
    config = await client.get<SiteConfig>('/api/public/site-config');
    setColors(config);
  } catch {
    /* The entry page remains usable during an unavailable configuration service. */
  }
  booted = true;
  await refresh();
}
void boot();
