import type { GameEvent, ResultsState } from '@darkforest/contracts';
import type { Engine } from './engine';
import { civilization } from '../projections/snapshot';
import type { CodeRow } from '../storage/store';

export function logEvent(
  e: Engine,
  id: string,
  kind: GameEvent['kind'],
  title: string,
  body: string,
  audience: GameEvent['audience'],
  ids: string[],
  game: number,
  utc: number,
  owner: string | null = null,
  code: string | null = null,
  actor: string | null = null,
): void {
  e.db.exec(
    'INSERT INTO event_log(id,kind,title,body,audience,owner,civilization_ids,code,actor,game_ms,utc_ms,committed_utc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id,
    kind,
    title,
    body,
    audience,
    owner,
    JSON.stringify(ids),
    code,
    actor,
    game,
    utc,
    e.now(),
  );
}
export function retire(e: Engine, player: string, reason: string, game: number, utc: number): void {
  e.db.exec(
    "UPDATE sighting_codes SET status='retired',retired_game=?,retired_utc=?,retired_reason=? WHERE player_id=? AND status IN ('active','reserved')",
    game,
    utc,
    reason,
    player,
  );
  e.db.exec('UPDATE flights SET code_id=NULL WHERE player_id=?', player);
}
export function eliminate(
  e: Engine,
  player: string,
  reason: string,
  source: string,
  game: number,
  utc: number,
  group = source,
): void {
  if (e.db.flight(player).status === 'eliminated') return;
  if (source.startsWith('judge:') || source === 'hunt_cutoff')
    e.db.exec(
      'INSERT INTO judge_eliminations(source,player_id,before_json) VALUES(?,?,?)',
      source,
      player,
      JSON.stringify(e.db.flight(player)),
    );
  retire(e, player, reason, game, utc);
  e.db.exec("UPDATE flights SET status='eliminated',deadline=NULL WHERE player_id=?", player);
  e.db.exec(
    'INSERT INTO eliminations(player_id,game_ms,utc_ms,committed_utc,reason,source,group_id) VALUES(?,?,?,?,?,?,?)',
    player,
    game,
    utc,
    e.now(),
    reason,
    source,
    group,
  );
  const body = `${e.identity(player)}已永久淘汰。请在安全位置摘下全部比赛手环，停止正式行动，返回中控室。观战等待${e.db.parameters().observerWaitSeconds}秒。`;
  logEvent(
    e,
    `${source}:elimination:${player}`,
    'notice',
    '永久淘汰',
    body,
    'personal',
    [player],
    game,
    utc,
    player,
  );
  e.notice(source, player, '永久淘汰', body, game);
}
export function destroyHome(
  e: Engine,
  player: string,
  source: string,
  game: number,
  utc: number,
): boolean {
  const changed = e.db.all(
    "UPDATE homeworlds SET destroyed_game=?,source=? WHERE player_id=? AND status='verified' AND destroyed_game IS NULL RETURNING player_id",
    game,
    source,
    player,
  );
  if (!changed.length) return false;
  if (!['active', 'eliminated'].includes(e.db.flight(player).status))
    eliminate(e, player, 'homeworld_destroyed', source, game, utc);
  e.notice(
    source,
    player,
    '母星毁灭',
    `${e.identity(player)}的母星已毁灭。已出航者继续最后一命，未出航者永久淘汰。`,
    game,
  );
  return true;
}
export function survivors(e: Engine): string[] {
  return e.db
    .all<{ id: string }>(
      "SELECT p.id FROM players p JOIN flights f ON f.player_id=p.id WHERE p.entry_status='registered' AND p.id IN (SELECT player_id FROM roster_members) AND f.status!='eliminated' ORDER BY p.id",
    )
    .map((p) => p.id);
}
export function finish(e: Engine, reason: string, game: number, utc: number, source: string): void {
  if (e.db.match().phase === 'ended') return;
  const alive = new Set(survivors(e));
  e.db.exec(
    "UPDATE matches SET phase='ended',ended_game=?,ended_utc=?,finish_reason=?",
    game,
    utc,
    reason,
  );
  archiveReport(e, '');
  const registered = e.db.all<{ id: string }>('SELECT player_id AS id FROM roster_members');
  for (const player of registered) retire(e, player.id, 'match_ended', game, utc);
  e.db.exec("UPDATE scheduled_events SET status='cancelled' WHERE status='pending'");
  logEvent(
    e,
    `finish:${source}`,
    'stage',
    '比赛结束',
    reason === 'all_eliminated'
      ? '全部文明已淘汰，本场无存活冠军。'
      : '本场比赛已结束，完整复盘已开放。',
    'public',
    [...alive],
    game,
    utc,
  );
  e.notice(
    `finish:${source}`,
    'group',
    '比赛结束',
    '本场比赛已结束。请停止正式行动及QQ群位置共享，查看官网战报。',
    game,
  );
}
export function archiveReport(e: Engine, correctionReason: string): void {
  const alive = new Set(survivors(e));
  const eliminated = e.db.all<{ player_id: string; seq: number; utc_ms: number; group_id: string }>(
    'SELECT player_id,seq,utc_ms,group_id FROM eliminations WHERE valid=1 ORDER BY utc_ms DESC,seq DESC',
  );
  const registered = e.db.all<{ id: string }>(
    "SELECT id FROM players WHERE id IN (SELECT player_id FROM roster_members) AND (entry_status='registered' OR id IN (SELECT player_id FROM eliminations WHERE valid=1)) ORDER BY id",
  );
  // Save ranking facts before retiring codes. Full DTO is rendered from the same immutable finish facts.
  const standings = registered
    .map(({ id }) => {
      const kills = e.db.one<{ count: number }>(
        "SELECT COUNT(DISTINCT target) AS count FROM attacks WHERE actor=? AND classification='hit' AND valid=1",
        id,
      )!.count;
      const out = eliminated.find((p) => p.player_id === id);
      return {
        id,
        alive: alive.has(id),
        kills,
        utc: out?.utc_ms ?? 0,
        seq: out?.seq ?? 0,
        group: out?.group_id ?? '',
      };
    })
    .sort(
      (a, b) =>
        Number(b.alive) - Number(a.alive) ||
        (a.alive ? b.kills - a.kills : b.utc - a.utc || b.seq - a.seq),
    );
  const ranked = standings.map((p, i) => {
    const equal = (q: typeof p) =>
      p.alive === q.alive && (p.alive ? p.kills === q.kills : !!p.group && p.group === q.group);
    const first = standings.findIndex(equal);
    return { ...p, rank: first + 1, tied: standings.filter(equal).length > 1, index: i };
  });
  e.db.exec(
    'INSERT INTO result_reports(version,reason,created_utc,report,correction_reason,snapshot_json) VALUES((SELECT COALESCE(MAX(version),0)+1 FROM result_reports),?,?,?,?,?)',
    e.db.match().finish_reason,
    e.now(),
    JSON.stringify({
      champions: ranked.filter((p) => p.alive && p.rank === 1).map((p) => p.id),
      standings: ranked,
    }),
    correctionReason,
    JSON.stringify(
      ranked.map((p) => ({
        ...civilization(e, p.id, e.resolvedKeys!, true),
        kills: p.kills,
        rank: p.rank,
        tied: p.tied,
      })),
    ),
  );
}
export function autoFinish(e: Engine, game: number, utc: number, source: string): void {
  const match = e.db.match();
  if (!match.start_settled || match.phase === 'ended') return;
  const count = survivors(e).length;
  if (count <= 1) finish(e, count ? 'last_survivor' : 'all_eliminated', game, utc, source);
}
export function results(
  e: Engine,
  keys: Awaited<ReturnType<Engine['keys']>>,
  version?: number,
): ResultsState | null {
  const row = e.db.one<{
    version: number;
    reason: string;
    report: string;
    correction_reason: string;
    snapshot_json: string | null;
  }>(
    version === undefined
      ? 'SELECT * FROM result_reports ORDER BY version DESC LIMIT 1'
      : 'SELECT * FROM result_reports WHERE version=?',
    ...(version === undefined ? [] : [version]),
  );
  if (!row) return null;
  const report = JSON.parse(row.report) as {
    champions: string[];
    standings: { id: string; rank: number; tied: boolean; kills: number }[];
  };
  const standings = row.snapshot_json
    ? (JSON.parse(row.snapshot_json) as ResultsState['standings'])
    : report.standings.map((p) => ({
        ...civilization(e, p.id, keys, true),
        rank: p.rank,
        tied: p.tied,
        kills: p.kills,
      }));
  if (!row.snapshot_json)
    e.db.exec(
      'UPDATE result_reports SET snapshot_json=? WHERE version=?',
      JSON.stringify(standings),
      row.version,
    );
  return {
    version: row.version,
    reason:
      (
        {
          regulation: '比赛时间结束',
          last_survivor: '本场仅余一个存活文明，提前完赛',
          all_eliminated: '全部文明已永久淘汰',
        } as Record<string, string>
      )[row.reason] ?? row.reason,
    champions: report.champions,
    correctionReason: row.correction_reason,
    standings,
  };
}
export function currentCode(e: Engine, player: string): CodeRow | undefined {
  const id = e.db.flight(player).code_id;
  return id ? e.db.one<CodeRow>('SELECT * FROM sighting_codes WHERE id=?', id) : undefined;
}
