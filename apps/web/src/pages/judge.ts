import { COLORS, type PageData, type SessionState, type SiteConfig } from '@darkforest/contracts';
import {
  bracelets,
  button,
  civilizationSummary,
  e,
  empty,
  field,
  heading,
  identity,
  link,
  smallArms,
  swatch,
} from '../ui';
import { eventDetail, eventList } from './player';
import { flightLabels, homeLabels } from '../core/model';

export const judgePages = [
  ['overview', '工作台', '/judge'],
  ['homeworlds', '母星审核', '/judge/homeworlds'],
  ['preflight', '开赛准备', '/judge/preflight'],
  ['notices', '通知待办', '/judge/notices'],
  ['endgame', '终局执裁', '/judge/endgame'],
  ['players', '文明管理', '/judge/players'],
  ['events', '赛事事件', '/judge/events'],
  ['attacks', '攻击复核', '/judge/attacks'],
  ['results', '比赛结果管理', '/judge/results'],
  ['clock', '比赛时间', '/judge/clock'],
  ['equipment', '手环处理', '/judge/equipment'],
  ['effects', '临时效果', '/judge/effects'],
  ['commands', '指令控制台', '/judge/commands'],
  ['system', '系统状态', '/judge/system'],
  ['audit', '操作记录', '/judge/audit'],
  ['settings', '活动设置', '/judge/settings'],
  ['account', '裁判账号', '/judge/account'],
] as const;
export const has = (s: SessionState, key: string) => s.permissions.includes(key);
export const judgeTitle = (path: string) =>
  judgePages.find((p) => p[2] === path)?.[1] ?? '记录详情';
export function stats(data: PageData | null): string {
  return data?.stats?.length
    ? `<div class="stats">${data.stats.map((stat) => `<${stat.href ? 'a' : 'div'} ${stat.href ? `href="${e(stat.href)}" data-link` : ''} class="stat"><span>${e(stat.label)}</span><strong>${e(stat.value)}</strong>${stat.href ? '<span aria-hidden="true">↗</span>' : ''}</${stat.href ? 'a' : 'div'}>`).join('')}</div>`
    : empty('正在读取比赛概况…');
}
export function civilizationList(data: PageData | null, base: string): string {
  return `<details class="filters"><summary>查找与筛选文明</summary><label class="field">文明编号或昵称<input data-filter="civilizations" placeholder="搜索文明" type="search"></label><label class="field">飞船状态<select data-status-filter><option value="">全部状态</option>${Object.entries(
    flightLabels,
  )
    .map(([id, label]) => `<option value="${id}">${label}</option>`)
    .join(
      '',
    )}</select></label></details><div class="civilization-list">${data?.civilizations?.map((c) => `<a class="civilization-row" href="${base}/${encodeURIComponent(c.id)}" data-link data-search="${e(c.id + c.nickname)}" data-flight="${c.flight_status}">${identity(c)}<span>${flightLabels[c.flight_status]}</span><span class="muted">${homeLabels[c.home_status]}</span>${c.bracelet ? smallArms(c.bracelet.arms) : ''}<span aria-hidden="true">↗</span></a>`).join('') || empty(data ? '没有符合条件的文明。' : '正在加载文明…')}</div>`;
}
const reasonField = () =>
  `<label class="field">操作原因<textarea name="reason" required rows="3" placeholder="写明现场情况与处理依据"></textarea></label>`;
const previewForm = (endpoint: string, contents: string, title = '预览操作影响') =>
  `<form data-admin="${endpoint}">${contents}${reasonField()}<button class="primary" type="submit">${title}</button></form>`;
