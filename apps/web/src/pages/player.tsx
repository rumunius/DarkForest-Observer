import {useApp} from '../state';
import {Empty} from '../ui';
import {Actions, CoordinateAction} from './player/actions';
import {Current, IdentityPage} from './player/current';
import {Homeworld, Preflight, Respawn} from './player/departure';
import {Eliminated, Endgame} from './player/endgame';
import {Intel, Messages} from './player/messages';
import {Account, Bracelets, Help, Me, Records} from './player/profile';

/** 按当前本场路径分派玩家页面，动作资格仍逐页按快照判断。 */
export function PlayerPages() {
  const {route} = useApp();
  if (route === '/player') {
    return <Current />;
  }
  if (route === '/player/identity') {
    return <IdentityPage />;
  }
  if (route === '/player/homeworld') {
    return <Homeworld />;
  }
  if (route === '/player/preflight') {
    return <Preflight />;
  }
  if (route === '/player/respawn') {
    return <Respawn />;
  }
  if (route === '/player/actions' || route === '/player/actions/sighting') {
    return <Actions sightingOnly={route.endsWith('/sighting')} />;
  }
  if (
    route === '/player/actions/broadcast' ||
    route === '/player/actions/photon'
  ) {
    return (
      <CoordinateAction
        action={route.endsWith('/photon') ? 'photon' : 'broadcast'}
      />
    );
  }
  if (route === '/player/endgame') {
    return <Endgame />;
  }
  if (route === '/player/eliminated') {
    return <Eliminated />;
  }
  if (route.startsWith('/player/messages')) {
    return <Messages />;
  }
  if (route === '/player/intel') {
    return <Intel />;
  }
  if (route === '/player/me') {
    return <Me />;
  }
  if (route === '/player/bracelets') {
    return <Bracelets />;
  }
  if (route === '/player/records') {
    return <Records />;
  }
  if (route === '/player/help' || route === '/player/exception') {
    return <Help exception={route.endsWith('/exception')} />;
  }
  if (route === '/player/account') {
    return <Account />;
  }
  return <Empty title="页面不存在" />;
}
export {Rules} from './player/rules';
