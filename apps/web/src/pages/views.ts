import {
  braceletColors,
  scenarios,
  validateArms,
  canAttack,
  phaseInfo,
  clock,
  civilizations,
  events,
  type Arms,
  type Scenario,
} from '../lib/model';
import {
  icon,
  esc,
  brand,
  swatch,
  configuration,
  button,
  sectionTitle,
  tag,
  shell,
  pageHeading,
  eventList,
} from '../components/ui';
export type ViewState = {
  scenario: Scenario;
  paused: boolean;
  arms: Arms;
  requestState: string;
  resultChoice: string;
  requestId: string;
  selected: string;
  filter: string;
  search: string;
  eventFilter: string;
  reviewed: Set<string>;
  sent: Set<string>;
  playerScore: number;
};
export function home(): string {
  return `<div class="landing"><header class="landing-header">${brand()}<nav aria-label="首页导航"><a class="text-button" href="#/rules">比赛规则</a><a class="header-link" href="#/judge">裁判工作台 ${icon('arrow')}</a></nav></header><main id="main"><section class="hero"><div class="hero-copy"><h1>进入比赛</h1><div class="hero-actions"><a href="#/play" class="btn primary">玩家界面 ${icon('arrow')}</a><a href="#/judge" class="btn ghost">裁判工作台 ${icon('arrow')}</a></div></div></section></main></div>`;
}

