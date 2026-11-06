import {requireThat} from '../storage/store';
import type {MatchControlContext} from './match_control_context';
import {readControlSummary, readMatchTemplate} from './match_control_reads';
import {eraseMatchSecrets} from './match_erasure';
import {
  adoptLegacyMatch,
  initializeControlledMatch,
  publishPreparationEntry,
} from './match_initialization';
import {
  acceptMatchInvitation,
  applyAuthorizationFence,
  assignMatchSeat,
  bindAcceptedPlayer,
  inviteMatchMember,
  removeMatchMember,
} from './match_members';
/** 在原事务中复核本场生命周期后分派控制动作，保留初始化与普通变更的版本差异。 */
export function dispatchMatchControl(context: MatchControlContext): unknown {
  const {request, db} = context;
  let result: unknown;
  if (request.action === 'initialize') {
    result = initializeControlledMatch(context);
  } else if (request.action === 'adopt-legacy') {
    result = adoptLegacyMatch(context);
  } else {
    requireThat(
      db.one<Record<string, SqlStorageValue>>('SELECT id FROM match_identity'),
      'LEGACY_MIGRATION_REQUIRED',
      '请先通过部署向导登记旧比赛。',
    );
    requireThat(
      !db.match().recovery_state ||
        ['summary', 'fence', 'erase'].includes(request.action),
      'RECOVERY_LOCKED',
      '比赛正在恢复，成员与任职变更须等待核对。',
    );
    requireThat(
      !['purged', 'imported_archive'].includes(
        String(
          db.one<{management_state: string}>(
            'SELECT management_state FROM match_identity',
          )?.management_state,
        ),
      ),
      'MATCH_CLOSED',
      '该比赛只保留历史墓碑。',
      410,
    );
    if (request.action === 'template') {
      result = readMatchTemplate(context);
    } else if (request.action === 'erase') {
      result = eraseMatchSecrets(context);
    } else if (request.action === 'summary') {
      result = readControlSummary(context);
    } else if (request.action === 'invite') {
      result = inviteMatchMember(context);
    } else if (request.action === 'remove-member') {
      result = removeMatchMember(context);
    } else if (request.action === 'accept') {
      result = acceptMatchInvitation(context);
    } else if (request.action === 'bind') {
      result = bindAcceptedPlayer(context);
    } else if (request.action === 'assign') {
      result = assignMatchSeat(context);
    } else if (request.action === 'fence') {
      result = applyAuthorizationFence(context);
    } else if (request.action === 'publish') {
      result = publishPreparationEntry(context);
    } else {
      throw new Error('UNKNOWN_CONTROL_ACTION');
    }
    if (!['summary', 'template'].includes(request.action)) {
      db.bump();
    }
  }
  return result;
}
