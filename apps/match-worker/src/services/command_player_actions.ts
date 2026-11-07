import {
  commandSpec,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {Fault, permission} from '../storage/store';
import type {CommandContext} from './command_context';
import {
  commandValue,
  invokeJudgeAction,
  validateCommandArguments,
} from './command_context';
import type {CommandPlayerContext} from './command_player_context';
import {
  changeCommandTags,
  noteCommandPreflight,
  renameCommandPlayers,
} from './command_player_records';
import {
  changeCommandPenalties,
  changeCommandResources,
} from './command_player_resources';
import {
  changeCommandHomeworlds,
  changeCommandObservation,
  eliminateCommandPlayers,
  restoreCommandPlayers,
} from './command_player_rulings';

/** Execute player commands inside the caller's existing preview or commit transaction. */
export function handlePlayerAction(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  const spec = commandSpec(commandNode)!;

  permission(commandContext.actor, spec.permission);

  validateCommandArguments(commandNode);

  const engine = commandContext.engine;

  const db = engine.db;

  const matchState = db.match();

  const path = spec.path;

  const commandArguments = commandNode.words
    .slice(path.split(' ').length)
    .map(v => commandValue(v, commandContext));

  const source = `judge:${commandContext.actor.id}:${commandContext.id}:${commandContext.work}`;

  const context: CommandPlayerContext = {
    commandContext,
    engine,
    db,
    matchState,
    path,
    commandArguments,
    source,
  };

  if (path === 'clock pause' || path === 'clock resume') {
    return invokeJudgeAction(
      commandContext,
      path.endsWith('pause') ? '/judge/pause' : '/judge/resume',
      {},
    );
  }

  if (path === 'player eliminate' || path === 'hunt eliminate') {
    return eliminateCommandPlayers(context);
  }

  if (path === 'player restore') {
    return restoreCommandPlayers(context);
  }

  if (path === 'player rename') {
    return renameCommandPlayers(context);
  }

  if (
    [
      'resource set',
      'resource add',
      'photon grant',
      'photon revoke',
      'tech grant',
    ].includes(path)
  ) {
    return changeCommandResources(context);
  }

  if (path.startsWith('penalty ')) {
    return changeCommandPenalties(context);
  }

  if (path === 'tag add' || path === 'tag remove') {
    return changeCommandTags(context);
  }

  if (path === 'preflight note') {
    return noteCommandPreflight(context);
  }

  if (path === 'observer revoke' || path === 'observer restore') {
    return changeCommandObservation(context);
  }

  if (path === 'homeworld destroy' || path === 'homeworld restore') {
    return changeCommandHomeworlds(context);
  }

  throw new Fault(400, 'UNKNOWN_COMMAND', '命令没有执行处理器：' + path);
}
