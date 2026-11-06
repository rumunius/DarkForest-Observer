import type {Action, Snapshot} from '@darkforest/contracts';

/** 按快照控制页面动作可见性；正式提交仍由服务端重新授权。 */
export function canAct(data: Snapshot, action: Action): boolean {
  const {player: me, match} = data;
  if (
    !me ||
    !match ||
    !me.actions.includes(action) ||
    match.stage === 'ended' ||
    me.flight === 'eliminated' ||
    me.flight === 'absent'
  ) {
    return false;
  }
  if (match.paused) {
    return false;
  }
  if (
    ['sighting', 'broadcast', 'photon'].includes(action) &&
    me.flight !== 'active'
  ) {
    return false;
  }
  if (
    action === 'sighting' &&
    (!['forest', 'apocalypse', 'hunt'].includes(match.stage) ||
      match.verification ||
      me.attackLockedUntil > match.serverUtcMs)
  ) {
    return false;
  }
  if (['broadcast', 'photon'].includes(action) && match.stage !== 'forest') {
    return false;
  }
  if (action === 'broadcast' && me.broadcasts <= 0) {
    return false;
  }
  if (action === 'photon' && me.photons <= 0) {
    return false;
  }
  return true;
}
/** 判断当前裁判页面职责，平台身份或隐藏按钮不能代替API权限。 */
export function judgeCan(data: Snapshot, area: string): boolean {
  return (
    data.session?.role === 'judge' &&
    (data.session.permissions.includes('*') ||
      data.session.permissions.includes(area))
  );
}