export function judgePage(
  path: string,
  s: SessionState,
  config: SiteConfig,
  data: PageData | null,
): string {
  const section = path.split('/')[2] ?? 'overview';
  if (section === 'more' || section === 'tasks')
    return (
      heading(section === 'more' ? '更多功能' : '待办') +
      `<div class="menu-list">${judgePages
        .filter(
          (p) => has(s, p[0]) && (section === 'more' || ['homeworlds', 'notices'].includes(p[0])),
        )
        .map((p) => link(p[2], p[1]))
        .join('')}</div>`
    );
  if (!has(s, section) && section !== 'account')
    return (
      heading('无查看权限') + empty('当前账号不能查看这项内容。') + link('/judge', '返回工作台')
    );
  const head = heading(judgeTitle(path), path === '/judge' ? undefined : '/judge');
  const fields = data?.fields?.length
    ? `<dl class="facts">${data.fields.map((f) => `<div><dt>${e(f.label)}</dt><dd>${e(f.value)}</dd></div>`).join('')}</dl>`
    : '';
  if (path === '/judge')
    return (
      head +
      `<p>${e(s.role_label)}</p>${stats(data)}<div class="quiet-links">${has(s, 'display') ? '<a href="/display" target="_blank" rel="noopener">打开观战大屏 ↗</a>' : ''}${has(s, 'pause') ? link('/judge/clock', '暂停比赛') : ''}</div><h2>需要处理</h2>${eventList(data, '/judge/events')}`
    );
  if (path.startsWith('/judge/homeworlds/')) {
    const c = data?.civilization;
    if (!c) return head + empty(data ? '登记记录不存在。' : '正在加载登记…');
    return (
      heading('核对母星登记', '/judge/homeworlds') +
      identity(c) +
      `<dl class="facts"><div><dt>提交口令</dt><dd class="code">${e(c.home_code)}</dd></div><div><dt>提交版本</dt><dd>${c.home_version}</dd></div></dl><p>请在QQ和高德地图软件中核对当前版本、现场照片、地点以及母星互不重复的要求。</p>${has(s, 'homeworld-verify') && c.home_status === 'pending' ? `<form data-direct-admin="/api/judge/homeworld/${e(c.id)}/verify"><input type="hidden" name="expected_version" value="${c.home_version}"><input type="hidden" name="expected_code" value="${e(c.home_code)}"><label class="field">审核结果<select name="decision"><option value="verify">审核通过</option><option value="reject">退回修改</option></select></label>${reasonField()}<label class="check"><input type="checkbox" required>已核对当前口令、版本与QQ材料</label><button class="primary" type="submit">确认审核结果</button></form>` : `<p>${homeLabels[c.home_status]}</p>`}`
    );
  }
  if (path === '/judge/homeworlds')
    return (
      head +
      `<div class="review-list">${data?.civilizations?.map((c) => `<a class="review-row" href="/judge/homeworlds/${e(c.id)}" data-link>${identity(c)}<strong class="code">${e(c.home_code)}</strong><span>第${c.home_version}次提交</span><span>核对登记 ↗</span></a>`).join('') || empty(data ? '当前没有待审核的母星。' : '正在加载待审核记录…')}</div>`
    );
  if (path === '/judge/preflight')
    return (
      head +
      fields +
      civilizationList(data, '/judge/players') +
      `${has(s, 'arm-code-release') ? previewForm('/api/judge/arm-code-release', field('发码时间', 't0_utc_ms', '', 'datetime-local', 'required') + '<p>确认所有正式参赛者已完成准备后锁定名单。发码不等于开赛。</p>') : ''}${has(s, 'arm-start') ? previewForm('/api/judge/arm-start', field('开赛时间', 't1_utc_ms', '', 'datetime-local', 'required') + '<p>所有正式参赛者穿戴就绪后，设置未来统一开赛时间。</p>') : ''}`
    );
  if (path === '/judge/players') return head + civilizationList(data, '/judge/players');
  if (path.startsWith('/judge/players/')) {
    const c = data?.civilization;
    return (
      heading('文明详情', '/judge/players') +
      (c
        ? `${civilizationSummary(c)}${c.bracelet ? `<details><summary>查看当前手环</summary>${bracelets(c.bracelet, true)}</details>` : ''}<details><summary>查看历史航次</summary>${c.flights?.map((b) => bracelets(b, true)).join('') || empty()}</details>${eventList(data, '/judge/events')}${has(s, 'correction') ? previewForm('/api/judge/correction', `<h2>修正文明记录</h2><input type="hidden" name="player_id" value="${e(c.id)}"><label class="field">修正项目<select name="field"><option value="nickname">昵称</option><option value="qualification">参赛资格</option><option value="homeworld">母星状态</option><option value="photon_remaining">光粒数量</option><option value="broadcast_remaining">广播次数</option></select></label>${field('拟变更值', 'value', '', 'text', 'required')}`) : ''}${has(s, 'roster-withdraw') && ['setup', 'armed', 'outfitting'].includes(s.match.phase) ? previewForm(`/api/judge/roster/${c.id}/withdraw`, '<h2>登记缺席</h2><p>该文明将退出正式名单，已发行配置永久退役。</p>') : ''}`
        : empty('正在读取文明详情…'))
    );
  }
  if (path === '/judge/notices')
    return (
      head +
      `<nav class="tabs">${[
        ['group', '群公告'],
        ['private', '玩家私聊'],
      ]
        .map(
          ([key, label]) =>
            `<button data-tab="${key}" aria-pressed="${(new URLSearchParams(location.search).get('tab') ?? 'group') === key}">${label}</button>`,
        )
        .join(
          '',
        )}</nav><details><summary>筛选发送状态</summary><select data-notice-filter><option value="">全部状态</option>${['待发送', '已复制', '已发送', '需要处理'].map((v) => `<option>${v}</option>`).join('')}</select></details>${eventList(data, '/judge/notices')}`
    );
  if (path.startsWith('/judge/notices/')) {
    const ev = data?.event;
    return (
      eventDetail(data, '/judge/notices') +
      (ev
        ? `<p>通知状态：${e(ev.status)}</p><p>复制时间：${e(ev.copied_at ?? '尚未复制')}<br>发送时间：${e(ev.sent_at ?? '尚未发送')}</p><button data-copy="${e(ev.body)}" data-notice="${e(ev.id)}" data-version="${ev.version}">复制消息</button>${has(s, 'notice-write') ? `<form data-direct-admin="/api/judge/notices/${e(ev.id)}/sent"><input type="hidden" name="expected_version" value="${ev.version}"><label class="check"><input type="checkbox" required>已在QQ完成实际发送</label><button type="submit">标记已发送</button></form><details><summary>记录发送异常</summary><form data-direct-admin="/api/judge/notices/${e(ev.id)}/error"><input type="hidden" name="expected_version" value="${ev.version}">${reasonField()}<button type="submit">记录发送异常</button></form></details>` : ''}`
        : '')
    );
  }
  if (path === '/judge/endgame')
    return (
      head +
      `<p>在QQ群和现场核对位置共享与入圈情况。网站只记录赛事裁决。</p>${s.match.hunt_review ? '<h2>终局资格核验中</h2><p>比赛有效时间冻结在98:00。请一次提交完整名单，可提交空淘汰名单。</p>' : ''}` +
      (has(s, 'hunt-finalize') && s.match.hunt_review
        ? `<form data-admin="/api/judge/hunt-finalize"><input type="hidden" name="expected_version" value="${data?.version ?? s.version}"><div class="roster">${data?.civilizations?.map((c) => `<div class="roster-row">${identity(c)}<label class="field">${e(c.id)}裁决<select name="eliminate:${e(c.id)}"><option value="">保留资格</option><option value="no_share_at_cutoff">未按时加入位置共享</option><option value="outside_at_cutoff">截止时未进入终局圈</option></select></label></div>`).join('') ?? ''}</div>${reasonField()}<button class="primary" type="submit">预览整批核验结果</button></form>`
        : has(s, 'hunt-eliminate') && s.match.phase === 'hunt'
          ? previewForm(
              '/api/judge/hunt-eliminate',
              `<label class="field">文明<select name="player_id">${data?.civilizations?.map((c) => `<option value="${e(c.id)}">${e(c.id)}（${e(c.nickname)}）</option>`).join('') ?? ''}</select></label><label class="field">裁决原因<select name="elimination_reason"><option value="left_zone">离开终局圈</option><option value="sharing_stopped">停止位置共享</option><option value="location_violation">定位违规</option></select></label>`,
            )
          : civilizationList(data, '/judge/players'))
    );
  if (path === '/judge/clock')
    return (
      head +
      fields +
      `<p>有效比赛时间 <strong data-game-time></strong></p><p>当前真实时间 <time data-real-time></time></p>${s.match.hunt_review ? `<p>请先完成终局资格核验。</p>${link('/judge/endgame', '进入终局执裁', true)}` : has(s, s.match.paused ? 'resume' : 'pause') ? previewForm(`/api/judge/${s.match.paused ? 'resume' : 'pause'}`, `<p>${s.match.paused ? '恢复后有效比赛时间将继续，重新核验各项行动资格。' : '暂停会冻结比赛和重生时间，个人禁止目击攻击与观战等待继续。'}</p>`, s.match.paused ? '预览恢复比赛' : '预览暂停比赛') : ''}`
    );
  if (path === '/judge/equipment')
    return (
      head +
      stats(data) +
      fields +
      (has(s, 'equipment-correction')
        ? previewForm(
            '/api/judge/equipment-correction',
            `${field('文明编号', 'player_id', '', 'text', 'required')}<label class="field">处理方式<select name="operation"><option value="replace">同色同款备用环替换</option>${s.match.paused ? '<option value="retire">注销旧配置</option><option value="issue">领取新配置</option><option value="ready">确认新佩戴</option>' : ''}</select></label><p>同色同款替换不改变配置。异常换码需要先暂停比赛；旧配置永久退役。</p>`,
          )
        : '') +
      eventList(data, '/judge/events')
    );
  if (path === '/judge/system')
    return (
      head +
      fields +
      stats(data) +
      (has(s, 'scheduler-write')
        ? previewForm(
            '/api/judge/scheduler/rearm',
            '<h2>重新安排调度</h2><p>检查并安排下一次唤醒。</p>',
          ) +
          previewForm(
            '/api/judge/events/settle-due',
            '<h2>结算到期事件</h2><p>预览待处理范围，执行后查看实际结算结果。</p>',
          )
        : '') +
      eventList(data, '/judge/events')
    );
  if (path === '/judge/effects')
    return (
      head +
      eventList(data, '/judge/effects') +
      (has(s, 'effect-write')
        ? previewForm(
            '/api/judge/effects',
            `${field('目标范围', 'target', '@a', 'text', 'required')}${field('持续时间（秒）', 'duration_seconds', '', 'number', 'required min="1"')}<label class="field">效果<select name="kind"><option value="attack_silence">暂时禁止目击攻击</option><option value="scheduled_message">定时消息</option></select></label>${field('消息正文（定时消息时填写）', 'message')}<p>使用真实时间，不冻结比赛。撤销效果也不会解除个人处罚或阶段限制。</p>`,
          )
        : '')
    );
  if (path.startsWith('/judge/effects/'))
    return (
      eventDetail(data, '/judge/effects') +
      (has(s, 'effect-write') && data?.event
        ? previewForm(
            `/api/judge/effects/${data.event.id}/revoke`,
            '<p>只撤销此条效果，其他限制继续生效。</p>',
          )
        : '')
    );
  if (path === '/judge/commands')
    return (
      head +
      `<details open><summary>命令帮助</summary><label class="field">查找命令<input type="search" data-filter="commands"></label><div class="command-help">${data?.commands?.map((c) => `<button class="command-example" data-search="${e(c.syntax + c.description)}" data-fill-command="${e(c.syntax)}"><code>${e(c.syntax)}</code><span>${e(c.description)}</span></button>`).join('') || empty('正在读取有权使用的命令…')}</div></details><form data-console><label class="field">命令<textarea name="command" required rows="3" spellcheck="false" autocomplete="off" placeholder="输入命令或从帮助中选择"></textarea></label>${reasonField()}<button class="primary" type="submit">查询或预览</button></form><details><summary>查看执行历史</summary>${eventList(data, '/judge/audit')}</details>`
    );
  if (path === '/judge/settings')
    return (
      head +
      (has(s, 'site-config')
        ? `<form data-admin="/api/judge/site-config"><input type="hidden" name="expected_version" value="${config.version}">${field('活动名称', 'name', config.name, 'text', 'required')}${field('活动说明', 'description', config.description)}${field('比赛QQ群', 'qq_group', config.qq_group)}${field('裁判联系方式', 'judge_contact', config.judge_contact)}${field('终局圈QQ群文件名称', 'endgame_file', config.endgame_file)}${field('裁判室QQ群文件名称', 'room_file', config.room_file)}<h2>手环颜色</h2><p>配置版本 ${config.version}。只改变颜色呈现，覆盖全部页面及历史，不改变颜色身份与已发行组合。</p><div class="color-settings">${COLORS.map((c) => `<div>${swatch(c.id)}<label>${c.name}<input name="color:${c.id}" type="text" value="${e(config.colors[c.id])}" pattern="#[0-9a-fA-F]{6}" required aria-label="${c.name}十六进制值"></label><input type="color" data-color-input="${c.id}" value="${e(config.colors[c.id])}" aria-label="${c.name}取色"></div>`).join('')}</div><button type="button" data-command="reset-colors">重置本表初始值</button>${reasonField()}<button class="primary" type="submit">预览设置变更</button></form><details><summary>查看消息模板预览</summary>${fields || empty('暂无模板预览。')}</details>`
        : fields)
    );
  if (path === '/judge/account')
    return (
      head +
      `<p>${e(s.role_label)}</p><p>菜单和操作由服务端按当前职责授权。</p><div class="menu-list">${judgePages
        .filter((p) => has(s, p[0]))
        .map((p) => link(p[2], p[1]))
        .join('')}</div>${button('退出登录', 'logout')}`
    );
  if (path === '/judge/results')
    return (
      head +
      fields +
      `${s.results_allowed ? link('/results', '查看正式比赛结果', true) : '<p>比赛尚未结束，正式名次尚未生成。</p>'}<div class="quiet-links">${has(s, 'export') ? '<button data-export="report">导出正式战报</button>' : ''}${has(s, 'audit-export') ? '<button data-export="audit">导出内部审计</button>' : ''}</div>${eventList(data, '/judge/events')}`
    );
  if (path.startsWith('/judge/attacks/'))
    return (
      eventDetail(data, '/judge/attacks') +
      fields +
      (has(s, 'attack-correction') && data?.event
        ? previewForm(
            `/api/judge/attack-correction/${data.event.id}`,
            '<p>仅在有充分技术故障证据时纠错，原判罚抽签不重新抽取。已传播的情报无法收回。</p>',
          )
        : '')
    );
  if (path.split('/').length > 3) return eventDetail(data, `/judge/${section}`) + fields;
  return head + fields + eventList(data, `/judge/${section}`);
}
