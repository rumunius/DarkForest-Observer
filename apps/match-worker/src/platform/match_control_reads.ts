import {parseJson} from '../../../../packages/contracts/src/backend';
import type {MatchMember} from '../../../../packages/contracts/src/platform';
import type {DEFAULT_SITE} from '../storage/store';
import type {MatchControlContext} from './match_control_context';

/** 仅投影允许复用的说明、色值和参数，不复制战局或授权材料。 */
export function readMatchTemplate(context: MatchControlContext): unknown {
  const {db} = context;
  const site = parseJson(db.match().site_json) as typeof DEFAULT_SITE;
  return {
    description: site.description,
    colors: site.colors,
    parameters: db.parameters(),
  };
}

/** 从本场权威记录提供目录、成员及授权投影所需摘要。 */
export function readControlSummary(context: MatchControlContext) {
  const {db} = context;
  const currentMatch = db.match();
  return {
    phase: currentMatch.phase,
    revision: currentMatch.revision,
    paused: currentMatch.paused_at !== null,
    endedUtc: currentMatch.ended_utc,
    recovering: !!currentMatch.recovery_state,
    reportVersion: db.one<{version: number | null}>(
      'SELECT MAX(version) AS version FROM result_reports',
    )?.version,
    erasureGeneration: db.one<{erasure_generation: number}>(
      'SELECT erasure_generation FROM match_identity',
    )?.erasure_generation,
    players: db.roster().length,
    participants: db
      .all<{account_id: string}>('SELECT account_id FROM participation_history')
      .map(row => row.account_id),
    members: db.all<MatchMember>('SELECT * FROM memberships'),
    assignments: db.all<{
      id: string;
      account_id: string;
      seat_id: string;
      started_utc: number;
      ended_utc: number | null;
      epoch: number;
    }>('SELECT * FROM staff_assignments'),
    seatVersions: db.all<{id: string; version: number}>(
      "SELECT id,version FROM accounts WHERE role='judge'",
    ),
    managementState: db.one<{management_state: string}>(
      'SELECT management_state FROM match_identity',
    )?.management_state,
  };
}

/** Internal summary contract, derived from its SQL-backed writer to prevent drift. */
export type MatchControlSummary = ReturnType<typeof readControlSummary>;
