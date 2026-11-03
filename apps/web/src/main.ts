import { PresentationClock } from './lib/presentation-clock';
import { icon, esc, configuration, button, eventList } from './components/ui';
import {
  home,
  rules,
  player,
  sighting,
  messages,
  selfPage,
  judge,
  display,
  rosterRows,
  civilizationDetail,
  type ViewState,
} from './pages/views';
import '@fontsource-variable/noto-sans-sc';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import {
  scenarios,
  validateArms,
  toggleColor,
  canAttack,
  clock,
  type Arms,
  type ColorId,
  type Scenario,
} from './lib/model';

const app = document.querySelector<HTMLDivElement>('#app')!;
let route = location.hash === '#principles' ? '/' : location.hash.slice(1) || '/';
let scenario: Scenario = 'active';
let paused = false;
let arms: Arms = [[], []];
let selected = 'C07';
let filter = '全部文明';
let search = '';
let eventFilter = '全部事件';
let resultChoice = 'hit';
let requestState: 'idle' | 'pending' | 'unknown' | 'complete' = 'idle';
let requestId = '';
const matchClock = new PresentationClock();
const audit: string[] = [];
let hitRecorded = false;
const reviewed = new Set<string>();
const sent = new Set<string>();
let toastTimer: ReturnType<typeof setTimeout>;
let submittingTimer: ReturnType<typeof setTimeout> | undefined;
let lastFocus: HTMLElement | null = null;
function viewState(): ViewState {
  return {
    scenario,
    paused,
    arms,
    requestState,
    resultChoice,
    requestId,
    selected,
    filter,
    search,
    eventFilter,
    reviewed,
    sent,
    playerScore: hitRecorded ? 4 : 3,
  };
}
function render(): void {
  closeDialog();
  route = location.hash === '#principles' ? '/' : location.hash.slice(1) || '/';
  const pages: Record<string, () => string> = {
    '/': home,
    '/rules': rules,
    '/play': () => player(viewState()),
    '/play/sighting': () => sighting(viewState()),
    '/play/messages': () => messages(viewState()),
    '/play/self': () => selfPage(viewState()),
    '/judge': () => judge(viewState()),
    '/judge/display': () => display(viewState()),
  };
  app.innerHTML =
    (
      pages[route] ||
      (() =>
        `<main class="not-found"><span class="mono">404</span><h1>页面不存在</h1><a href="#/" class="btn primary">返回首页</a></main>`)
    )() +
    '<div id="toast" role="status"></div><dialog id="dialog" aria-labelledby="dialog-title"></dialog>';
  document.querySelector('#dialog')!.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismissDialog();
  });
  updateClock();
  document.title = `${({ '/': '黑暗森林', '/rules': '比赛规则', '/play': '状态', '/play/sighting': '目击', '/play/messages': '消息', '/play/self': '我的', '/judge': '裁判工作台', '/judge/display': '观战大屏' } as Record<string, string>)[route] || '页面不存在'}${route === '/' ? '' : ' | 黑暗森林'}`;
}
function toast(message: string): void {
  const feedback = document.querySelector<HTMLDivElement>('dialog[open] .dialog-feedback');
  if (feedback) {
    feedback.textContent = message;
    return;
  }
  const el = document.querySelector('#toast')!;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
function dialog(title: string, body: string, actions = '', wide = false): void {
  const el = document.querySelector<HTMLDialogElement>('#dialog')!;
  if (!el.open)
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el.className = wide ? 'wide-dialog' : '';
  el.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body">${body}<div class="dialog-feedback" role="status"></div></div>${actions ? `<div class="dialog-actions">${actions}</div>` : ''}`;
  if (!el.open) el.showModal();
  else el.querySelector<HTMLElement>('.dialog-header .icon-button')?.focus();
}
function closeDialog(): void {
  const el = document.querySelector<HTMLDialogElement>('#dialog');
  if (el?.open) {
    el.close();
    lastFocus?.focus();
  }
}
function dismissDialog(): void {
  closeDialog();
  if (route === '/play/sighting' && requestState !== 'idle') {
    render();
    document.querySelector<HTMLElement>('[data-action="confirm-sighting"]')?.focus();
  }
}
function confirmSighting(): void {
  if (validateArms(arms) || !canAttack(scenario, paused)) return;
  dialog(
    '确认这次目击',
    `<p>请核对你亲眼观察到的手环配置。</p>${configuration(arms)}<div class="notice amber">本次识别错误将禁止攻击 5 分钟。</div><label class="checkbox-label"><input id="witness-check" type="checkbox">我已在现场亲眼观察到这组手环</label>`,
    button('返回修改', 'close', 'ghost') +
      button('确认攻击', 'submit-sighting', 'danger', 'disabled'),
  );
}
function sightingResult(): void {
  requestState = 'complete';
  if (resultChoice === 'hit') hitRecorded = true;
  if (resultChoice === 'miss' || resultChoice === 'rejected') scenario = 'restricted';
  arms = [[], []];
  render();
}
function submitSighting(): void {
  if (requestState === 'pending' || requestState === 'unknown' || !canAttack(scenario, paused))
    return;
  if (!document.querySelector<HTMLInputElement>('#witness-check')?.checked) return;
  requestState = 'pending';
  requestId = `S${Date.now().toString().slice(-8)}`;
  closeDialog();
  render();
  submittingTimer = setTimeout(() => {
    if (resultChoice === 'unknown') {
      requestState = 'unknown';
      render();
    } else sightingResult();
  }, 650);
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制，请前往 QQ 发送。');
  } catch {
    dialog(
      '复制这段文字',
      `<p>长按或选中下方文字复制。</p><textarea class="copy-fallback" readonly aria-label="待复制文字">${esc(text)}</textarea>`,
      button('关闭', 'close', 'primary'),
    );
  }
}
document.addEventListener('click', (event) => {
  const element = event.target instanceof Element ? event.target : null;
  const target = element?.closest<HTMLElement>('[data-action]');
  if (!target || target.hasAttribute('disabled')) return;
  switch (target.dataset.action) {
    case 'close':
      dismissDialog();
      break;
    case 'public-events':
      location.hash = '/play/messages';
      break;
    case 'message-filter':
      eventFilter = target.dataset.filter || '全部事件';
      render();
      break;
    case 'scenario-info':
      dialog(
        scenarios.find((s) => s.id === scenario)!.title,
        `<p>${scenarios.find((s) => s.id === scenario)!.message}</p>${scenario === 'restricted' ? configuration([['BK', 'OR'], ['WH']]) : scenario === 'eliminated' ? eventList(3, 'C07') : scenario === 'returning' ? '<ol class="steps"><li>摘下全部手环，步行返回母星。</li><li>拍摄水印照片，通过 QQ 发送给裁判。</li><li>离开母星至少 50 米，领取新手环配置。</li><li>戴好手环，在截止前确认出航。</li></ol>' : ''}`,
        button('我知道了', 'close', 'primary'),
      );
      break;
    case 'color':
      arms = toggleColor(
        arms,
        Number(target.dataset.side) as 0 | 1,
        target.dataset.color as ColorId,
      );
      render();
      document
        .querySelector<HTMLElement>(
          `.palette [data-action="color"][data-side="${target.dataset.side}"][data-color="${target.dataset.color}"]`,
        )
        ?.focus();
      break;
    case 'clear-arm':
      arms[Number(target.dataset.side) as 0 | 1] = [];
      render();
      break;
    case 'clear':
      arms = [[], []];
      render();
      break;
    case 'confirm-sighting':
      if (requestState === 'unknown')
        dialog(
          '正在核实结果',
          `<p>正在查询提交记录 ${requestId}。</p>`,
          button('查询结果', 'resolve-sighting', 'primary'),
        );
      else confirmSighting();
      break;
    case 'submit-sighting':
      submitSighting();
      break;
    case 'resolve-sighting':
      resultChoice = 'hit';
      sightingResult();
      break;
    case 'back-player':
      closeDialog();
      location.hash = '/play';
      if (route === '/play') render();
      break;
    case 'copy-intel':
      void copy('209481');
      break;
    case 'select-civ':
      selected = target.dataset.id!;
      document.querySelector('#roster-rows')!.innerHTML = rosterRows(viewState());
      document.querySelector('#civilization-detail')!.innerHTML = civilizationDetail(viewState());
      break;
    case 'observe-civ':
      selected = target.dataset.id!;
      dialog(
        '文明详情',
        civilizationDetail(viewState()).replace(
          /<button class="btn ghost wide"[\s\S]*?<\/button>/,
          '',
        ),
        button('关闭', 'close', 'primary'),
      );
      break;
    case 'reset-filter':
      search = '';
      filter = '全部文明';
      render();
      break;
    case 'pause':
      if (scenario === 'review') {
        dialog(
          '终局资格核验中',
          '<p>完成终局资格核验后，比赛将继续最后 22 分钟的狩猎。</p>',
          button('关闭', 'close', 'primary'),
        );
        break;
      }
      dialog(
        paused ? '恢复比赛' : '暂停比赛',
        `<p>${paused ? '恢复有效比赛计时，并重新开放当前阶段允许的行动。' : '有效比赛计时将暂停，玩家停止提交攻击。'}</p><label class="form-label" for="pause-reason">${paused ? '恢复' : '暂停'}原因</label><textarea id="pause-reason" placeholder="填写原因" rows="3"></textarea>`,
        button('取消', 'close', 'ghost') + button('预览操作', 'preview-pause', 'primary'),
      );
      break;
    case 'preview-pause': {
      const reason = document.querySelector<HTMLTextAreaElement>('#pause-reason')!.value.trim();
      if (!reason) {
        document
          .querySelector<HTMLTextAreaElement>('#pause-reason')!
          .setAttribute('aria-invalid', 'true');
        toast('请填写操作原因。');
        break;
      }
      dialog(
        '核对赛事操作',
        `<div class="detail-field"><span>操作</span><strong>${paused ? '恢复比赛' : '暂停比赛'}</strong></div><div class="detail-field"><span>作用范围</span><strong>全场玩家</strong></div><p>${esc(reason)}</p>`,
        button('取消', 'close', 'ghost') +
          button('确认执行', 'execute-pause', 'danger', `data-reason="${esc(reason)}"`),
      );
      break;
    }
    case 'execute-pause':
      paused = !paused;
      matchClock.setPaused(paused);
      audit.unshift(`${paused ? '暂停比赛' : '恢复比赛'}：${target.dataset.reason}`);
      render();
      toast(paused ? '比赛已暂停。' : '比赛已恢复。');
      break;
    case 'review':
      dialog(
        '审核母星登记',
        `<div class="detail-field"><span>文明</span><strong>C16 归航</strong></div><div class="detail-field"><span>最新登记版本</span><strong class="mono">02</strong></div><div class="detail-field"><span>六位口令</span><strong class="mono">063918</strong></div><p>请在 QQ 核对同版本消息与水印照片，在高德地图核对地点。</p><label class="form-label" for="review-reason">处理说明</label><textarea id="review-reason" rows="2" placeholder="驳回时填写原因"></textarea>`,
        reviewed.has('C16')
          ? button('关闭', 'close', 'primary')
          : button('驳回', 'reject-review', 'ghost') +
              button('审核通过', 'approve-review', 'primary'),
      );
      break;
    case 'reject-review':
      if (!document.querySelector<HTMLTextAreaElement>('#review-reason')!.value.trim()) {
        toast('请填写驳回原因。');
        break;
      }
      reviewed.add('C16');
      render();
      toast('登记已驳回。');
      break;
    case 'approve-review':
      reviewed.add('C16');
      render();
      toast('C16 的母星登记已通过。');
      break;
    case 'notice':
      dialog(
        '发送返航通知',
        `<div class="detail-field"><span>收件文明</span><strong>C03 蓝色空间</strong></div><div class="message-text">你的飞船已于 30:46 被击毁。请摘下全部手环，步行返回母星，拍摄水印照片后通过 QQ 发送。请在 45:46 前完成重新出航。</div><p class="small muted">复制后，请前往 QQ 私聊发送。</p>`,
        button(`${icon('copy')}复制通知`, 'copy-notice', 'ghost') +
          button(
            sent.has('C03') ? '已标记发送' : '标记已发送',
            'sent-notice',
            'primary',
            sent.has('C03') ? 'disabled' : '',
          ),
      );
      break;
    case 'copy-notice':
      void copy(
        'C03 蓝色空间：你的飞船已于 30:46 被击毁。请摘下全部手环，步行返回母星，拍摄水印照片后通过 QQ 发送。请在 45:46 前完成重新出航。',
      );
      break;
    case 'sent-notice':
      sent.add('C03');
      render();
      toast('通知已标记发送。');
      break;
    case 'health':
      dialog(
        '事件执行记录',
        `<div class="detail-field"><span>最近执行</span><strong>32:04 正式广播</strong></div><div class="detail-field"><span>待处理异常</span><strong>0</strong></div><h3>赛事操作记录</h3>${audit.length ? audit.map((a) => `<p>${esc(a)}</p>`).join('') : '<p class="muted">暂无赛事控制操作。</p>'}`,
        button('关闭', 'close', 'primary'),
      );
      break;
    case 'civ-records':
      dialog(
        '文明记录',
        `<p>${selected} 的最近航行记录</p>${eventList(3, selected)}`,
        button('关闭', 'close', 'primary'),
      );
      break;
    case 'fullscreen':
      if (document.fullscreenElement)
        void document.exitFullscreen().catch(() => toast('请使用浏览器退出全屏。'));
      else
        void document.documentElement
          .requestFullscreen()
          .catch(() => toast('可使用浏览器菜单进入全屏。'));
      break;
  }
});
document.addEventListener('input', (event) => {
  const el = event.target as HTMLInputElement;
  if (el.id === 'roster-search') {
    search = el.value;
    document.querySelector('#roster-rows')!.innerHTML = rosterRows(viewState());
  }
});
document.addEventListener('change', (event) => {
  const el = event.target as HTMLInputElement;
  if (el.id === 'witness-check')
    document.querySelector<HTMLButtonElement>('[data-action="submit-sighting"]')!.disabled =
      !el.checked;
  if (el.id === 'roster-filter') {
    filter = el.value;
    document.querySelector('#roster-rows')!.innerHTML = rosterRows(viewState());
  }
  if (el.id === 'event-filter') {
    eventFilter = el.value;
    render();
  }
});
document.addEventListener('click', (event) => {
  const el = document.querySelector<HTMLDialogElement>('#dialog');
  if (event.target === el) {
    const r = el!.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      dismissDialog();
  }
});
window.addEventListener('hashchange', () => {
  if (location.hash === '#principles') return;
  render();
  window.scrollTo(0, 0);
  document.querySelector<HTMLElement>('main')?.setAttribute('tabindex', '-1');
  document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true });
});
window.addEventListener('pagehide', () => clearTimeout(submittingTimer));
function updateClock(): void {
  document
    .querySelectorAll<HTMLElement>('[data-clock]')
    .forEach((el) => (el.textContent = clock(matchClock.seconds)));
}
setInterval(updateClock, 1000);
render();
