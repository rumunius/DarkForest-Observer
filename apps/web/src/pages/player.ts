import {
  COLORS,
  type Action,
  type PageData,
  type SessionState,
  type SiteConfig,
} from '@darkforest/contracts';
import { canAct, flightLabels, homeLabels, phaseLabels } from '../core/model';
import {
  bracelets,
  button,
  coordinate,
  e,
  empty,
  field,
  heading,
  identity,
  link,
  swatch,
} from '../ui';

export function currentTask(s: SessionState): {
  title: string;
  body: string;
  href: string;
  label: string;
} {
  const me = s.me!;
  if (s.match.phase === 'ended')
    return {
      title: '比赛已结束',
      body: '查看正式结果，以及本场文明的完整经历。',
      href: '/results',
      label: '查看比赛结果',
    };
  if (me.flight_status === 'eliminated')
    return {
      title: '你已永久淘汰',
      body: '请摘下全部比赛手环，步行返回裁判室。裁判室位置请查看QQ群文件。',
      href: s.observer_allowed ? '/observer' : '/player/eliminated',
      label: s.observer_allowed ? '进入宇宙观测' : '查看淘汰后安排',
    };
  if (['returning', 'preparing', 'issued'].includes(me.flight_status))
    return {
      title: '飞船已被击毁',
      body: '请摘下全部比赛手环，返回母星完成重生。所有步骤共用同一期限。',
      href: '/player/respawn',
      label: '继续重生',
    };
  if (!me.nickname)
    return {
      title: '为你的文明命名',
      body: '确认后昵称将固定。',
      href: '/player/identity',
      label: '设置昵称',
    };
  if (['unregistered', 'pending', 'rejected'].includes(me.home_status))
    return {
      title: homeLabels[me.home_status],
      body: me.home_reason ?? '母星登记和照片核对完成后，才能开始首航准备。',
      href: '/player/homeworld',
      label: me.home_status === 'unregistered' ? '登记母星' : '查看母星登记',
    };
  if (['setup', 'armed', 'outfitting', 'start_countdown'].includes(s.match.phase))
    return {
      title: flightLabels[me.flight_status],
      body: '按当前步骤完成准备，等待统一开赛。',
      href: '/player/preflight',
      label: '查看首航准备',
    };
  if (s.match.hunt_review || s.match.phase === 'transfer')
    return {
      title: s.match.hunt_review ? '终局资格确认中' : '前往终局圈',
      body: '请保持QQ群实时位置共享，等待裁判确认。',
      href: '/player/endgame',
      label: '查看终局说明',
    };
  if (s.match.paused)
    return {
      title: '比赛已暂停',
      body: s.match.pause_reason ?? '等待裁判恢复比赛。',
      href: '/player/me',
      label: '查看本人信息',
    };
  return {
    title: canAct(s, 'sighting') ? '你正在出航' : '暂时不能目击攻击',
    body: me.home_status === 'destroyed' ? '母星已毁灭。你现在是最后一命。' : s.status_message,
    href: '/player/actions',
    label: canAct(s, 'sighting') ? '目击攻击' : '查看其他行动',
  };
}
export function timer(label: string, base: 'game' | 'utc', end?: number): string {
  return end === undefined
    ? ''
    : `<div class="timer"><span>${e(label)}</span><strong data-countdown="${end}" data-base="${base}">正在更新</strong></div>`;
}
function actionButton(s: SessionState, action: Action, label: string, explanation: string) {
  return canAct(s, action)
    ? `<form data-action="${action}"><p>${e(explanation)}</p><label class="check"><input type="checkbox" name="confirmed" required>我已完成上述现场步骤</label><button class="primary" type="submit">${e(label)}</button></form>`
    : '';
}
export function eventList(data: PageData | null, base: string): string {
  if (!data) return empty('正在加载记录…');
  if (!data.events?.length) return empty('还没有新的赛事事件。');
  return `<div class="event-list">${data.events.map((ev) => `<a class="event-row" href="${base}/${encodeURIComponent(ev.id)}" data-link><time>${e(ev.occurred_at)}</time><div><h2>${e(ev.title)}</h2><p>${e(ev.body)}</p>${ev.recipient ? `<span class="muted">${e(ev.recipient)}</span>` : ''}${ev.status ? `<span class="status-label">${e(ev.status)}</span>` : ''}</div><span aria-hidden="true">↗</span></a>`).join('')}</div>${data.next_cursor ? `<button data-command="more" data-cursor="${e(data.next_cursor)}">加载更多</button>` : ''}`;
}
export function eventDetail(data: PageData | null, back: string): string {
  if (!data) return heading('消息详情', back) + empty('正在加载记录…');
  if (!data.event) return heading('消息详情', back) + empty('这条记录不存在。');
  const ev = data.event;
  return (
    heading(ev.title, back) +
    `<p class="muted">${e(ev.occurred_at)}${ev.source ? ` 来源：${e(ev.source)}` : ''}</p><article class="prose">${e(ev.body)}</article>${ev.code ? `<p class="code">${e(ev.code)}</p><button data-copy="${e(ev.code)}">复制口令</button>` : ''}`
  );
}
function savedTemplate(data: PageData | null) {
  return data?.template
    ? `<div class="copy-block"><p class="copy-text">${e(data.template)}</p><button data-copy="${e(data.template)}">复制消息</button><p class="muted">复制后请到裁判QQ私聊粘贴，并附上现场照片。</p></div>`
    : empty('正在获取已保存的消息…');
}
export function playerPage(
  path: string,
  s: SessionState,
  config: SiteConfig,
  data: PageData | null,
): string {
  const me = s.me!;
  const task = currentTask(s);
  const blocked = () =>
    `<p>${e(s.status_message || task.body)}</p>${link(task.href, task.label, true)}`;
  if (path === '/player')
    return `${heading('当前')}${identity(me)}<div class="current-task"><p class="eyebrow">${phaseLabels[s.match.phase]}</p><h2 class="hero-title">${e(task.title)}</h2><p>${e(task.body)}</p>${s.match.phase !== 'ended' ? (me.respawn_deadline_game_ms && ['returning', 'preparing', 'issued'].includes(me.flight_status) ? timer('距离重生截止', 'game', me.respawn_deadline_game_ms) : me.flight_status === 'eliminated' && !s.observer_allowed ? timer('距离进入宇宙观测', 'utc', me.observer_unlock_at_utc_ms) : timer('本阶段剩余时间', 'game', s.match.clock.phase_end_game_ms)) : ''}${link(task.href, task.label, true)}</div><div class="quiet-links">${link('/player/messages', '查看消息')}${link('/player/me', '本人信息')}</div>`;
  if (path === '/player/identity')
    return (
      heading('文明昵称', '/player') +
      identity(me) +
      (canAct(s, 'nickname')
        ? `<form data-action="nickname">${field('昵称', 'nickname', '', 'text', 'required minlength="2" maxlength="16" autocomplete="off"')}<p>请输入2—8个汉字或等长字符。确认后昵称将固定。</p><p data-nickname-preview></p><button class="primary" type="submit">确认昵称</button></form>`
        : `<p>昵称已固定。如需更正，请联系裁判。</p>`)
    );
  if (path === '/player/homeworld')
    return (
      heading('母星登记', '/player') +
      `<p class="status-label">${homeLabels[me.home_status]}</p>${me.home_reason ? `<p class="attention">${e(me.home_reason)}</p>` : ''}${me.home_code ? `<dl class="facts"><div><dt>已保存口令</dt><dd class="code">${e(me.home_code)}</dd></div><div><dt>提交版本</dt><dd>${me.home_version}</dd></div></dl>` : ''}${me.home_status === 'pending' ? savedTemplate(data) : ''}${canAct(s, 'homeworld-submit') ? `<${me.home_code ? 'details' : 'section'}>${me.home_code ? '<summary>修改母星口令</summary>' : ''}<form data-action="homeworld-submit">${coordinate(me.home_code)}<p>保存后，将登记消息和母星现场时间水印照片发给裁判核对。</p><div data-valid-submit><button class="primary" type="submit">保存母星登记</button></div></form></${me.home_code ? 'details' : 'section'}>` : ''}${me.home_status === 'alive' && me.flight_status === 'prelaunch' ? link('/player/preflight', '开始首航准备', true) : ''}`
    );
  if (path === '/player/preflight') {
    if (
      !['prelaunch', 'staged', 'outfitting', 'ready'].includes(me.flight_status) ||
      s.match.phase === 'ended'
    )
      return heading('首航准备', '/player') + blocked();
    let body: string;
    if (canAct(s, 'preflight-depart'))
      body = actionButton(
        s,
        'preflight-depart',
        '确认已离开母星',
        '请离开母星至少50米，暂不佩戴比赛手环。',
      );
    else if (canAct(s, 'preflight-stage'))
      body =
        `<div class="material-colors">${COLORS.map((c) => `<span>${swatch(c.id)}${c.name}</span>`).join('')}</div>` +
        actionButton(s, 'preflight-stage', '准备完成', '请核对七种颜色各一条的同款手环。');
    else if (canAct(s, 'preflight-issue-code'))
      body = actionButton(
        s,
        'preflight-issue-code',
        '领取手环配置',
        '请在安全位置领取本人的手环配置。',
      );
    else if (me.bracelet)
      body =
        bracelets(me.bracelet) +
        (canAct(s, 'preflight-ready')
          ? actionButton(
              s,
              'preflight-ready',
              '确认穿戴就绪',
              '请按图示佩戴手环，其余手环收入口袋。正式开赛前不能攻防。',
            )
          : `<p>已穿戴就绪。${me.started_at_utc_ms ? '请等待统一开赛。' : '等待裁判安排开赛。'}</p>${timer('距离开赛', 'utc', me.started_at_utc_ms)}`);
    else body = `<p>等待裁判安排发码。</p>${timer('距离发码', 'utc', me.code_release_at_utc_ms)}`;
    return heading('首航准备', '/player') + body;
  }
  if (path === '/player/respawn') {
    if (
      !['returning', 'preparing', 'issued'].includes(me.flight_status) ||
      s.match.phase === 'ended'
    )
      return heading('重生', '/player') + blocked();
    return (
      heading('重生', '/player') +
      timer('距离重生截止', 'game', me.respawn_deadline_game_ms) +
      `<p>必须在截止前完成出航。所有步骤共用这段时间。</p>` +
      (s.match.paused
        ? `<p>比赛已暂停，重生期限冻结，请等待恢复。</p>`
        : me.flight_status === 'returning'
          ? `<h2>返回母星并发送照片</h2><p>请摘下全部比赛手环，正常步行返回母星。拍摄现场时间水印照片，并通过QQ发给裁判。</p><p>本人母星口令：<span class="code">${e(me.home_code)}</span></p>${savedTemplate(data)}${actionButton(s, 'return-confirm', '已发送照片', '请确认已向裁判发送本航次文字和现场照片。')}`
          : me.flight_status === 'preparing'
            ? actionButton(
                s,
                'issue-code',
                '已离开母星，领取新配置',
                '保持不佩戴手环，离开母星至少50米。',
              )
            : `${me.bracelet ? bracelets(me.bracelet) : ''}${actionButton(s, 'launch', '完成出航', '请在安全位置按新配置佩戴全部手环，其余收入口袋。')}`)
    );
  }
  if (path === '/player/actions' || path === '/player/actions/sighting') {
    const other = `${canAct(s, 'broadcast') ? link('/player/actions/broadcast', '正式广播') : ''}${canAct(s, 'photon') ? link('/player/actions/photon', '发射光粒') : ''}`;
    return (
      heading(canAct(s, 'sighting') ? '目击攻击' : '行动') +
      (canAct(s, 'sighting')
        ? '<div id="sighting-editor"></div>'
        : `${blocked()}${me.flight_status === 'active' && me.sighting_locked_until_utc_ms ? `${timer('距离恢复目击攻击', 'utc', me.sighting_locked_until_utc_ms)}<p>你仍在出航，可以被其他玩家击毁。</p>` : ''}`) +
      `${other ? `<div class="other-actions"><h2>其他可用行动</h2><div class="quiet-links">${other}</div></div>` : ''}<div class="quiet-links">${link('/rules#sighting', '查看目击规则')}</div>`
    );
  }
  if (path === '/player/actions/broadcast' || path === '/player/actions/photon') {
    const action = path.endsWith('broadcast') ? 'broadcast' : 'photon';
    const title = action === 'broadcast' ? '正式广播' : '发射光粒';
    if (!canAct(s, action)) return heading(title, '/player/actions') + blocked();
    return (
      heading(title, '/player/actions') +
      `<p>${action === 'broadcast' ? `剩余广播次数：${me.broadcast_remaining}次` : `可用光粒：${me.photon_remaining}枚`}</p><form data-action="${action}">${coordinate()}<div class="consequence"><p>${action === 'broadcast' ? '广播将公开这组六位口令，并消耗1次广播次数。若它对应某个文明的母星，该文明会获得你的母星口令。' : '发射将消耗1枚光粒。发射后查看实际公开结算结果。'}</p></div><div data-valid-submit><button class="primary" type="submit">${action === 'broadcast' ? '确认广播' : '发射光粒'}</button></div></form>${link('/player/intel', '查看已获母星情报')}`
    );
  }
  if (path === '/player/endgame')
    return (
      heading('终局说明', '/player') +
      `${s.match.hunt_review ? '<h2>终局资格确认中</h2><p>比赛时间停在98:00。等待裁判完成核验，获准后才能继续目击。</p>' : s.match.phase === 'transfer' ? timer('距离终局资格截止', 'game', s.match.clock.phase_end_game_ms) : ''}<ol class="steps"><li>${s.match.phase === 'transfer' || s.match.phase === 'hunt' ? '加入并保持' : '比赛时间90:00开始，请加入'}比赛QQ群的实时位置共享。</li><li>请查看QQ群文件中的${e(config.endgame_file || '终局圈图片')}，并使用手机高德地图前往。</li><li>在比赛时间98:00前进入终局圈，并保持位置共享。</li></ol><p>网站无需确认到达。裁判在QQ群和现场核验。</p>`
    );
  if (path === '/player/eliminated')
    return (
      heading('淘汰后安排', '/player') +
      (me.flight_status !== 'eliminated' || s.match.phase === 'ended'
        ? blocked()
        : `<h2>你已永久淘汰</h2><p>${e(me.elimination_reason)}</p><p class="muted">生效时间：${e(me.eliminated_at)}</p><p>请摘下全部比赛手环，步行返回裁判室。裁判室位置请查看QQ群文件。</p>${['transfer', 'hunt'].includes(s.match.phase) ? '<p>可以停止位置共享。</p>' : ''}${s.observer_allowed ? link('/observer', '进入宇宙观测', true) : timer('距离进入宇宙观测', 'utc', me.observer_unlock_at_utc_ms)}<p>观战信息仅供已淘汰玩家交流，请勿向仍在比赛中的玩家传递。</p>${link('/player/records', '查看本人战绩')}`)
    );
  if (path === '/player/me')
    return (
      heading('我的') +
      identity(me) +
      `<p>${flightLabels[me.flight_status]} ${homeLabels[me.home_status]}</p><div class="menu-list">${me.bracelet ? link('/player/bracelets', '本航次手环') : ''}${link('/player/homeworld', '本人母星')}${link('/player/records', '个人战绩')}${link('/player/intel', '母星情报')}${link('/rules', '比赛规则')}${link('/player/help', '联系裁判')}${link('/player/account', '账号与显示偏好')}</div>`
    );
  if (path === '/player/bracelets')
    return (
      heading('本人手环', '/player/me') +
      (me.bracelet ? bracelets(me.bracelet, true) : empty('当前没有待佩戴或现役配置。')) +
      `<details><summary>查看历史航次</summary>${
        me.flights
          ?.filter((b) => b.status === 'retired')
          .map((b) => bracelets(b, true))
          .join('') || empty('没有历史航次。')
      }</details>`
    );
  if (path === '/player/records')
    return (
      heading('个人战绩', '/player/me') +
      `<div class="stat-large"><span>已击毁的不同文明数</span><strong>${me.unique_sight_kills}</strong></div><p class="muted">同一文明被多次击毁只计一次。</p>${eventList(data, '/player/messages')}`
    );
  if (path === '/player/messages')
    return (
      heading('消息') +
      `<nav class="tabs" aria-label="消息分类">${[
        ['private', '本人消息'],
        ['public', '公开事件'],
        ['broadcast', '正式广播'],
      ]
        .map(
          ([key, label]) =>
            `<button data-tab="${key}" aria-pressed="${(new URLSearchParams(location.search).get('tab') ?? 'private') === key}">${label}</button>`,
        )
        .join('')}</nav>${eventList(data, '/player/messages')}`
    );
  if (path.startsWith('/player/messages/')) return eventDetail(data, '/player/messages');
  if (path === '/player/intel')
    return (
      heading('母星情报', '/player/me') +
      `<p class="muted">仅显示你已获得的情报，状态以获知时的信息为准。</p>${data?.events?.map((ev) => `<section class="intel-row"><p>${e(ev.title)}</p><strong class="code">${e(ev.code)}</strong><p>${e(ev.body)}</p><time>${e(ev.occurred_at)}</time><button data-copy="${e(ev.code)}">复制口令</button>${canAct(s, 'broadcast') ? `<a data-link href="/player/actions/broadcast?code=${e(ev.code)}">正式广播</a>` : ''}</section>`).join('') || empty('尚未获得母星情报。')}`
    );
  if (path === '/player/help')
    return (
      heading('联系裁判', '/player/me') +
      `<dl class="facts"><div><dt>比赛QQ群</dt><dd>${e(config.qq_group || '请查看参赛通知')}</dd></div><div><dt>裁判联系方式</dt><dd>${e(config.judge_contact || '请查看参赛通知')}</dd></div></dl><div class="menu-list">${link('/player/exception', '异常申报')}${link('/rules', '比赛规则')}</div>`
    );
  if (path === '/player/exception')
    return (
      heading('异常申报', '/player/help') +
      `<label class="field">遇到的情况<select id="exception-kind"><option value="equipment">手环损坏</option><option value="submission">网页无法提交</option><option value="review">攻击结果需要复核</option></select></label>${savedTemplate(data)}<p>请在QQ私聊中补充现场情况。</p>`
    );
  if (path === '/player/account')
    return (
      heading('账号与显示偏好', '/player/me') +
      identity(me) +
      `<label class="check"><input type="checkbox" id="reduce-motion" ${document.documentElement.dataset.motion === 'reduce' ? 'checked' : ''}>减少动态效果</label>${button('退出登录', 'logout')} ${canAct(s, 'withdraw') ? `<details class="danger-zone"><summary>退出比赛</summary><form data-action="withdraw"><p>确认退出后，你的文明将永久淘汰。</p><label class="check"><input type="checkbox" required>我确认永久退出本场比赛</label><button class="danger" type="submit">确认退出比赛</button></form></details>` : ''}`
    );
  return heading('页面不存在') + link('/player', '返回当前页面', true);
}