export function rules(): string {
  return shell(
    `${pageHeading('', '比赛规则', '')}<article class="rules-page"><section><h2>观察与识别</h2><p>亲眼观察对手两侧的手环颜色，再选择对应色块提交目击。两侧可以整体交换，同一侧的颜色顺序不影响识别。</p><p>每次出航佩戴三条或四条手环，每侧一至三条。每种颜色只佩戴一条。</p></section><section><h2>识别错误</h2><p>第一次识别错误后，禁止攻击五分钟。第二次识别错误可能导致永久淘汰，也可能禁止攻击十五分钟。第三次识别错误后永久淘汰。</p><p>累计识别错误次数会保留到后续航次。</p></section><section><h2>母星与重生</h2><p>第一阶段被击毁后，母星仍存续的玩家可以在十五分钟内返航重生，且须在六十五分钟以前完成出航。</p><p>重生时摘下全部手环并步行返回母星，拍摄水印照片后通过 QQ 发送给裁判。随后离开母星至少五十米，领取新配置并确认出航。</p></section><section><h2>比赛阶段</h2><p>比赛进行六十五分钟后，所有母星毁灭。九十分钟开始前往终局区域，并停止目击攻击。九十八分钟暂停有效比赛时间，由裁判核验终局资格。</p><p>核验完成后，剩余玩家进入最后狩猎。比赛总时长为一百二十分钟。</p></section><section><h2>安全与联络</h2><p>全程步行并遵守活动区域规定。使用高德地图自行导航，终局区域和裁判室说明见比赛 QQ 群文件。遇到异常请联系裁判。</p></section></article>`,
    false,
    false,
    '/rules',
  );
}
export function player(state: ViewState): string {
  const { scenario, paused, playerScore } = state;
  const s = scenarios.find((item) => item.id === scenario)!;
  const available = canAttack(scenario, paused);
  const playerStatus = paused ? '比赛暂停' : scenario === 'active' ? '出航中' : s.name;
  return shell(
    `${pageHeading('', '状态', '')}<div class="player-grid"><div class="player-main"><section class="status-panel ${available ? '' : 'warning-panel'}"><div class="player-status-grid"><div><span>比赛阶段</span><strong>${phaseInfo(scenario).name}</strong></div><div><span>有效比赛时间</span><strong class="mono" data-clock>${clock(s.time)}</strong></div><div><span>当前状态</span><strong class="status-value">${playerStatus}</strong></div></div><div class="status-content"><div><h2>${paused ? '比赛已暂停' : s.title}</h2><p>${paused ? '等待裁判恢复比赛。' : s.message}</p></div></div>${available ? `<a href="#/play/sighting" class="btn primary wide">${icon('eye')}发起目击 ${icon('arrow')}</a>` : button(s.action, 'scenario-info', 'wide')}${scenario === 'restricted' ? '<p class="persistent-note">累计识别错误 1 次。限制结束后，该次数仍会保留。</p>' : ''}</section><section class="panel">${sectionTitle('当前手环配置', '', '<span class="small muted">第二次航行</span>')}<p class="panel-description">按两侧颜色佩戴，其余手环收起。</p>${configuration([['BK', 'OR'], ['WH']])}<div class="panel-foot"><span>${tag(scenario === 'eliminated' || scenario === 'returning' ? '配置已失效' : '现役配置', scenario === 'eliminated' || scenario === 'returning' ? 'amber' : '')}</span><a class="text-button" href="#/play/self">查看我的信息 ${icon('chevron')}</a></div></section></div><aside class="player-aside"><section class="personal-stats"><div><span>击毁的不同文明</span><strong class="mono">${playerScore.toString().padStart(2, '0')}</strong></div><div><span>累计识别错误</span><strong class="mono">${scenario === 'restricted' ? '01' : '00'}</strong></div><div><span>母星状态</span><strong class="word-stat">${['last', 'transfer', 'review', 'eliminated'].includes(scenario) ? '已毁灭' : '存续'}</strong></div></section><section class="time-panel"><div class="phase-caption">比赛进度<span>${paused || scenario === 'review' ? '计时已暂停' : '共 120 分钟'}</span></div><progress class="phase-track" value="${s.time}" max="7200" aria-label="比赛进度"></progress><div class="phase-milestones mono"><span>00:00</span><span>65:00</span><span>120:00</span></div><p class="next-phase">${s.time < 3900 ? '65:00 所有母星毁灭' : s.time < 5400 ? '90:00 开始终局转场' : s.time < 5880 ? '98:00 开始资格核验' : '120:00 常规比赛结束'}</p></section><a class="text-button" href="#/play/self">查看完整个人信息 ${icon('chevron')}</a></aside></div>`,
    false,
    paused || scenario === 'review',
  );
}
export function messages(state: ViewState): string {
  const visibleEvents = events.filter((event) =>
    state.eventFilter === '全部事件'
      ? true
      : state.eventFilter === '广播'
        ? event.kind === 'broadcast'
        : event.kind !== 'broadcast',
  );
  return shell(
    `${pageHeading('', '消息', '')}<section class="message-page"><div class="message-filters" role="group" aria-label="筛选消息">${['全部事件', '广播', '其他事件'].map((item) => `<button class="filter-button ${state.eventFilter === item ? 'selected' : ''}" data-action="message-filter" data-filter="${item}" aria-pressed="${state.eventFilter === item}">${item}</button>`).join('')}</div><ol class="event-list">${visibleEvents.map((event) => `<li><span class="event-marker ${event.kind}">${icon(event.kind === 'broadcast' ? 'wave' : event.kind === 'hit' ? 'target' : 'globe')}</span><div><time class="mono">${event.time}</time><h3>${event.title}</h3><p>${event.text}</p></div></li>`).join('')}</ol></section>`,
    false,
    state.paused,
    '/play/messages',
  );
}
function sightingResult(state: ViewState): string {
  const outcomes: Record<string, [string, string]> = {
    hit: ['成功击毁', '你击毁了 C12 引力的飞船，新增 1 个不同文明的击毁记录。'],
    miss: ['目击未成功', '累计识别错误 1 次，禁止攻击 5 分钟。'],
    neutral: ['目击未产生击毁', '累计识别错误保持不变。'],
    rejected: ['禁止攻击', '本次提交未被受理，累计识别错误保持不变。'],
  };
  const [title, text] = outcomes[state.resultChoice] || outcomes.hit!;
  return `<section class="sighting-result" role="status"><h2>${title}</h2><p>${text}</p>${state.resultChoice === 'hit' ? `<div class="intel-result"><span>C12 母星口令</span><strong class="mono">209481</strong><button class="icon-button" data-action="copy-intel" aria-label="复制母星口令">${icon('copy')}</button></div>` : ''}<p class="small muted">记录编号 ${esc(state.requestId || '暂无')}</p><a class="btn ghost" href="#/play">返回状态</a></section>`;
}
export function selfPage(state: ViewState): string {
  const destroyed = ['last', 'transfer', 'review', 'eliminated'].includes(state.scenario);
  return shell(
    `${pageHeading('', '我的', '')}<div class="self-page"><section class="self-identity"><span class="mono">C07</span><h2>远星</h2><span>${destroyed ? '母星已毁灭' : '母星存续'}</span></section><section class="panel">${sectionTitle('当前手环配置', '')}${configuration([['BK', 'OR'], ['WH']])}<div class="detail-field"><span>当前航次</span><strong>第二次航行</strong></div><div class="detail-field"><span>配置状态</span><strong>${destroyed ? '已失效' : '现役'}</strong></div></section><section class="personal-stats"><div><span>击毁的不同文明</span><strong class="mono">${state.playerScore.toString().padStart(2, '0')}</strong></div><div><span>累计识别错误</span><strong class="mono">${state.scenario === 'restricted' ? '01' : '00'}</strong></div></section><section class="self-links"><a class="self-link" href="#/play/messages"><span>比赛消息</span>${icon('chevron')}</a><a class="self-link" href="#/rules"><span>比赛规则</span>${icon('chevron')}</a></section></div>`,
    false,
    state.paused,
    '/play/self',
  );
}
export function sighting(state: ViewState): string {
  const { scenario, paused, arms, requestState } = state;
  const error = validateArms(arms);
  const locked = requestState === 'pending' || requestState === 'unknown';
  const available = canAttack(scenario, paused);
  return shell(
    `${pageHeading('', '目击', '')}${
      requestState === 'complete'
        ? sightingResult(state)
        : `<div class="sighting-layout"><section class="panel sighting-panel"><div class="panel-top"><h2>选择手环颜色</h2></div><div class="inline-note"><p>两侧可以整体交换，同一侧的颜色顺序不影响结果。</p></div><div class="arm-selectors">${(
            [0, 1] as const
          )
            .map(
              (side) =>
                `<fieldset class="arm-selector"><legend><span>${side === 0 ? '一侧手臂' : '另一侧手臂'}</span><span class="mono count">${arms[side].length.toString().padStart(2, '0')}</span></legend><div class="selected-preview">${arms[side].length ? arms[side].map((color) => `<button class="selected-color" data-action="color" data-side="${side}" data-color="${color}" aria-label="移除${braceletColors.find((c) => c.id === color)!.name}">${swatch(color, true)}<span aria-hidden="true">×</span></button>`).join('') : '<div class="empty-selection"><span aria-hidden="true">+</span>选择这一侧的颜色</div>'}</div><div class="palette">${braceletColors
                  .map((color) => {
                    const chosen = arms[side].includes(color.id);
                    const other = arms[side === 0 ? 1 : 0].includes(color.id);
                    return `<button class="color-option ${chosen ? 'chosen' : ''}" data-action="color" data-side="${side}" data-color="${color.id}" aria-label="${color.name}${other ? '，已在另一侧选择' : ''}" aria-pressed="${chosen}" ${other || locked ? 'disabled' : ''}>${swatch(color.id, true)}${chosen ? icon('check') : ''}</button>`;
                  })
                  .join(
                    '',
                  )}</div><button class="text-button small" data-action="clear-arm" data-side="${side}" ${arms[side].length && !locked ? '' : 'disabled'}>清空这一侧</button></fieldset>`,
            )
            .join(
              '',
            )}</div><div class="selection-summary" aria-live="polite"><span>${error ? icon('target') : icon('check')}</span><p>${error || `已选择 ${arms.flat().length} 条手环，可以继续核对。`}</p></div>${!available ? '<div class="notice amber">当前状态禁止攻击。返回状态页查看恢复条件。</div>' : ''}${requestState === 'pending' ? '<div class="notice" role="status">正在提交目击</div>' : requestState === 'unknown' ? `<div class="notice amber" role="status">正在核实结果${state.requestId ? `，记录编号 ${esc(state.requestId)}` : ''}。<button class="text-button small" data-action="resolve-sighting">查询目击结果</button></div>` : ''}<div class="sighting-actions">${button('重新选择', 'clear', 'ghost', locked ? 'disabled' : '')}${button(`核对并继续 ${icon('arrow')}`, 'confirm-sighting', 'primary', error || !available || locked ? 'disabled' : '')}</div></section><aside class="sighting-aside"><section class="panel risk-panel"><h2>识别错误的处理方式</h2><div class="risk-row"><span>当前累计识别错误</span><strong class="mono">${scenario === 'restricted' ? '01' : '00'}</strong></div><ol class="risk-list"><li><span class="mono">01</span><p>第一次识别错误<br><strong>禁止攻击 5 分钟</strong></p></li><li><span class="mono">02</span><p>第二次识别错误<br><strong>一半概率淘汰，另一半禁止攻击 15 分钟</strong></p></li><li><span class="mono">03</span><p>第三次识别错误<br><strong>永久淘汰</strong></p></li></ol><div class="risk-footer">累计识别错误不会随重新出航清零。</div></section><a href="#/play" class="back-link">返回状态</a></aside></div>`
    }`,
    false,
    paused || scenario === 'review',
    '/play/sighting',
  );
}
export function rosterRows(state: ViewState): string {
  const { selected, filter, search } = state;
  const rows = civilizations.filter(
    (c) =>
      (filter === '全部文明' || c.status === filter) &&
      `${c.id}${c.name}`.toLowerCase().includes(search.toLowerCase()),
  );
  return rows.length
    ? rows
        .map(
          (c) =>
            `<button class="roster-row ${selected === c.id ? 'selected' : ''}" data-action="select-civ" data-id="${c.id}"><span class="civilization-name"><span class="mono">${c.id}</span><strong>${c.name}</strong></span><span>${tag(c.status, c.status === '航行中' ? '' : c.status === '正在返航' ? 'amber' : 'dim')}</span><span class="mono flight-cell">${c.flight.toString().padStart(2, '0')}</span><span class="mono score-cell">${c.score.toString().padStart(2, '0')}</span>${icon('chevron')}</button>`,
        )
        .join('')
    : '<div class="empty-state">没有找到匹配的文明。<button class="text-button" data-action="reset-filter">清除筛选</button></div>';
}
export function civilizationDetail(state: ViewState): string {
  const { selected, scenario } = state;
  const c = civilizations.find((item) => item.id === selected)!;
  return `<div class="detail-heading"><span class="mono">${c.id}</span>${tag(c.status, c.status === '航行中' ? '' : 'amber')}</div><h3 class="detail-name">${c.name}</h3><div class="detail-metrics"><div><span>当前航行次数</span><strong class="mono">0${c.flight}</strong></div><div><span>击毁的不同文明</span><strong class="mono">0${c.score}</strong></div></div><h4>当前手环配置</h4>${configuration(c.arms)}<div class="detail-field"><span>母星口令</span><strong class="mono">${c.home}</strong></div><div class="detail-field"><span>母星状态</span><span>${['last', 'transfer', 'review', 'eliminated'].includes(scenario) ? '已毁灭' : '存续'}</span></div><div class="detail-field"><span>最近活动</span><span>${events.find((e) => e.text.includes(c.id))?.time || '00:00'}</span></div><button class="btn ghost wide" data-action="civ-records">查看文明记录 ${icon('arrow')}</button>`;
}
export function judge(state: ViewState): string {
  const { scenario, paused, filter, search, reviewed, sent } = state;
  return shell(
    `${pageHeading('', '裁判工作台', '', `<a href="#/judge/display" class="btn ghost">打开观战大屏</a>`)}<section class="judge-clockbar"><div><span class="eyebrow">有效比赛时间</span><strong class="mono" data-clock>${clock(scenarios.find((s) => s.id === scenario)!.time)}</strong></div><div class="judge-phase">${tag(scenario === 'review' ? '终局资格核验' : paused ? '全场暂停' : '比赛进行中', paused || scenario === 'review' ? 'amber' : '')}<span>${phaseInfo(scenario).name}</span></div>${button(`${scenario === 'review' ? '查看核验状态' : paused ? '恢复比赛' : '暂停比赛'}`, 'pause', 'ghost')}</section><div class="judge-stats"><div><span>航行中的文明</span><strong class="mono">06<small>共 8 个</small></strong></div><div><span>正在返航</span><strong class="mono">01</strong></div><div><span>已经淘汰</span><strong class="mono">01</strong></div><div><span>剩余手环配置</span><strong class="mono">302</strong></div></div><div class="attention-strip"><button data-action="review">${reviewed.size ? '母星登记已处理' : '1 条母星登记待审核'}${icon('chevron')}</button><button data-action="notice">${sent.size ? 'QQ 通知已发送' : '1 条 QQ 通知待发送'}${icon('chevron')}</button></div><div class="judge-grid"><section class="panel roster-panel">${sectionTitle('文明名册', '', '<span class="small muted">8 条记录</span>')}<div class="roster-tools"><label class="search-field"><input id="roster-search" type="search" placeholder="搜索编号或文明名称" value="${esc(search)}" aria-label="搜索文明"></label><select id="roster-filter" aria-label="筛选文明状态">${['全部文明', '航行中', '正在返航', '已淘汰'].map((s) => `<option ${s === filter ? 'selected' : ''}>${s}</option>`).join('')}</select></div><div class="roster-table"><div class="roster-table-head"><span>文明</span><span>飞船状态</span><span>航行次数</span><span>击毁数</span><span></span></div><div id="roster-rows">${rosterRows(state)}</div></div></section><aside class="panel civilization-detail" id="civilization-detail">${civilizationDetail(state)}</aside><section class="panel tasks-panel">${sectionTitle('待处理事项', '', `<span class="task-count">${2 - reviewed.size - sent.size}</span>`)}<button class="task-row" data-action="review"><span class="task-icon">${icon('globe')}</span><div><strong>母星登记审核</strong><p>${reviewed.size ? 'C16 的登记已处理' : 'C16 提交了新的母星口令'}</p></div><span class="tag ${reviewed.size ? '' : 'amber'}">${reviewed.size ? '已处理' : '待审核'}</span>${icon('chevron')}</button><button class="task-row" data-action="notice"><span class="task-icon">${icon('bell')}</span><div><strong>QQ 私聊通知</strong><p>${sent.size ? 'C03 的返航通知已标记发送' : 'C03 被击毁，请发送返航通知'}</p></div><span class="tag ${sent.size ? '' : 'amber'}">${sent.size ? '已发送' : '待发送'}</span>${icon('chevron')}</button><button class="task-row" data-action="health"><span class="task-icon">${icon('wave')}</span><div><strong>比赛事件</strong><p>查看近期比赛变化</p></div><span class="tag dim">查看</span>${icon('chevron')}</button></section><section class="panel judge-events">${sectionTitle('近期赛事事件', '')}${eventList(2)}</section></div>`,
    true,
    paused || scenario === 'review',
  );
}
export function display(state: ViewState): string {
  const { scenario, paused, eventFilter } = state;
  const visibleEvents =
    eventFilter === '全部事件'
      ? events
      : events.filter((e) =>
          eventFilter === '广播' ? e.kind === 'broadcast' : e.kind !== 'broadcast',
        );
  return `<div class="display-page"><header class="display-header">${brand()}<div class="display-title"><span class="readonly-label">只读大屏</span></div><div class="display-controls"><a href="#/judge" class="text-button">返回裁判工作台</a><button class="icon-button" data-action="fullscreen" aria-label="切换全屏">${icon('expand')}</button></div></header><main id="main"><section class="display-overview"><div><h1>${phaseInfo(scenario).name}</h1>${tag(paused || scenario === 'review' ? '比赛暂停' : '比赛进行中', paused ? 'amber' : '')}</div><div class="display-time"><span class="eyebrow">有效比赛时间</span><strong class="mono" data-clock>${clock(scenarios.find((s) => s.id === scenario)!.time)}</strong><span>${phaseInfo(scenario).next}</span></div><div class="display-counts"><div><strong class="mono">06</strong><span>航行中</span></div><div><strong class="mono">01</strong><span>正在返航</span></div><div><strong class="mono">01</strong><span>已淘汰</span></div></div></section><div class="display-grid"><section><div class="section-heading"><h2>文明名册</h2></div><div class="civilization-cards">${[
    ...civilizations,
  ]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (c) =>
        `<button class="civilization-card ${c.status === '已淘汰' ? 'fallen' : ''}" data-action="observe-civ" data-id="${c.id}"><div><span class="mono">${c.id}</span>${tag(c.status, c.status === '航行中' ? '' : c.status === '正在返航' ? 'amber' : 'dim')}</div><h2>${c.name}</h2>${configuration(c.arms, true)}<div class="civilization-card-foot"><span>第 ${c.flight} 次航行</span><span>击毁 ${c.score} 个文明</span></div></button>`,
    )
    .join(
      '',
    )}</div></section><aside class="display-events"><div class="section-heading"><h2>比赛事件</h2></div><select id="event-filter" aria-label="筛选赛事事件">${['全部事件', '广播', '其他事件'].map((s) => `<option ${s === eventFilter ? 'selected' : ''}>${s}</option>`).join('')}</select><ol class="display-event-list">${visibleEvents.map((e) => `<li><time class="mono">${e.time}</time><h3>${e.title}</h3><p>${e.text}</p></li>`).join('')}</ol></aside></div></main></div>`;
}
