import type { Action, Arms, ColorId, SessionState } from '@darkforest/contracts';

export const phaseLabels = {
  setup: '赛前准备',
  armed: '等待发码',
  outfitting: '佩戴准备',
  start_countdown: '等待开赛',
  forest: '黑暗森林',
  apocalypse: '宇宙末日',
  transfer: '终局转场',
  hunt: '最后狩猎',
  ended: '比赛结束',
};
export const flightLabels = {
  prelaunch: '首航准备',
  staged: '等待领取手环',
  outfitting: '等待穿戴就绪',
  ready: '等待正式开赛',
  active: '正常出航',
  returning: '返回母星',
  preparing: '准备重生',
  issued: '等待完成出航',
  eliminated: '永久淘汰',
};
export const homeLabels = {
  unregistered: '尚未登记',
  pending: '等待审核',
  rejected: '退回修改',
  alive: '母星尚存',
  destroyed: '母星已毁灭',
};
export function canAct(state: SessionState, action: Action): boolean {
  if (
    state.role !== 'player' ||
    !state.me ||
    !state.allowed_actions.includes(action) ||
    state.match.phase === 'ended' ||
    state.me.flight_status === 'eliminated'
  )
    return false;
  const { match, me } = state;
  if (match.paused) return false;
  if (['sighting', 'broadcast', 'photon'].includes(action)) {
    if (me.flight_status !== 'active') return false;
    if (action === 'sighting')
      return ['forest', 'apocalypse', 'hunt'].includes(match.phase) && !match.hunt_review;
    return (
      match.phase === 'forest' &&
      (action === 'broadcast' ? me.broadcast_remaining > 0 : me.photon_remaining > 0)
    );
  }
  const setup = ['setup', 'armed', 'outfitting', 'start_countdown'].includes(match.phase);
  if (action === 'nickname' || action === 'homeworld-submit') return setup;
  if (action === 'preflight-depart' || action === 'preflight-stage')
    return setup && me.flight_status === 'prelaunch' && me.home_status === 'alive';
  if (action === 'preflight-issue-code')
    return match.phase === 'outfitting' && me.flight_status === 'staged';
  if (action === 'preflight-ready')
    return match.phase === 'outfitting' && me.flight_status === 'outfitting';
  if (['return-confirm', 'issue-code', 'launch'].includes(action)) {
    const flight = { 'return-confirm': 'returning', 'issue-code': 'preparing', launch: 'issued' };
    return (
      match.phase === 'forest' &&
      me.home_status === 'alive' &&
      me.flight_status === flight[action as keyof typeof flight]
    );
  }
  return action === 'withdraw' && !setup;
}
export function wrongConsequence(count: number): string {
  return count === 0
    ? '提交错误的目击码，将禁止目击攻击5分钟。'
    : count === 1
      ? '再次提交错误的目击码，有50%的概率永久淘汰，有50%的概率禁止目击攻击15分钟。'
      : '再次提交错误的目击码，将永久淘汰。';
}
export function moveColor(
  arms: Arms,
  color: ColorId,
  target: 0 | 1 | null,
): { arms: Arms; error: string } {
  const next: Arms = [arms[0].filter((c) => c !== color), arms[1].filter((c) => c !== color)];
  if (target !== null) next[target].push(color);
  if (next.some((a) => a.length > 3)) return { arms, error: '每侧最多选择3条' };
  if (next.flat().length > 4) return { arms, error: '最多选择4条手环' };
  return { arms: next, error: '' };
}
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function clockNow(state: SessionState, elapsed: number) {
  const clock = state.match.clock;
  return {
    utc: clock.server_utc_ms + elapsed,
    game:
      clock.game_ms +
      (clock.running && !state.match.paused && state.match.phase !== 'ended' ? elapsed : 0),
  };
}
export const actionPaths: Record<Action, string> = {
  nickname: '/api/player/nickname',
  'homeworld-submit': '/api/action/homeworld-submit',
  'preflight-depart': '/api/action/preflight-depart',
  'preflight-stage': '/api/action/preflight-stage',
  'preflight-issue-code': '/api/action/preflight-issue-code',
  'preflight-ready': '/api/action/preflight-ready',
  sighting: '/api/action/sighting',
  broadcast: '/api/action/broadcast',
  photon: '/api/action/photon',
  'return-confirm': '/api/action/return-confirm',
  'issue-code': '/api/action/issue-code',
  launch: '/api/action/launch',
  withdraw: '/api/action/withdraw',
};
