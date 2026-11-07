import type {OperationResult} from '@darkforest/contracts';
import {Fault} from '../storage/store';
import type {PlayerActionContext} from './player_action_context';
import {
  confirmPreflightDeparture,
  confirmPreflightReadiness,
  confirmReturn,
  issuePreflightCode,
  issueRespawnCode,
  launchRespawn,
  stagePreflight,
  withdrawPlayer,
} from './player_flight';
import {setPlayerNickname, submitHomeworld} from './player_registration';
import {resolveSighting} from './player_sighting';
import {firePhoton, publishBroadcast} from './player_weapons';

/** 仅在格式与资格门禁之后分派玩家动作，审计和版本更新仍由入口统一完成。 */
export function dispatchPlayerAction(
  action: string,
  context: PlayerActionContext,
): OperationResult {
  switch (action) {
    case 'nickname':
      return setPlayerNickname(context);
    case 'homeworld-submit':
      return submitHomeworld(context);
    case 'preflight-depart':
      return confirmPreflightDeparture(context);
    case 'preflight-stage':
      return stagePreflight(context);
    case 'preflight-issue-code':
      return issuePreflightCode(context);
    case 'preflight-ready':
      return confirmPreflightReadiness(context);
    case 'return-confirm':
      return confirmReturn(context);
    case 'issue-code':
      return issueRespawnCode(context);
    case 'launch':
      return launchRespawn(context);
    case 'withdraw':
      return withdrawPlayer(context);
    case 'sighting':
      return resolveSighting(context);
    case 'broadcast':
      return publishBroadcast(context);
    case 'photon':
      return firePhoton(context);
    default:
      throw new Fault(404, 'NOT_FOUND', '未找到这项操作。');
  }
}
