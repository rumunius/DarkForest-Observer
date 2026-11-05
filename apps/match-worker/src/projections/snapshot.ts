import type {
  Civilization,
  GameEvent,
  Intel,
  JudgeState,
  MatchState,
  PlayerState,
  Session,
  Snapshot,
  SiteConfig,
} from '@darkforest/contracts';
import { integer, requestId } from '../../../../packages/contracts/src/backend';
import {
  Fault,
  permission,
  requireThat,
  type Actor,
  type CodeRow,
  type Player,
} from '../storage/store';
import type { Engine } from '../services/engine';
import { allowedActions } from '../services/player';
import { currentCode, results, survivors } from '../services/life';
import { accountList } from '../services/accounts';
import { judgeRecords, noticeProjection } from './judge-records';
import { TIMES } from '../domain/rules';
import { readCommandHistory } from '../services/commands';
import { eventBody } from './event-copy';
type Keys = Awaited<ReturnType<Engine['keys']>>;
export function matchProjection(e: Engine): MatchState {
  const m = e.db.match();
  return {
    recoveryReview: m.recovery_state.startsWith('review:'),
    id: m.id,
    revision: m.revision,
    stage: m.phase === 'armed' || m.phase === 'start_countdown' ? 'countdown' : m.phase,
    phase: m.phase,
    gameMs: e.game(),
    serverUtcMs: e.now(),
    running: m.start_settled !== null && m.phase !== 'ended',
    paused: m.paused_at !== null,
    pauseReason: m.pause_reason === 'hunt_review' ? '终局资格确认中' : m.pause_reason,
    verification: m.pause_reason === 'hunt_review' && m.hunt_finalized === null,
    total: e.db.roster().length,
    survivors: survivors(e).length,
    homeworldsAlive: e.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM homeworlds h JOIN players p ON p.id=h.player_id WHERE h.status='verified' AND h.destroyed_game IS NULL AND p.entry_status='registered' AND p.id IN (SELECT player_id FROM roster_members)",
    )!.count,
    releaseAt: m.release_at,
    startAt: m.started_at,
  };
}
export function observerAllowed(e: Engine, p: Player): boolean {
  const out = e.db.one<{ utc_ms: number }>(
    'SELECT utc_ms FROM eliminations WHERE player_id=? AND valid=1',
    p.id,
  );
  return (
    !!e.db.one('SELECT player_id FROM roster_members WHERE player_id=?', p.id) &&
    e.db.flight(p.id).status === 'eliminated' &&
    !p.observer_revoked &&
    !!out &&
    e.now() >= out.utc_ms + e.db.parameters().observerWaitSeconds * 1000
  );
}
export function playerProjection(e: Engine, id: string, keys: Keys, own = false): PlayerState {
  const db = e.db,
    p = db.player(id),
    f = db.flight(id),
    h = db.home(id);
  const out = db.one<{ utc_ms: number; reason: string }>(
    'SELECT utc_ms,reason FROM eliminations WHERE player_id=? AND valid=1',
    id,
  );
  const control = db.one<{ wrong: number; locked_until: number }>(
    'SELECT * FROM attack_controls WHERE player_id=?',
    id,
  )!;
  let flight = f.status as PlayerState['flight'];
  if (
    p.entry_status !== 'registered' ||
    (db.match().phase !== 'setup' &&
      !db.one('SELECT player_id FROM roster_members WHERE player_id=?', id))
  )
    flight = 'absent';
  else if (f.status === 'prelaunch')
    flight = !p.nickname
      ? 'nickname'
      : !h
        ? 'unregistered'
        : h.status === 'pending'
          ? 'pending'
          : h.status === 'rejected'
            ? 'rejected'
            : f.departed !== null
              ? 'departed'
              : 'verified';
  const kills = db.one<{ count: number }>(
    "SELECT COUNT(DISTINCT target) AS count FROM attacks WHERE actor=? AND classification='hit' AND valid=1",
    id,
  )!.count;
  const reasons: Record<string, string> = {
    sighting: '最后一命被击毁',
    wrong_attack_direct_out: '提交错误的目击码后被判定出局',
    respawn_timeout: '未在期限内完成重生',
    homeworld_destroyed: '母星毁灭时尚未出航',
    apocalypse: '宇宙末日时尚未出航',
    withdrawn: '退出比赛',
    no_share_at_cutoff: '未按时加入位置共享',
    outside_at_cutoff: '截止时仍在圈外',
    left_zone: '离开终局圈',
    sharing_stopped: '停止位置共享',
    location_violation: '定位违规',
  };
  return {
    id,
    nickname: p.nickname ?? '',
    flight,
    homeworld: h?.code ?? null,
    homeAlive: !!h && h.status === 'verified' && h.destroyed_game === null,
    homeVersion: h?.version ?? 0,
    rejection: h?.rejection ?? '',
    arms: e.arms(currentCode(e, id), keys),
    flightNumber: f.voyage,
    kills,
    wrongCount: control.wrong,
    broadcasts: 2 - p.broadcasts,
    photons: p.photons,
    attackLockedUntil: control.locked_until,
    respawnDeadline: f.deadline === null ? null : Math.min(f.deadline, TIMES.apocalypse),
    eliminatedAt: out?.utc_ms ?? null,
    eliminationReason: out ? (reasons[out.reason] ?? '裁判判定淘汰') : '',
    observerAllowed: observerAllowed(e, p),
    actions: own ? allowedActions(e, id) : [],
  };
}
export function civilization(e: Engine, id: string, keys: Keys, full: boolean): Civilization {
  const player = playerProjection(e, id, keys);
  return {
    ...player,
    voyages: full
      ? e.db
          .all<CodeRow>(
            'SELECT * FROM sighting_codes WHERE player_id=? AND activated_game IS NOT NULL ORDER BY voyage',
            id,
          )
          .map((c) => ({
            number: c.voyage,
            arms: e.arms(c, keys)!,
            startMs: c.activated_game!,
            endMs: c.retired_game,
          }))
      : [],
    rank: null,
    tied: false,
  };
}
export function events(
  e: Engine,
  actor: Actor | null,
  full: boolean,
  before = Number.MAX_SAFE_INTEGER,
  limit = 500,
): GameEvent[] {
  if (!actor) return [];
  const rows = e.db.all<{
    seq: number;
    id: string;
    kind: GameEvent['kind'];
    title: string;
    body: string;
    audience: GameEvent['audience'];
    owner: string | null;
    civilization_ids: string;
    code: string | null;
    actor: string | null;
    game_ms: number;
    utc_ms: number;
    sighting_actor: string | null;
  }>(
    full
      ? "SELECT l.*,a.actor AS sighting_actor FROM event_log l LEFT JOIN attacks a ON a.id=(CASE WHEN substr(l.id,-7)=':target' THEN substr(l.id,1,length(l.id)-7) ELSE l.id END)||':attack' WHERE l.seq<? ORDER BY l.seq DESC LIMIT ?"
      : "SELECT l.*,NULL AS sighting_actor FROM event_log l WHERE l.seq<? AND (l.audience='public' OR l.owner=?) ORDER BY l.seq DESC LIMIT ?",
    ...(full ? [before, limit] : [before, actor.id, limit]),
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: eventBody(
      r,
      r.owner ? e.identity(r.owner) : '',
      actor.role === 'player' && r.owner === actor.id,
      r.sighting_actor ? e.identity(r.sighting_actor) : undefined,
    ),
    audience: r.audience,
    ...(r.owner ? { recipient: r.owner } : {}),
    civilizationIds: JSON.parse(r.civilization_ids) as string[],
    gameMs: r.game_ms,
    utcMs: r.utc_ms,
    ...(r.code ? { code: r.code } : {}),
    ...(r.actor && (full || r.actor === actor.id || r.kind === 'broadcast')
      ? { actor: r.actor }
      : {}),
  }));
}
export function intel(e: Engine, actor: Actor): Intel[] {
  if (!e.db.roster().includes(actor.id)) return [];
  return e.db
    .all<{
      id: string;
      target: string;
      nickname: string;
      code: string;
      game_ms: number;
      source_kind: string | null;
    }>(
      "SELECT i.id,i.target,p.nickname,i.code,i.game_ms,COALESCE(l.kind,CASE WHEN a.id IS NOT NULL THEN 'sighting' END) AS source_kind FROM intel_grants i JOIN players p ON p.id=i.target LEFT JOIN event_log l ON l.id=i.source LEFT JOIN attacks a ON a.id=i.source||':attack' WHERE i.owner=? ORDER BY i.game_ms DESC",
      actor.id,
    )
    .map((r) => ({
      id: r.id,
      civilization: r.target,
      nickname: r.nickname,
      code: r.code,
      gameMs: r.game_ms,
      source:
        r.source_kind === 'broadcast'
          ? '反向监听'
          : r.source_kind === 'sighting'
            ? '击毁飞船'
            : '历史情报（来源未记录）',
    }));
}
function judgeProjection(e: Engine, actor: Actor): JudgeState {
  permission(actor, 'overview');
  const permits = JSON.parse(actor.permissions) as string[];
  const db = e.db;
  const health = db.one<{ last_success: number; next_wake: number | null; error: string }>(
    'SELECT * FROM scheduler_health WHERE id=1',
  )!;
  return {
    ...(permits.includes('notices')
      ? {
          noticePendingCount: db.one<{ count: number }>(
            "SELECT COUNT(*) AS count FROM notice_queue WHERE status!='sent'",
          )!.count,
          noticeTasks: db
            .all(
              "SELECT * FROM notice_queue WHERE status!='sent' ORDER BY priority DESC,ordering_seq ASC LIMIT 100",
            )
            .map(noticeProjection),
        }
      : {}),
    ...(permits.includes('system')
      ? {
          scheduledEvents: db
            .all<import('../storage/store').Scheduled>(
              'SELECT * FROM scheduled_events ORDER BY due,id',
            )
            .map((event) => ({
              id: event.id,
              kind: event.kind,
              clock: event.clock,
              due: event.due,
              status: event.status,
              attempts: event.attempt_count,
              lastAttemptUtcMs: event.last_attempt_utc,
              lastError: event.last_error,
              lastErrorUtcMs: event.last_error_utc,
              committedUtcMs: event.committed_utc,
              payload: (() => {
                try {
                  return JSON.parse(event.payload) as Record<string, unknown>;
                } catch {
                  return { invalid: true };
                }
              })(),
            })),
        }
      : {}),
    notices: permits.includes('notices')
      ? (judgeRecords(e, actor, 'notices').items as import('@darkforest/contracts').Notice[])
      : [],
    audits: permits.includes('audit')
      ? (judgeRecords(e, actor, 'audits').items as import('@darkforest/contracts').AuditEntry[])
      : [],
    attacks: permits.includes('attacks')
      ? (judgeRecords(e, actor, 'attacks').items as NonNullable<JudgeState['attacks']>)
      : [],
    cursors: Object.fromEntries(
      (['notices', 'audits', 'attacks'] as const)
        .filter((kind) => permits.includes(kind === 'audits' ? 'audit' : kind))
        .map((kind) => [kind, judgeRecords(e, actor, kind).nextCursor]),
    ),
    effects: permits.includes('effects')
      ? db
          .all<{
            id: string;
            target: string;
            reason: string;
            ends: number;
            operator: string;
            active: number;
          }>('SELECT * FROM admin_effects ORDER BY starts DESC LIMIT 200')
          .map((r) => ({
            id: r.id,
            target: r.target,
            reason: r.reason,
            untilUtcMs: r.ends,
            operator: r.operator,
            active: !!r.active && r.ends > e.now(),
          }))
      : [],
    issuedCodes: permits.includes('equipment')
      ? db.one<{ count: number }>('SELECT COUNT(*) AS count FROM sighting_codes')!.count
      : 0,
    scheduler: permits.includes('system')
      ? {
          lastSuccessUtcMs: health.last_success,
          nextWakeUtcMs: health.next_wake,
          error: health.error,
          backlog: db
            .all<import('../storage/store').Scheduled>(
              "SELECT * FROM scheduled_events WHERE status='pending'",
            )
            .filter((r) => (r.clock === 'utc' ? r.due <= e.now() : r.due <= e.game())).length,
        }
      : { lastSuccessUtcMs: 0, nextWakeUtcMs: null, error: '', backlog: 0 },
  };
}
function requireFull(e: Engine, actor: Actor | null, resultsScope = false): Actor {
  requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
  if (actor.role === 'judge') return actor;
  const player = e.db.player(actor.id);
  requireThat(
    resultsScope
      ? e.db.match().phase === 'ended' &&
          player.entry_status === 'registered' &&
          e.db.one('SELECT player_id FROM roster_members WHERE player_id=?', actor.id)
      : observerAllowed(e, player),
    'OBSERVER_UNAVAILABLE',
    '当前账号尚未开放此页面。',
    403,
  );
  return actor;
}
export function projectSnapshot(
  e: Engine,
  actor: Actor | null,
  session: Session | null,
  route: string,
  keys: Keys,
): Snapshot {
  const snapshot: Snapshot = {
    parameters: e.db.parameters(),
    site: JSON.parse(e.db.match().site_json) as SiteConfig,
    session,
    match: matchProjection(e),
    player: actor?.role === 'player' ? playerProjection(e, actor.id, keys, true) : null,
    events: [],
    intel: [],
    civilizations: [],
    judge: null,
    results: null,
  };
  if (!actor) return snapshot;
  if (route.startsWith('/judge')) {
    permission(actor, 'overview');
    const area = route.split('/')[2] ?? 'overview';
    if (!['more', 'account', ''].includes(area))
      permission(actor, area === 'commands' ? 'overview' : area);
    snapshot.judge = judgeProjection(e, actor);
    const permits = JSON.parse(actor.permissions) as string[];
    if (permits.includes('system')) snapshot.judge.accounts = accountList(e, actor);
    if (permits.includes('results')) snapshot.results = results(e, keys);
    if (snapshot.results && permits.includes('results'))
      snapshot.results.versions = e.db
        .all<{ version: number; correction_reason: string; created_utc: number }>(
          'SELECT version,correction_reason,created_utc FROM result_reports ORDER BY version DESC',
        )
        .map((r) => ({
          version: r.version,
          reason: r.correction_reason,
          createdUtc: r.created_utc,
        }));
    if (permits.includes('clock'))
      snapshot.judge.roster = {
        members: e.db
          .all<{ player_id: string }>('SELECT player_id FROM roster_members ORDER BY player_id')
          .map((r) => r.player_id),
        accounts: e.db.all<Player>('SELECT * FROM players ORDER BY id').map((p) => ({
          id: p.id,
          nickname: p.nickname ?? '',
          eligible: p.entry_status === 'registered',
        })),
        locked: e.db.match().phase !== 'setup',
      };
    if (permits.includes('settings'))
      snapshot.judge.parameters = {
        values: e.db.parameters(),
        locked: e.db.match().phase !== 'setup',
        version: e.db.one<{ version: number }>(
          "SELECT version FROM settings WHERE key='parameters'",
        )!.version,
      };
    snapshot.civilizations = e.db
      .all<{ id: string }>(
        'SELECT id FROM players WHERE id IN (SELECT player_id FROM roster_members) ORDER BY id',
      )
      .map(({ id }) => {
        const c = civilization(e, id, keys, permits.includes('equipment'));
        // Communications judges can review homeworlds; equipment and audits need head permission.
        if (!permits.includes('homeworlds')) {
          c.homeworld = null;
          c.homeVersion = 0;
          c.rejection = '';
        }
        if (!permits.includes('equipment')) {
          c.arms = null;
          c.voyages = [];
        }
        return c;
      });
    snapshot.events = events(e, actor, true);
  } else if (
    route.startsWith('/display') ||
    route.startsWith('/observer') ||
    route.startsWith('/results')
  ) {
    if (route.startsWith('/display'))
      requireThat(actor.role === 'judge', 'FORBIDDEN', '请使用裁判账号打开大屏。', 403);
    requireFull(e, actor, route.startsWith('/results'));
    snapshot.civilizations = e.db
      .all<{ id: string }>(
        "SELECT id FROM players WHERE entry_status='registered' AND id IN (SELECT player_id FROM roster_members) ORDER BY id",
      )
      .map(({ id }) => civilization(e, id, keys, true));
    snapshot.events = events(e, actor, true);
    snapshot.results = results(e, keys);
  } else {
    snapshot.events = events(e, actor, false);
    if (actor.role === 'player') snapshot.intel = intel(e, actor);
  }
  snapshot.eventCursor = eventCursor(e, snapshot.events, 500);
  return snapshot;
}
function eventCursor(e: Engine, items: GameEvent[], limit: number): string | null {
  const last = items.at(-1);
  return items.length === limit && last
    ? String(e.db.one<{ seq: number }>('SELECT seq FROM event_log WHERE id=?', last.id)!.seq)
    : null;
}
export function template(e: Engine, actor: Actor, kind: string): { text: string } {
  requireThat(actor.role === 'player', 'FORBIDDEN', '请使用参赛账号。', 403);
  const home = e.db.home(actor.id),
    identity = e.identity(actor.id);
  if (kind === 'homeworld') {
    requireThat(home, 'NO_HOMEWORLD', '请先提交母星登记。');
    return {
      text: `${identity}\n母星坐标：${home.code}\n提交版本：${home.version}\n请核对本次提交的时间水印照片。`,
    };
  }
  if (kind === 'respawn') {
    requireThat(
      ['returning', 'preparing', 'issued'].includes(e.db.flight(actor.id).status),
      'NO_RESPAWN',
      '当前无需提交重生照片。',
    );
    return { text: `${identity}\n我已返回母星，附上本次返航的时间水印照片。` };
  }
  if (kind === 'exception') return { text: `${identity}\n我需要裁判协助，请核对官网当前状态。` };
  throw new Fault(404, 'NOT_FOUND', '消息模板不存在。');
}
export function readEndpoint(e: Engine, actor: Actor | null, path: string, keys: Keys): unknown {
  const url = new URL(path, 'https://internal');
  const route = url.pathname;
  const collection = /^\/judge\/records\/(notices|audits|attacks)$/.exec(route);
  if (collection) {
    requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
    return judgeRecords(
      e,
      actor,
      collection[1] as import('./judge-records').JudgeCollection,
      integer(Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER), 1),
      integer(Number(url.searchParams.get('limit') ?? 100), 1, 200),
    );
  }
  if (route === '/public/site-config') return JSON.parse(e.db.match().site_json);
  if (route === '/public/match') return matchProjection(e);
  requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
  if (route === '/judge/accounts') return accountList(e, actor);
  if (route === '/judge/command/history')
    return readCommandHistory(e, actor, Object.fromEntries(url.searchParams));
  if (route === '/judge/events' || route.startsWith('/judge/events/')) {
    permission(actor, 'system');
    const events = judgeProjection(e, actor).scheduledEvents ?? [];
    if (route === '/judge/events') return events;
    const event = events.find(
      (event) => event.id === decodeURIComponent(route.slice('/judge/events/'.length)),
    );
    requireThat(event, 'EVENT_NOT_FOUND', '赛事事件不存在。', 404);
    return event;
  }
  if (route === '/results/report') {
    requireFull(e, actor, true);
    const report = results(e, keys, integer(Number(url.searchParams.get('version')), 1));
    requireThat(report, 'NOT_FOUND', '战报版本不存在。', 404);
    return report;
  }
  if (route === '/timeline') {
    const scope = url.searchParams.get('route') ?? '/player';
    // Cursor selects a position only. Authorization and SQL audience filters apply on every page.
    projectSnapshot(e, actor, null, scope, keys);
    const full = ['/judge', '/display', '/observer', '/results'].some((prefix) =>
      scope.startsWith(prefix),
    );
    const before = integer(Number(url.searchParams.get('before')), 1);
    const limit = integer(Number(url.searchParams.get('limit') ?? 100), 1, 200);
    const items = events(e, actor, full, before, limit);
    return { items, nextCursor: eventCursor(e, items, limit) };
  }
  const operation = /^\/operations\/([A-Za-z0-9_-]+)$/.exec(route);
  if (operation) return e.result(actor, requestId(operation[1]));
  if (route === '/player/self') {
    requireThat(actor.role === 'player', 'FORBIDDEN', '请使用参赛账号。', 403);
    return playerProjection(e, actor.id, keys, true);
  }
  if (route === '/player/messages') return events(e, actor, false);
  if (route === '/player/intel') return intel(e, actor);
  if (route.startsWith('/player/templates/')) return template(e, actor, route.split('/').pop()!);
  if (route === '/judge/overview') {
    const s = projectSnapshot(e, actor, null, '/judge', keys);
    return { judge: s.judge, civilizations: s.civilizations, events: s.events };
  }
  if (route === '/judge/parameters') {
    permission(actor, 'settings');
    return {
      version: e.db.one<{ version: number }>("SELECT version FROM settings WHERE key='parameters'")!
        .version,
      locked: e.db.match().phase !== 'setup',
      values: e.db.parameters(),
    };
  }
  if (route === '/judge/display') {
    const s = projectSnapshot(e, actor, null, '/display', keys);
    return { civilizations: s.civilizations, events: s.events, results: s.results };
  }
  if (route === '/judge/scheduler/health') {
    permission(actor, 'system');
    return judgeProjection(e, actor).scheduler;
  }
  if (route.startsWith('/observer/') || route.startsWith('/results/')) {
    requireFull(e, actor, route.startsWith('/results/'));
    if (route.endsWith('/events')) return events(e, actor, true);
    if (route.endsWith('/civilizations'))
      return e.db
        .all<{ id: string }>(
          "SELECT id FROM players WHERE entry_status='registered' AND id IN (SELECT player_id FROM roster_members)",
        )
        .map(({ id }) => civilization(e, id, keys, true));
    if (route === '/results/overview') return results(e, keys);
    if (route === '/observer/overview') return matchProjection(e);
  }
  throw new Fault(404, 'NOT_FOUND', '接口不存在。');
}
