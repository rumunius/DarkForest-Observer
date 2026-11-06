import {parseJson} from '../../../../packages/contracts/src/backend';
import type {GameEvent, ResultsState} from '@darkforest/contracts';
import type {Engine} from './engine';
import {civilization} from '../projections/snapshot';
import {
  eliminationCopy,
  homeDestroyedCopy,
} from '../../../../packages/contracts/src/message_copy';
import type {CodeRow} from '../storage/store';

/** 以固定来源、受众和双时间基准记录赛事事实；不把提交时间当作生效时间。 */
export function logEvent(
  engine: Engine,
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
  engine.db.exec(
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
    engine.now(),
  );
}
/** 永久退役指定现役手环码，已发行编码不能重新回到可发码池。 */
export function retire(
  engine: Engine,
  player: string,
  reason: string,
  game: number,
  utc: number,
): void {
  engine.db.exec(
    "UPDATE sighting_codes SET status='retired',retired_game=?,retired_utc=?,retired_reason=? WHERE player_id=? AND status IN ('active','reserved')",
    game,
    utc,
    reason,
    player,
  );
  engine.db.exec('UPDATE flights SET code_id=NULL WHERE player_id=?', player);
}
/** 原子登记淘汰事实并清理航次及通知；批量调用方最后统一判断提前完赛。 */
export function eliminate(
  engine: Engine,
  player: string,
  reason: string,
  source: string,
  game: number,
  utc: number,
  group = source,
): void {
  if (engine.db.flight(player).status === 'eliminated') {
    return;
  }
  if (source.startsWith('judge:') || source === 'hunt_cutoff') {
    engine.db.exec(
      'INSERT INTO judge_eliminations(source,player_id,before_json) VALUES(?,?,?)',
      source,
      player,
      JSON.stringify(engine.db.flight(player)),
    );
  }
  retire(engine, player, reason, game, utc);
  engine.db.exec(
    "UPDATE flights SET status='eliminated',deadline=NULL WHERE player_id=?",
    player,
  );
  engine.db.exec(
    'INSERT INTO eliminations(player_id,game_ms,utc_ms,committed_utc,reason,source,group_id) VALUES(?,?,?,?,?,?,?)',
    player,
    game,
    utc,
    engine.now(),
    reason,
    source,
    group,
  );
  const body = eliminationCopy(
    engine.identity(player),
    engine.db.parameters().observerWaitSeconds,
    reason === 'wrong_attack_direct_out',
  );
  logEvent(
    engine,
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
  engine.notice(source, player, '永久淘汰', body, game);
}
/** 处理母星毁灭与当前航次联动，返回是否新增毁灭而不重复结算。 */
export function destroyHome(
  engine: Engine,
  player: string,
  source: string,
  game: number,
  utc: number,
): boolean {
  const changed = engine.db.all<Record<string, SqlStorageValue>>(
    "UPDATE homeworlds SET destroyed_game=?,source=? WHERE player_id=? AND status='verified' AND destroyed_game IS NULL RETURNING player_id",
    game,
    source,
    player,
  );
  if (!changed.length) {
    return false;
  }
  if (!['active', 'eliminated'].includes(engine.db.flight(player).status)) {
    eliminate(engine, player, 'homeworld_destroyed', source, game, utc);
  }
  engine.notice(
    source,
    player,
    '母星毁灭',
    homeDestroyedCopy(engine.identity(player), engine.db.home(player)!.code),
    game,
  );
  return true;
}
/** 读取仍有存活或合法重生资格的正式文明，不能仅统计现役飞船。 */
export function survivors(engine: Engine): string[] {
  return engine.db
    .all<{id: string}>(
      "SELECT p.id FROM players p JOIN flights f ON f.player_id=p.id WHERE p.entry_status='registered' AND p.id IN (SELECT player_id FROM roster_members) AND f.status!='eliminated' ORDER BY p.id",
    )
    .map(p => p.id);
}
/** 封存完赛状态与结果并处置剩余任务，不重新开放已结束的玩法写入。 */
export function finish(
  engine: Engine,
  reason: string,
  game: number,
  utc: number,
  source: string,
): void {
  if (engine.db.match().phase === 'ended') {
    return;
  }
  const alive = new Set(survivors(engine));
  engine.db.exec(
    "UPDATE matches SET phase='ended',ended_game=?,ended_utc=?,finish_reason=?",
    game,
    utc,
    reason,
  );
  archiveReport(engine, '');
  const registered = engine.db.all<{id: string}>(
    'SELECT player_id AS id FROM roster_members',
  );
  for (const player of registered) {
    retire(engine, player.id, 'match_ended', game, utc);
  }
  engine.db.exec(
    "UPDATE command_objects SET status='cancelled' WHERE kind='schedule' AND status='pending' AND json_extract(data,'$.afterEnd')='cancel'",
  );
  engine.db.exec(
    "UPDATE command_objects SET status='cancelled' WHERE kind='job' AND status='pending'",
  );
  engine.db.exec(
    "UPDATE scheduled_events SET status='cancelled' WHERE status='pending' AND NOT (kind='judge_command_task' AND id IN (SELECT id FROM command_objects WHERE kind='schedule' AND status='pending' AND json_extract(data,'$.afterEnd')='keep'))",
  );
  logEvent(
    engine,
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
  engine.notice(
    `finish:${source}`,
    'group',
    '比赛结束',
    '本场比赛已结束。请停止正式行动及QQ群位置共享，查看官网战报。',
    game,
  );
}
/** 把当前排名和战报事实保存为不可变版本，后续更正另建新版本。 */
export function archiveReport(engine: Engine, correctionReason: string): void {
  const alive = new Set(survivors(engine));
  const eliminated = engine.db.all<{
    player_id: string;
    seq: number;
    utc_ms: number;
    group_id: string;
  }>(
    'SELECT player_id,seq,utc_ms,group_id FROM eliminations WHERE valid=1 ORDER BY utc_ms DESC,seq DESC',
  );
  const registered = engine.db.all<{id: string}>(
    "SELECT id FROM players WHERE id IN (SELECT player_id FROM roster_members) AND (entry_status='registered' OR id IN (SELECT player_id FROM eliminations WHERE valid=1)) ORDER BY id",
  );
  // Save ranking facts before retiring codes. Full DTO is rendered from the same immutable finish facts.
  const standings = registered
    .map(({id}) => {
      const kills = engine.db.one<{count: number}>(
        "SELECT COUNT(DISTINCT target) AS count FROM attacks WHERE actor=? AND classification='hit' AND valid=1",
        id,
      )!.count;
      const out = eliminated.find(p => p.player_id === id);
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
      p.alive === q.alive &&
      (p.alive ? p.kills === q.kills : !!p.group && p.group === q.group);
    const first = standings.findIndex(equal);
    return {
      ...p,
      rank: first + 1,
      tied: standings.filter(equal).length > 1,
      index: i,
    };
  });
  engine.db.exec(
    'INSERT INTO result_reports(version,reason,created_utc,report,correction_reason,snapshot_json) VALUES((SELECT COALESCE(MAX(version),0)+1 FROM result_reports),?,?,?,?,?)',
    engine.db.match().finish_reason,
    engine.now(),
    JSON.stringify({
      champions: ranked.filter(p => p.alive && p.rank === 1).map(p => p.id),
      standings: ranked,
    }),
    correctionReason,
    JSON.stringify(
      ranked.map(p => ({
        ...civilization(engine, p.id, engine.resolvedKeys!, true),
        kills: p.kills,
        rank: p.rank,
        tied: p.tied,
      })),
    ),
  );
}
/** 在完整结算后检查存活数量并决定提前完赛，批次中途不得调用截断。 */
export function autoFinish(
  engine: Engine,
  game: number,
  utc: number,
  source: string,
): void {
  if (engine.commandBatch) {
    return;
  }
  const match = engine.db.match();
  if (!match.start_settled || match.phase === 'ended') {
    return;
  }
  const count = survivors(engine).length;
  if (count <= 1) {
    finish(
      engine,
      count ? 'last_survivor' : 'all_eliminated',
      game,
      utc,
      source,
    );
  }
}
/** 生成授权赛事结果，按去重战绩与淘汰事实保留并列规则。 */
export function results(
  engine: Engine,
  keys: Awaited<ReturnType<Engine['keys']>>,
  version?: number,
): ResultsState | null {
  const row = engine.db.one<{
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
  if (!row) {
    return null;
  }
  const report = parseJson(row.report) as {
    champions: string[];
    standings: Array<{id: string; rank: number; tied: boolean; kills: number}>;
  };
  const standings = row.snapshot_json
    ? (parseJson(row.snapshot_json) as ResultsState['standings'])
    : report.standings.map(p => ({
        ...civilization(engine, p.id, keys, true),
        rank: p.rank,
        tied: p.tied,
        kills: p.kills,
      }));
  if (!row.snapshot_json) {
    engine.db.exec(
      'UPDATE result_reports SET snapshot_json=? WHERE version=?',
      JSON.stringify(standings),
      row.version,
    );
  }
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
/** 解密本人或获授权裁判可见的当前手环配置，原索引与密钥不进入响应。 */
export function currentCode(
  engine: Engine,
  player: string,
): CodeRow | undefined {
  const id = engine.db.flight(player).code_id;
  return id
    ? engine.db.one<CodeRow>('SELECT * FROM sighting_codes WHERE id=?', id)
    : undefined;
}
