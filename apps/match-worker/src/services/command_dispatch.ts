import {
  commandSpec,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {Fault} from '../storage/store';
import {handleAdminAction} from './command_admin_actions';
import type {CommandContext} from './command_context';
import {handleEventAction} from './command_event_actions';
import {handleMessageAction} from './command_message_actions';
import {handlePlayerAction} from './command_player_actions';
import {handleReportAction} from './command_report_actions';
import {handleWorldAction} from './command_world_actions';

/** 按已解析路径派发单条写命令，处理器仍执行相应权限及状态检查。 */
export function dispatchCommandAction(
  commandContext: CommandContext,
  n: CommandNode,
): unknown {
  const path = commandSpec(n)!.path;
  if (
    path === 'clock pause' ||
    path === 'clock resume' ||
    path === 'player eliminate' ||
    path === 'hunt eliminate' ||
    path === 'player restore' ||
    path === 'player rename' ||
    [
      'resource set',
      'resource add',
      'photon grant',
      'photon revoke',
      'tech grant',
    ].includes(path) ||
    path.startsWith('penalty ') ||
    path === 'tag add' ||
    path === 'tag remove' ||
    path === 'preflight note' ||
    path === 'observer revoke' ||
    path === 'observer restore' ||
    path === 'homeworld destroy' ||
    path === 'homeworld restore'
  ) {
    return handlePlayerAction(commandContext, n);
  }
  if (
    path === 'homeworld verify' ||
    path === 'homeworld reject' ||
    path === 'homeworld correct-coordinate' ||
    path.startsWith('code ') ||
    path === 'attack invalidate' ||
    path === 'attack correct-penalty' ||
    path.startsWith('effect ') ||
    path === 'announce' ||
    path === 'tell'
  ) {
    return handleWorldAction(commandContext, n);
  }
  if (
    path === 'reveal' ||
    path === 'replay' ||
    path === 'message retract' ||
    path === 'notice mark' ||
    path === 'notice retry' ||
    path === 'roster add' ||
    path === 'roster remove'
  ) {
    return handleMessageAction(commandContext, n);
  }
  if (
    path === 'roster withdraw' ||
    path.startsWith('match ') ||
    path === 'parameter set' ||
    path === 'setting set' ||
    path === 'palette set' ||
    path === 'template publish' ||
    path.startsWith('account ') ||
    path === 'session revoke' ||
    path === 'recovery finalize' ||
    path === 'export create'
  ) {
    return handleAdminAction(commandContext, n);
  }
  if (
    path === 'event retry' ||
    path === 'event cancel' ||
    path === 'event trigger singer' ||
    path === 'event trigger tech-burst' ||
    path === 'scheduler rearm' ||
    path === 'scheduler settle-due' ||
    path.startsWith('hunt draft ') ||
    path === 'hunt finalize' ||
    path === 'case open'
  ) {
    return handleEventAction(commandContext, n);
  }
  if (
    path === 'case evidence' ||
    path === 'case close' ||
    path === 'report correct' ||
    path === 'report publish'
  ) {
    return handleReportAction(commandContext, n);
  }
  throw new Fault(400, 'UNKNOWN_COMMAND', '命令没有执行处理器：' + path);
}
