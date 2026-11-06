import {
  integer,
  nickname,
  text,
} from '../../../../packages/contracts/src/backend';
import {requireThat} from '../storage/store';
import type {Engine} from './engine';
import {archiveReport, results} from './life';
export function validateReportCorrection(
  e: Engine,
  body: Record<string, unknown>,
): void {
  requireThat(
    e.db.match().phase === 'ended',
    'RESULTS_NOT_READY',
    '比赛结束后可更正战报。',
  );
  const version = e.db.one<{version: number}>(
    'SELECT MAX(version) AS version FROM result_reports',
  )!.version;
  requireThat(
    version === integer(body.expected_version, 1),
    'REPORT_VERSION_CONFLICT',
    '战报已更新，请核对最新版本。',
  );
  const field = text(body.field, 32);
  const target = text(body.target, 180);
  requireThat(
    ['attack_valid', 'elimination_valid', 'nickname'].includes(field),
    'BAD_FIELD',
    '请选择更正项目。',
    400,
  );
  if (field === 'attack_valid') {
    requireThat(
      e.db.one('SELECT id FROM attacks WHERE id=?', target) &&
        typeof body.value === 'boolean',
      'ATTACK_NOT_FOUND',
      '请选择攻击记录。',
      400,
    );
  } else {
    e.db.player(target);
    requireThat(
      e.db.roster().includes(target),
      'NOT_PARTICIPANT',
      '请选择本场正式玩家。',
      400,
    );
    if (field === 'elimination_valid') {
      requireThat(
        e.db.one('SELECT seq FROM eliminations WHERE player_id=?', target) &&
          typeof body.value === 'boolean',
        'ELIMINATION_NOT_FOUND',
        '请选择淘汰记录。',
        400,
      );
    } else {
      const n = nickname(body.value);
      requireThat(
        !e.db.one(
          'SELECT id FROM players WHERE nickname=? AND id<>?',
          n,
          target,
        ),
        'NICKNAME_TAKEN',
        '这个昵称已被使用。',
      );
    }
  }
}
export function correctReport(
  e: Engine,
  body: Record<string, unknown>,
  reason: string,
): void {
  results(e, e.resolvedKeys!); // Freeze legacy reports before touching the current facts.
  const target = String(body.target);
  if (body.field === 'attack_valid') {
    e.db.exec(
      'UPDATE attacks SET valid=? WHERE id=?',
      body.value ? 1 : 0,
      target,
    );
  } else if (body.field === 'elimination_valid') {
    e.db.exec('UPDATE eliminations SET valid=0 WHERE player_id=?', target);
    if (body.value) {
      e.db.exec(
        'UPDATE eliminations SET valid=1 WHERE seq=(SELECT MAX(seq) FROM eliminations WHERE player_id=?)',
        target,
      );
    }
    e.db.exec(
      'UPDATE flights SET status=? WHERE player_id=?',
      body.value ? 'eliminated' : 'active',
      target,
    );
  } else {
    e.db.exec(
      'UPDATE players SET nickname=? WHERE id=?',
      nickname(body.value),
      target,
    );
  }
  archiveReport(e, reason);
}
