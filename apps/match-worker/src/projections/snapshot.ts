import {accountPermissions} from '../storage/store';
import {parseJson} from '../../../../packages/contracts/src/backend';
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
  Notice,
  AuditEntry,
} from '@darkforest/contracts';
import {integer, requestId} from '../../../../packages/contracts/src/backend';
import {
  Fault,
  permission,
  requireThat,
  type Actor,
  type CodeRow,
  type Player,
  type Scheduled,
} from '../storage/store';
import type {Engine} from '../services/engine';
import {allowedActions} from '../services/player';
import {currentCode, results, survivors} from '../services/life';
import {accountList} from '../services/accounts';
import {
  judgeRecords,
  noticeProjection,
  type JudgeCollection,
} from './judge_records';
import {TIMES} from '../domain/rules';
import {readCommandHistory} from '../services/commands';
import {eventBody} from './event_copy';
import {
  qqCopy,
  gameTimeCopy,
} from '../../../../packages/contracts/src/message_copy';

type Keys = Awaited<ReturnType<Engine['keys']>>;
/** 生成赛事时钟和阶段的客户端投影；客户端不得以此代替写接口授权。 */
export function matchProjection(engine: Engine): MatchState {
  const matchState = engine.db.match();
  return {
    recoveryReview: matchState.recovery_state.startsWith('review:'),
    id: matchState.id,
    revision: matchState.revision,
    stage:
      matchState.phase === 'armed' || matchState.phase === 'start_countdown'
        ? 'countdown'
        : matchState.phase,
    phase: matchState.phase,
    gameMs: engine.game(),
    serverUtcMs: engine.now(),
    running: matchState.start_settled !== null && matchState.phase !== 'ended',
    paused: matchState.paused_at !== null,
    pauseReason:
      matchState.pause_reason === 'hunt_review'
        ? '终局资格确认中'
        : matchState.pause_reason,
    verification:
      matchState.pause_reason === 'hunt_review' &&
      matchState.hunt_finalized === null,
    total: engine.db.roster().length,
    survivors: survivors(engine).length,
    homeworldsAlive: engine.db.one<{count: number}>(
      "SELECT COUNT(*) AS count FROM homeworlds h JOIN players p ON p.id=h.player_id WHERE h.status='verified' AND h.destroyed_game IS NULL AND p.entry_status='registered' AND p.id IN (SELECT player_id FROM roster_members)",
    )!.count,
    releaseAt: matchState.release_at,
    startAt: matchState.started_at,
  };
}
/** 按淘汰事实、管理撤销和真实UTC等待计算当前只读观战资格。 */
export function observerAllowed(engine: Engine, playerState: Player): boolean {
  const out = engine.db.one<{utc_ms: number}>(
    'SELECT utc_ms FROM eliminations WHERE player_id=? AND valid=1',
    playerState.id,
  );
  return (
    !!engine.db.one<Record<string, SqlStorageValue>>(
      'SELECT player_id FROM roster_members WHERE player_id=?',
      playerState.id,
    ) &&
    engine.db.flight(playerState.id).status === 'eliminated' &&
    !playerState.observer_revoked &&
    !!out &&
    engine.now() >=
      out.utc_ms + engine.db.parameters().observerWaitSeconds * 1000
  );
}
/** 组合本人可见状态与可用动作，不向普通玩家泄露他人秘密。 */
export function playerProjection(
  engine: Engine,
  id: string,
  keys: Keys,
  own = false,
): PlayerState {
  const db = engine.db;
  const playerState = db.player(id);
  const currentFlight = db.flight(id);
  const homeworld = db.home(id);
  const out = db.one<{utc_ms: number; reason: string}>(
    'SELECT utc_ms,reason FROM eliminations WHERE player_id=? AND valid=1',
    id,
  );
  const control = db.one<{wrong: number; locked_until: number}>(
    'SELECT * FROM attack_controls WHERE player_id=?',
    id,
  )!;
  let flight = currentFlight.status as PlayerState['flight'];
  if (
    playerState.entry_status !== 'registered' ||
    (db.match().phase !== 'setup' &&
      !db.one<Record<string, SqlStorageValue>>(
        'SELECT player_id FROM roster_members WHERE player_id=?',
        id,
      ))
  ) {
    flight = 'absent';
  } else if (currentFlight.status === 'prelaunch') {
    flight = !playerState.nickname
      ? 'nickname'
      : !homeworld
        ? 'unregistered'
        : homeworld.status === 'pending'
          ? 'pending'
          : homeworld.status === 'rejected'
            ? 'rejected'
            : currentFlight.departed !== null
              ? 'departed'
              : 'verified';
  }
  const kills = db.one<{count: number}>(
    "SELECT COUNT(DISTINCT target) AS count FROM attacks WHERE actor=? AND classification='hit' AND valid=1",
    id,
  )!.count;
  const reasons: Record<string, string> = {
    sighting: '最后一命被击毁',
    wrong_attack_direct_out: '提交错误的手环颜色，被判定永久淘汰',
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
    nickname: playerState.nickname ?? '',
    flight,
    homeworld: homeworld?.code ?? null,
    homeAlive:
      !!homeworld &&
      homeworld.status === 'verified' &&
      homeworld.destroyed_game === null,
    homeVersion: homeworld?.version ?? 0,
    rejection: homeworld?.rejection ?? '',
    arms: engine.arms(currentCode(engine, id), keys),
    flightNumber: currentFlight.voyage,
    kills,
    wrongCount: control.wrong,
    broadcasts: 2 - playerState.broadcasts,
    photons: playerState.photons,
    attackLockedUntil: control.locked_until,
    respawnDeadline:
      currentFlight.deadline === null
        ? null
        : Math.min(currentFlight.deadline, TIMES.apocalypse),
    eliminatedAt: out?.utc_ms ?? null,
    eliminationReason: out ? (reasons[out.reason] ?? '裁判判定淘汰') : '',
    observerAllowed: observerAllowed(engine, playerState),
    actions: own ? allowedActions(engine, id) : [],
  };
}
/** 按当前查看身份与职责生成文明投影，秘密字段仅在授权范围内加入。 */
export function civilization(
  engine: Engine,
  id: string,
  keys: Keys,
  full: boolean,
): Civilization {
  const player = playerProjection(engine, id, keys);
  return {
    ...player,
    voyages: full
      ? engine.db
          .all<CodeRow>(
            'SELECT * FROM sighting_codes WHERE player_id=? AND activated_game IS NOT NULL ORDER BY voyage',
            id,
          )
          .map(c => ({
            number: c.voyage,
            arms: engine.arms(c, keys)!,
            startMs: c.activated_game!,
            endMs: c.retired_game,
          }))
      : [],
    rank: null,
    tied: false,
  };
}
/** 按当前角色与请求游标读取已发生的事件，保留公开及本人可见性边界。 */
export function events(
  engine: Engine,
  actor: Actor | null,
  full: boolean,
  before = Number.MAX_SAFE_INTEGER,
  limit = 500,
): GameEvent[] {
  if (!actor) {
    return [];
  }
  const rows = engine.db.all<{
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
  return rows.map(row => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: eventBody(
      row,
      row.owner ? engine.identity(row.owner) : '',
      actor.role === 'player' && row.owner === actor.id,
      row.sighting_actor ? engine.identity(row.sighting_actor) : undefined,
    ),
    audience: row.audience,
    ...(row.owner ? {recipient: row.owner} : {}),
    civilizationIds: parseJson(row.civilization_ids) as string[],
    gameMs: row.game_ms,
    utcMs: row.utc_ms,
    ...(row.code ? {code: row.code} : {}),
    ...(row.actor &&
    (full || row.actor === actor.id || row.kind === 'broadcast')
      ? {actor: row.actor}
      : {}),
  }));
}
/** 读取当前身份获准查看的秘密情报，不授予未来随机计划访问权。 */
export function intel(engine: Engine, actor: Actor): Intel[] {
  if (!engine.db.roster().includes(actor.id)) {
    return [];
  }
  return engine.db
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
    .map(row => ({
      id: row.id,
      civilization: row.target,
      nickname: row.nickname,
      code: row.code,
      gameMs: row.game_ms,
      source:
        row.source_kind === 'broadcast'
          ? '反向监听'
          : row.source_kind === 'sighting'
            ? '击毁飞船'
            : '历史情报（来源未记录）',
    }));
}
function judgeProjection(engine: Engine, actor: Actor): JudgeState {
  permission(actor, 'overview');
  const permits = accountPermissions(actor);
  const db = engine.db;
  const health = db.one<{
    last_success: number;
    next_wake: number | null;
    error: string;
  }>('SELECT * FROM scheduler_health WHERE id=1')!;
  return {
    ...(permits.includes('notices')
      ? {
          noticePendingCount: db.one<{count: number}>(
            "SELECT COUNT(*) AS count FROM notice_queue WHERE status!='sent'",
          )!.count,
          noticeTasks: db
            .all<Record<string, SqlStorageValue>>(
              "SELECT * FROM notice_queue WHERE status!='sent' ORDER BY priority DESC,ordering_seq ASC LIMIT 100",
            )
            .map(noticeProjection),
        }
      : {}),
    ...(permits.includes('system')
      ? {
          scheduledEvents: db
            .all<Scheduled>('SELECT * FROM scheduled_events ORDER BY due,id')
            .map(event => ({
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
                  return parseJson(event.payload) as Record<string, unknown>;
                } catch {
                  return {invalid: true};
                }
              })(),
            })),
        }
      : {}),
    notices: permits.includes('notices')
      ? (judgeRecords(engine, actor, 'notices').items as Notice[])
      : [],
    audits: permits.includes('audit')
      ? (judgeRecords(engine, actor, 'audits').items as AuditEntry[])
      : [],
    attacks: permits.includes('attacks')
      ? (judgeRecords(engine, actor, 'attacks').items as NonNullable<
          JudgeState['attacks']
        >)
      : [],
    cursors: Object.fromEntries(
      (['notices', 'audits', 'attacks'] as const)
        .filter(kind => permits.includes(kind === 'audits' ? 'audit' : kind))
        .map(kind => [kind, judgeRecords(engine, actor, kind).nextCursor]),
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
          .map(r => ({
            id: r.id,
            target: r.target,
            reason: r.reason,
            untilUtcMs: r.ends,
            operator: r.operator,
            active: !!r.active && r.ends > engine.now(),
          }))
      : [],
    issuedCodes: permits.includes('equipment')
      ? db.one<{count: number}>('SELECT COUNT(*) AS count FROM sighting_codes')!
          .count
      : 0,
    scheduler: permits.includes('system')
      ? {
          lastSuccessUtcMs: health.last_success,
          nextWakeUtcMs: health.next_wake,
          error: health.error,
          backlog: db
            .all<Scheduled>(
              "SELECT * FROM scheduled_events WHERE status='pending'",
            )
            .filter(r =>
              r.clock === 'utc'
                ? r.due <= engine.now()
                : r.due <= engine.game(),
            ).length,
        }
      : {lastSuccessUtcMs: 0, nextWakeUtcMs: null, error: '', backlog: 0},
  };
}
function requireFull(
  engine: Engine,
  actor: Actor | null,
  resultsScope = false,
): Actor {
  requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
  if (actor.role === 'judge') {
    return actor;
  }
  const player = engine.db.player(actor.id);
  requireThat(
    resultsScope
      ? engine.db.match().phase === 'ended' &&
          player.entry_status === 'registered' &&
          engine.db.one<Record<string, SqlStorageValue>>(
            'SELECT player_id FROM roster_members WHERE player_id=?',
            actor.id,
          )
      : observerAllowed(engine, player),
    'OBSERVER_UNAVAILABLE',
    '当前账号尚未开放此页面。',
    403,
  );
  return actor;
}
/** 组合当前会话的完整页面快照，服务端仍保留每个后续操作的最终授权。 */
export function projectSnapshot(
  engine: Engine,
  actor: Actor | null,
  session: Session | null,
  route: string,
  keys: Keys,
): Snapshot {
  const snapshot: Snapshot = {
    parameters: engine.db.parameters(),
    site: parseJson(engine.db.match().site_json) as SiteConfig,
    session,
    match: matchProjection(engine),
    player:
      actor?.role === 'player'
        ? playerProjection(engine, actor.id, keys, true)
        : null,
    events: [],
    intel: [],
    civilizations: [],
    judge: null,
    results: null,
  };
  if (!actor) {
    return snapshot;
  }
  if (route.startsWith('/judge')) {
    permission(actor, 'overview');
    const area = route.split('/')[2] ?? 'overview';
    if (!['more', 'account', ''].includes(area)) {
      permission(actor, area === 'commands' ? 'overview' : area);
    }
    snapshot.judge = judgeProjection(engine, actor);
    const permits = accountPermissions(actor);
    if (permits.includes('system')) {
      snapshot.judge.accounts = accountList(engine, actor);
    }
    if (permits.includes('results')) {
      snapshot.results = results(engine, keys);
    }
    if (snapshot.results && permits.includes('results')) {
      snapshot.results.versions = engine.db
        .all<{version: number; correction_reason: string; created_utc: number}>(
          'SELECT version,correction_reason,created_utc FROM result_reports ORDER BY version DESC',
        )
        .map(r => ({
          version: r.version,
          reason: r.correction_reason,
          createdUtc: r.created_utc,
        }));
    }
    if (permits.includes('clock')) {
      snapshot.judge.roster = {
        members: engine.db
          .all<{player_id: string}>(
            'SELECT player_id FROM roster_members ORDER BY player_id',
          )
          .map(r => r.player_id),
        accounts: engine.db
          .all<Player>('SELECT * FROM players ORDER BY id')
          .map(p => ({
            id: p.id,
            nickname: p.nickname ?? '',
            eligible: p.entry_status === 'registered',
          })),
        locked: engine.db.match().phase !== 'setup',
      };
    }
    if (permits.includes('settings')) {
      snapshot.judge.parameters = {
        values: engine.db.parameters(),
        locked: engine.db.match().phase !== 'setup',
        version: engine.db.one<{version: number}>(
          "SELECT version FROM settings WHERE key='parameters'",
        )!.version,
      };
    }
    snapshot.civilizations = engine.db
      .all<{id: string}>(
        'SELECT id FROM players WHERE id IN (SELECT player_id FROM roster_members) ORDER BY id',
      )
      .map(({id}) => {
        const selectedCivilization = civilization(
          engine,
          id,
          keys,
          permits.includes('equipment'),
        );
        // Communications judges can review homeworlds; equipment and audits need head permission.
        if (!permits.includes('homeworlds')) {
          selectedCivilization.homeworld = null;
          selectedCivilization.homeVersion = 0;
          selectedCivilization.rejection = '';
        }
        if (!permits.includes('equipment')) {
          selectedCivilization.arms = null;
          selectedCivilization.voyages = [];
        }
        return selectedCivilization;
      });
    snapshot.events = events(engine, actor, true);
  } else if (
    route.startsWith('/display') ||
    route.startsWith('/observer') ||
    route.startsWith('/results')
  ) {
    if (route.startsWith('/display')) {
      requireThat(
        actor.role === 'judge',
        'FORBIDDEN',
        '请使用裁判账号打开大屏。',
        403,
      );
    }
    requireFull(engine, actor, route.startsWith('/results'));
    snapshot.civilizations = engine.db
      .all<{id: string}>(
        "SELECT id FROM players WHERE entry_status='registered' AND id IN (SELECT player_id FROM roster_members) ORDER BY id",
      )
      .map(({id}) => civilization(engine, id, keys, true));
    snapshot.events = events(engine, actor, true);
    snapshot.results = results(engine, keys);
  } else {
    snapshot.events = events(engine, actor, false);
    if (actor.role === 'player') {
      snapshot.intel = intel(engine, actor);
    }
  }
  snapshot.eventCursor = eventCursor(engine, snapshot.events, 500);
  return snapshot;
}
function eventCursor(
  engine: Engine,
  items: GameEvent[],
  limit: number,
): string | null {
  const last = items.at(-1);
  return items.length === limit && last
    ? String(
        engine.db.one<{seq: number}>(
          'SELECT seq FROM event_log WHERE id=?',
          last.id,
        )!.seq,
      )
    : null;
}
/** 按本人状态生成QQ通知材料；生成文案不等于现场发送或完成裁决。 */
export function template(
  engine: Engine,
  actor: Actor,
  kind: string,
): {text: string} {
  requireThat(actor.role === 'player', 'FORBIDDEN', '请使用参赛账号。', 403);
  const home = engine.db.home(actor.id);
  const identity = engine.identity(actor.id);
  if (kind === 'homeworld') {
    requireThat(home, 'NO_HOMEWORLD', '请先提交母星登记。');
    return {
      text: qqCopy(
        '母星登记',
        `文明${identity}请求在${home.code}登记母星（提交版本：${home.version}），以下是我的母星现场时间水印照片：`,
      ),
    };
  }
  if (kind === 'respawn') {
    requireThat(
      ['returning', 'preparing', 'issued'].includes(
        engine.db.flight(actor.id).status,
      ),
      'NO_RESPAWN',
      '当前无需提交重生照片。',
    );
    return {
      text: qqCopy(
        '重生',
        `文明${identity}已返回母星，请求重生，以下是我的母星现场时间水印照片：`,
      ),
    };
  }
  if (kind === 'exception') {
    return {
      text: qqCopy(
        '异常申报',
        `文明${identity}请求裁判协助。\n比赛时间：${gameTimeCopy(engine.game())}。\n现场情况：`,
      ),
    };
  }
  throw new Fault(404, 'NOT_FOUND', '消息模板不存在。');
}
/** 处理本场只读API并调用相应角色投影，未知路径不作为任意数据库查询。 */
export function readEndpoint(
  engine: Engine,
  actor: Actor | null,
  path: string,
  keys: Keys,
): unknown {
  const url = new URL(path, 'https://internal');
  const route = url.pathname;
  const collection = /^\/judge\/records\/(notices|audits|attacks)$/.exec(route);
  if (collection) {
    requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
    return judgeRecords(
      engine,
      actor,
      collection[1] as JudgeCollection,
      integer(
        Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER),
        1,
      ),
      integer(Number(url.searchParams.get('limit') ?? 100), 1, 200),
    );
  }
  if (route === '/public/site-config') {
    return parseJson(engine.db.match().site_json);
  }
  if (route === '/public/match') {
    return matchProjection(engine);
  }
  requireThat(actor, 'UNAUTHENTICATED', '请重新登录。', 401);
  if (route === '/judge/accounts') {
    return accountList(engine, actor);
  }
  if (route === '/judge/command/history') {
    return readCommandHistory(
      engine,
      actor,
      Object.fromEntries(url.searchParams),
    );
  }
  if (route === '/judge/events' || route.startsWith('/judge/events/')) {
    permission(actor, 'system');
    const events = judgeProjection(engine, actor).scheduledEvents ?? [];
    if (route === '/judge/events') {
      return events;
    }
    const event = events.find(
      event =>
        event.id === decodeURIComponent(route.slice('/judge/events/'.length)),
    );
    requireThat(event, 'EVENT_NOT_FOUND', '赛事事件不存在。', 404);
    return event;
  }
  if (route === '/results/report') {
    requireFull(engine, actor, true);
    const report = results(
      engine,
      keys,
      integer(Number(url.searchParams.get('version')), 1),
    );
    requireThat(report, 'NOT_FOUND', '战报版本不存在。', 404);
    return report;
  }
  if (route === '/timeline') {
    const scope = url.searchParams.get('route') ?? '/player';
    // Cursor selects a position only. Authorization and SQL audience filters apply on every page.
    projectSnapshot(engine, actor, null, scope, keys);
    const full = ['/judge', '/display', '/observer', '/results'].some(prefix =>
      scope.startsWith(prefix),
    );
    const before = integer(Number(url.searchParams.get('before')), 1);
    const limit = integer(Number(url.searchParams.get('limit') ?? 100), 1, 200);
    const items = events(engine, actor, full, before, limit);
    return {items, nextCursor: eventCursor(engine, items, limit)};
  }
  const operation = /^\/operations\/([A-Za-z0-9_-]+)$/.exec(route);
  if (operation) {
    return engine.result(actor, requestId(operation[1]));
  }
  if (route === '/player/self') {
    requireThat(actor.role === 'player', 'FORBIDDEN', '请使用参赛账号。', 403);
    return playerProjection(engine, actor.id, keys, true);
  }
  if (route === '/player/messages') {
    return events(engine, actor, false);
  }
  if (route === '/player/intel') {
    return intel(engine, actor);
  }
  if (route.startsWith('/player/templates/')) {
    return template(engine, actor, route.split('/').pop()!);
  }
  if (route === '/judge/overview') {
    const s = projectSnapshot(engine, actor, null, '/judge', keys);
    return {judge: s.judge, civilizations: s.civilizations, events: s.events};
  }
  if (route === '/judge/parameters') {
    permission(actor, 'settings');
    return {
      version: engine.db.one<{version: number}>(
        "SELECT version FROM settings WHERE key='parameters'",
      )!.version,
      locked: engine.db.match().phase !== 'setup',
      values: engine.db.parameters(),
    };
  }
  if (route === '/judge/display') {
    const s = projectSnapshot(engine, actor, null, '/display', keys);
    return {
      civilizations: s.civilizations,
      events: s.events,
      results: s.results,
    };
  }
  if (route === '/judge/scheduler/health') {
    permission(actor, 'system');
    return judgeProjection(engine, actor).scheduler;
  }
  if (route.startsWith('/observer/') || route.startsWith('/results/')) {
    requireFull(engine, actor, route.startsWith('/results/'));
    if (route.endsWith('/events')) {
      return events(engine, actor, true);
    }
    if (route.endsWith('/civilizations')) {
      return engine.db
        .all<{id: string}>(
          "SELECT id FROM players WHERE entry_status='registered' AND id IN (SELECT player_id FROM roster_members)",
        )
        .map(({id}) => civilization(engine, id, keys, true));
    }
    if (route === '/results/overview') {
      return results(engine, keys);
    }
    if (route === '/observer/overview') {
      return matchProjection(engine);
    }
  }
  throw new Fault(404, 'NOT_FOUND', '未找到这个页面。');
}
