import type { PageData, SessionState } from '@darkforest/contracts';
import { bracelets, civilizationSummary, e, empty, heading, link } from '../ui';
import { eventDetail, eventList } from './player';
import { civilizationList, stats } from './judge';
export function observePage(path: string, s: SessionState, data: PageData | null): string {
  const result = path.startsWith('/results');
  const display = path === '/display';
  if (
    display
      ? s.role !== 'judge' || !s.permissions.includes('display')
      : result
        ? !s.results_allowed || s.match.phase !== 'ended'
        : !s.observer_allowed || s.role !== 'player' || s.me?.flight_status !== 'eliminated'
  )
    return (
      heading('无查看权限') +
      empty('当前账号不能查看这项内容。') +
      link(s.role === 'judge' ? '/judge' : '/player', '返回当前页面')
    );
  const base = result ? '/results' : '/observer';
  if (display) {
    const tab = new URLSearchParams(location.search).get('tab') ?? 'overview';
    const page = Number(new URLSearchParams(location.search).get('page') ?? 0);
    return (
      heading('宇宙观测') +
      `<nav class="tabs">${[['overview', '全场概况'], ['civilizations', '文明状态'], ['events', '赛事事件'], ...(s.match.phase === 'ended' ? [['results', '比赛结果']] : [])].map(([id, label]) => `<button data-tab="${id}" aria-pressed="${tab === id}">${label}</button>`).join('')}</nav><div class="display-content">${
        tab === 'overview'
          ? stats(data)
          : tab === 'civilizations'
            ? `<div class="display-civilizations">${
                data?.civilizations
                  ?.slice(page * 6, page * 6 + 6)
                  .map((c) => `<section>${civilizationSummary(c)}</section>`)
                  .join('') || empty()
              }</div>`
            : tab === 'events'
              ? eventList(
                  {
                    version: data?.version ?? 0,
                    events: data?.events?.slice(page * 4, page * 4 + 4) ?? [],
                  },
                  '/observer/events',
                )
              : rankings(data)
      } </div><div class="display-controls"><button data-page="${Math.max(0, page - 1)}" ${page === 0 ? 'disabled' : ''}>上一页</button><span>第${page + 1}页</span><button data-page="${page + 1}" ${page + 1 >= Math.ceil((tab === 'civilizations' ? (data?.civilizations?.length ?? 0) : tab === 'events' ? (data?.events?.length ?? 0) : 1) / (tab === 'civilizations' ? 6 : 4)) ? 'disabled' : ''}>下一页</button><label class="check"><input type="checkbox" id="autoplay">自动轮播（12秒）</label></div>`
    );
  }
  if (path.includes('/civilizations/')) {
    const c = data?.civilization;
    return (
      heading(result ? '文明复盘' : '文明详情', result ? '/results' : '/observer/civilizations') +
      (c
        ? `${civilizationSummary(c)}${c.bracelet ? bracelets(c.bracelet, true) : ''}<details><summary>查看航次记录</summary>${c.flights?.map((b) => bracelets(b, true)).join('') || empty()}</details><h2>相关事件</h2>${eventList(data, `${base}/events`)}`
        : empty(data ? '文明记录不存在。' : '正在加载文明…'))
    );
  }
  if (path.endsWith('/civilizations'))
    return heading('文明列表', base) + civilizationList(data, `${base}/civilizations`);
  if (path.includes('/events/')) return eventDetail(data, `${base}/events`);
  if (path.endsWith('/events'))
    return (
      heading(result ? '完整战报' : '赛事事件', base) +
      `<details><summary>筛选事件</summary><form data-event-filter>${'<label class="field">文明编号<input name="civilization" type="search"></label><label class="field">事件类型<select name="kind"><option value="">全部事件</option><option value="sighting">目击</option><option value="broadcast">正式广播</option><option value="photon">光粒</option><option value="singer">歌者</option><option value="tech">技术爆炸</option><option value="respawn">重生</option><option value="phase">阶段变化</option><option value="correction">裁判更正</option></select></label><label class="field">发生时间起点<input name="after" type="datetime-local"></label>'}<button type="submit">应用筛选</button></form></details>${eventList(data, `${base}/events`)}`
    );
  if (result)
    return (
      heading('比赛结果') +
      `<p>${e(data?.finish_reason ?? '正在读取正式结果…')}</p>${data?.rankings && !data.rankings.some((r) => r.champion) ? '<h2>本场没有存活冠军</h2>' : ''}${
        data?.rankings
          ?.filter((r) => r.champion)
          .map(
            (r) =>
              `<div class="champion"><p>${r.tied ? '并列冠军' : '冠军'}</p><h2>${e(r.nickname)}</h2><span>${e(r.id)}</span></div>`,
          )
          .join('') ?? ''
      }<p class="muted">报告版本：${e(data?.report_version ?? '正在读取')}</p>${link('/results/events', '查看完整战报', true)}<h2>正式名次</h2>${rankings(data)}${link('/player', '返回本人页面')}`
    );
  return (
    heading('宇宙观测') +
    `<p>你已永久淘汰，可以查看当前战况和已经发生的赛事记录。</p><p class="muted">请勿向仍在比赛中的玩家传递观战情报。</p>${stats(data)}<div class="quiet-links">${link('/observer/civilizations', '查看全部文明')}${link('/observer/events', '查看赛事事件')}</div>${eventList(data, '/observer/events')}`
  );
}
function rankings(data: PageData | null) {
  return data?.rankings?.length
    ? `<div class="rankings">${data.rankings.map((r) => `<a href="/results/civilizations/${e(r.id)}" data-link class="rank-row"><strong>${r.tied ? '并列' : ''}第${r.rank}名</strong><span>${e(r.id)}<br>${e(r.nickname)}</span><span>${e(r.status)}</span><span>击毁${r.kills}个不同文明</span></a>`).join('')}</div>`
    : empty('正在读取正式名次…');
}
