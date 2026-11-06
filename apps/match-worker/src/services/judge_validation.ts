import {
  coordinate,
  integer,
  nickname,
  stableJson,
  strict,
  stringArray,
  text,
} from '../../../../packages/contracts/src/backend';
import {TIMES} from '../domain/rules';
import {dueUtc} from '../scheduler/events';
import type {Scheduled} from '../storage/store';
import {
  permission,
  requireThat,
  type Actor,
  type Parameters,
} from '../storage/store';
import {validateAccount} from './accounts';
import {correctionTarget} from './attack_correction';
import {type Engine} from './engine';
import {survivors} from './life';
import {restoration} from './player_correction';
import {validateReportCorrection} from './report_correction';

const fields: Record<string, string[]> = {
  '/judge/recovery-finalize': [],
  '/judge/report-correction': ['target', 'field', 'value', 'expected_version'],
  '/judge/accounts': ['target', 'operation', 'expected_version', 'duty'],
  '/judge/arm-code-release': ['time', 'expected_roster'],
  '/judge/arm-start': ['time', 'expected_roster'],
  '/judge/pause': [],
  '/judge/resume': [],
  '/judge/hunt-finalize': ['eliminations'],
  '/judge/hunt-eliminate': ['target', 'reason_code'],
  '/judge/player-eliminate': ['target'],
  '/judge/player-restore': ['target'],
  '/judge/effects': ['target', 'seconds', 'revoke'],
  '/judge/parameters': ['values', 'expected_version'],
  '/judge/scheduler/rearm': [],
  '/judge/events/settle-due': [],
  '/judge/correction': ['target', 'field', 'value'],
  '/judge/equipment-correction': ['target', 'mode'],
  '/judge/observer-access': ['target', 'allowed'],
  '/judge/roster': ['members'],
  '/judge/announce': ['target', 'message'],
  '/judge/attack-correction': ['attack_id'],
  '/judge/event-control': ['event_id', 'operation'],
  '/judge/event-trigger': ['kind', 'code'],
  '/judge/schedule-announcement': ['seconds', 'message'],
  '/judge/reveal': ['statistic'],
  '/judge/replay': ['count'],
};

const capabilities: Record<string, string> = {
  '/judge/arm-code-release': 'clock',
  '/judge/arm-start': 'clock',
  '/judge/pause': 'clock',
  '/judge/resume': 'clock',
  '/judge/hunt-finalize': 'endgame',
  '/judge/hunt-eliminate': 'endgame',
  '/judge/player-eliminate': 'commands',
  '/judge/player-restore': 'commands',
  '/judge/event-control': 'system',
  '/judge/event-trigger': 'system',
  '/judge/effects': 'effects',
  '/judge/parameters': 'settings',
  '/judge/scheduler/rearm': 'system',
  '/judge/events/settle-due': 'system',
  '/judge/correction': 'commands',
  '/judge/equipment-correction': 'equipment',
  '/judge/observer-access': 'commands',
};

const metadata = ['request_id', 'reason', 'preview_token', 'expected_revision'];

/** 提取可审计的业务参数，剥离请求身份、确认令牌与版本元数据。 */
export function payloadOf(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([k]) =>
        ![
          'request_id',
          'preview_token',
          'expected_revision',
          'change',
          'path',
        ].includes(k),
    ),
  );
}

/** 只接收固定管理路径及受限文明退出路径，禁止任意动态动作。 */
export function recognized(path: string): boolean {
  return !!fields[path] || /^\/judge\/roster\/C\d{2,3}\/withdraw$/.test(path);
}

/** 按管理路径映射本场裁判职责，平台任职不能隐式放行。 */
export function authorize(actor: Actor, path: string): void {
  permission(
    actor,
    ['/judge/accounts', '/judge/recovery-finalize'].includes(path)
      ? 'system'
      : path === '/judge/roster'
        ? 'clock'
        : (capabilities[path] ?? 'commands'),
  );
}

/** 按具体管理动作的字段白名单拒绝多余参数。 */
export function checkSchema(path: string, body: Record<string, unknown>): void {
  strict(body, [
    ...metadata,
    ...(fields[path] ?? ['target', 'field', 'value']),
  ]);
}

/** 在最新权威状态中复核管理动作资格，预览与提交复用同一校验。 */
export function validate(
  engine: Engine,
  path: string,
  body: Record<string, unknown>,
  actor: Actor,
): void {
  const db = engine.db;
  const m = db.match();
  requireThat(
    !m.recovery_state ||
      ![
        '/judge/resume',
        '/judge/hunt-finalize',
        '/judge/arm-code-release',
        '/judge/arm-start',
        '/judge/event-trigger',
        '/judge/events/settle-due',
      ].includes(path),
    'RECOVERY_REVIEW',
    '请先完成比赛恢复核对。',
  );
  if (path === '/judge/recovery-finalize') {
    requireThat(
      m.recovery_state.startsWith('review:'),
      'RECOVERY_NOT_REVIEWING',
      '当前没有待核对的恢复。',
    );
    return;
  }
  if (path === '/judge/accounts') {
    validateAccount(engine, actor, body);
    return;
  }
  if (path === '/judge/report-correction') {
    permission(actor, 'commands');
    validateReportCorrection(engine, body);
    return;
  }
  if (['/judge/arm-code-release', '/judge/arm-start'].includes(path)) {
    requireThat(
      m.phase === (path.endsWith('release') ? 'setup' : 'outfitting'),
      'WRONG_PHASE',
      '当前阶段不能安排这个时间。',
    );
    const utc = integer(
      body.time,
      engine.now() + 1000,
      engine.now() + 7 * 86400_000,
    );
    void utc;
    const roster = db.all<{id: string}>(
      "SELECT id FROM players WHERE entry_status='registered' AND id IN (SELECT player_id FROM roster_members) ORDER BY id",
    );
    requireThat(
      Array.isArray(body.expected_roster) &&
        stableJson(stringArray(body.expected_roster).sort()) ===
          stableJson(roster.map(p => p.id)),
      'ROSTER_CHANGED',
      '正式名单已变化，请刷新后重新核对。',
    );
    requireThat(
      roster.length >= 2,
      'ROSTER_TOO_SMALL',
      '至少需要两名正式玩家。',
    );
    for (const p of roster) {
      const f = db.flight(p.id);
      const h = db.home(p.id);
      if (path.endsWith('release')) {
        requireThat(
          f.status === 'staged' &&
            f.departed !== null &&
            f.staged !== null &&
            f.code_id === null &&
            h?.status === 'verified',
          'ROSTER_NOT_READY',
          '仍有正式玩家未完成准备。',
        );
      } else {
        requireThat(
          f.status === 'ready' &&
            f.ready !== null &&
            f.code_id &&
            db.one<Record<string, SqlStorageValue>>(
              "SELECT id FROM sighting_codes WHERE id=? AND player_id=? AND status='reserved'",
              f.code_id,
              p.id,
            ),
          'ROSTER_NOT_READY',
          '仍有正式玩家未完成穿戴。',
        );
      }
    }
  } else if (path === '/judge/roster') {
    requireThat(m.phase === 'setup', 'ROSTER_LOCKED', '正式参赛名单已锁定。');
    requireThat(
      Array.isArray(body.members) &&
        body.members.length >= 2 &&
        body.members.length <= 350 &&
        new Set(body.members).size === body.members.length,
      'BAD_ROSTER',
      '请选择至少两名正式玩家，每个账号只选一次。',
      400,
    );
    for (const id of body.members) {
      requireThat(
        db.player(text(id, 16)).entry_status === 'registered',
        'NOT_REGISTERED',
        '退出正式名单的账号不能加入本场。',
      );
    }
  } else if (path === '/judge/parameters') {
    requireThat(m.phase === 'setup', 'PARAMETERS_LOCKED', '比赛参数已锁定。');
    requireThat(
      integer(body.expected_version, 1) ===
        db.one<{version: number}>(
          "SELECT version FROM settings WHERE key='parameters'",
        )!.version,
      'VERSION_CONFLICT',
      '参数已更新，请刷新后重新核对。',
    );
    validateParameters(body.values);
  } else if (path === '/judge/pause') {
    requireThat(
      m.start_settled !== null && m.phase !== 'ended' && m.paused_at === null,
      'CANNOT_PAUSE',
      '当前不能暂停比赛。',
    );
  } else if (path === '/judge/resume') {
    requireThat(
      m.paused_at !== null &&
        m.pause_reason !== 'hunt_review' &&
        m.phase !== 'ended',
      'CANNOT_RESUME',
      '请先完成终局资格核验。',
    );
  } else if (path === '/judge/hunt-finalize') {
    requireThat(
      m.phase === 'hunt' &&
        m.paused_at !== null &&
        m.pause_reason === 'hunt_review' &&
        m.hunt_finalized === null,
      'HUNT_NOT_REVIEWING',
      '当前未进行终局资格核验。',
    );
    requireThat(
      Array.isArray(body.eliminations),
      'BAD_ELIMINATIONS',
      '请核对淘汰名单。',
      400,
    );
    const seen = new Set<string>();
    for (const raw of body.eliminations) {
      const p = strict(raw, ['id', 'reason']);
      const id = text(p.id, 16);
      requireThat(
        survivors(engine).includes(id) && !seen.has(id),
        'HUNT_ROSTER_CHANGED',
        '淘汰名单已变化，请重新核对。',
      );
      requireThat(
        ['no_share_at_cutoff', 'outside_at_cutoff'].includes(String(p.reason)),
        'BAD_REASON',
        '请选择裁决原因。',
        400,
      );
      seen.add(id);
    }
  } else if (path === '/judge/hunt-eliminate') {
    requireThat(
      m.phase === 'hunt' && m.hunt_finalized !== null && m.paused_at === null,
      'HUNT_NOT_RUNNING',
      '最后狩猎尚未开始。',
    );
    requireThat(
      survivors(engine).includes(text(body.target, 16)),
      'TARGET_NOT_ALIVE',
      '目标已不在存活名单中。',
    );
    requireThat(
      ['left_zone', 'sharing_stopped', 'location_violation'].includes(
        String(body.reason_code),
      ),
      'BAD_REASON',
      '请选择裁决原因。',
      400,
    );
  } else if (path === '/judge/player-eliminate') {
    requireThat(
      m.start_settled !== null && m.phase !== 'ended',
      'MATCH_NOT_RUNNING',
      '请在比赛正式开始后记录违规淘汰。',
    );
    requireThat(
      survivors(engine).includes(text(body.target, 16)),
      'TARGET_NOT_ALIVE',
      '目标已不在存活名单中。',
    );
  } else if (path === '/judge/player-restore') {
    restoration(engine, text(body.target, 16));
  } else if (path === '/judge/effects') {
    if (body.revoke) {
      requireThat(
        db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM admin_effects WHERE id=? AND active=1',
          text(body.revoke, 100),
        ),
        'EFFECT_NOT_ACTIVE',
        '该临时效果已经结束。',
      );
    } else {
      const target = text(body.target, 16);
      requireThat(
        target === '@a' ||
          !!db.one<Record<string, SqlStorageValue>>(
            'SELECT id FROM players WHERE id=?',
            target,
          ),
        'PLAYER_NOT_FOUND',
        '文明不存在。',
        404,
      );
      integer(body.seconds, 1, 86400);
    }
  } else if (path.startsWith('/judge/roster/')) {
    requireThat(
      ['setup', 'armed', 'outfitting'].includes(m.phase),
      'ROSTER_LOCKED',
      '当前不能调整首航名单。',
    );
    const id = path.split('/')[3]!;
    requireThat(
      db.player(id).entry_status === 'registered',
      'NOT_REGISTERED',
      '该文明已退出正式名单。',
    );
  } else if (path === '/judge/equipment-correction') {
    const target = text(body.target, 16);
    db.player(target);
    requireThat(
      (body.mode === 'replace' || m.paused_at !== null) && m.phase !== 'ended',
      'PAUSE_REQUIRED',
      '请先暂停比赛。',
    );
    requireThat(
      ['replace', 'reissue', 'activate'].includes(String(body.mode)),
      'BAD_MODE',
      '处理方式不正确。',
      400,
    );
    requireThat(
      db.flight(target).status ===
        (body.mode === 'activate' ? 'issued' : 'active') ||
        (m.recovery_state.startsWith('review:') &&
          body.mode === 'reissue' &&
          ['issued', 'outfitting', 'ready'].includes(db.flight(target).status)),
      'FLIGHT_STATE_CONFLICT',
      '请重新核对当前航次。',
    );
  } else if (path === '/judge/correction') {
    db.player(text(body.target, 16));
    requireThat(
      m.phase !== 'ended',
      'RESULTS_SEALED',
      '比赛已结束，请通过赛后更正处理。',
    );
    const field = text(body.field, 20);
    requireThat(
      ['nickname', 'photons', 'broadcasts', 'restore'].includes(field),
      'BAD_FIELD',
      '更正项目不正确。',
      400,
    );
    if (field === 'nickname') {
      const n = nickname(body.value);
      requireThat(
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM players WHERE nickname=? AND id<>?',
          n,
          String(body.target),
        ),
        'NICKNAME_TAKEN',
        '这个昵称已被使用。',
      );
    } else if (field === 'restore') {
      restoration(engine, String(body.target));
    } else {
      integer(Number(body.value), 0, field === 'photons' ? 1 : 2);
    }
  } else if (path === '/judge/observer-access') {
    db.player(text(body.target, 16));
    requireThat(
      typeof body.allowed === 'boolean',
      'BAD_ACCESS',
      '观战权限设置不正确。',
      400,
    );
  } else if (path === '/judge/announce') {
    const target = text(body.target, 16);
    if (target !== '@a') {
      db.player(target);
    }
    text(body.message, 1000);
  } else if (path === '/judge/attack-correction') {
    correctionTarget(engine, body.attack_id);
  } else if (path === '/judge/event-control') {
    const event = db.one<Scheduled>(
      'SELECT * FROM scheduled_events WHERE id=?',
      text(body.event_id, 180),
    );
    requireThat(event, 'EVENT_NOT_FOUND', '赛事事件不存在。', 404);
    requireThat(
      body.operation === 'retry' || body.operation === 'cancel',
      'BAD_OPERATION',
      '请选择处理方式。',
      400,
    );
    if (body.operation === 'cancel') {
      requireThat(
        m.paused_at !== null &&
          event.status === 'pending' &&
          ['song_visit', 'tech_burst', 'judge_delayed_command'].includes(
            event.kind,
          ),
        'EVENT_NOT_CANCELLABLE',
        '请暂停比赛后核对该事件。',
      );
    } else {
      requireThat(
        !m.recovery_state,
        'RECOVERY_REVIEW',
        '请先完成比赛恢复核对，再重试赛事事件。',
      );
      requireThat(
        event.status !== 'cancelled',
        'EVENT_CANCELLED',
        '已取消事件不能重开；需要新增事件时请使用独立的手动触发操作。',
      );
      const utc = dueUtc(engine, event);
      requireThat(
        event.status === 'settled' || (utc !== null && utc <= engine.now()),
        'EVENT_NOT_DUE',
        '该计划尚未到期，不能提前执行。',
      );
    }
  } else if (path === '/judge/event-trigger') {
    requireThat(
      m.paused_at !== null &&
        m.phase === 'forest' &&
        engine.game() < TIMES.apocalypse,
      'PAUSE_REQUIRED',
      '请在第一阶段暂停后核对手动事件。',
    );
    requireThat(
      body.kind === 'song_visit',
      'BAD_EVENT_KIND',
      '当前手动事件仅支持歌者清理。',
      400,
    );
    coordinate(body.code);
  } else if (path === '/judge/schedule-announcement') {
    integer(body.seconds, 1, 86400);
    text(body.message, 1000);
  } else if (path === '/judge/reveal') {
    requireThat(
      ['alive_homeworlds', 'unused_photoids', 'kills_last_10min'].includes(
        String(body.statistic),
      ),
      'BAD_STATISTIC',
      '请选择统计项目。',
      400,
    );
  } else if (path === '/judge/replay') {
    integer(body.count, 1, 10);
  }
}

/** 校验赛前可配置参数的白名单与范围，锁定后的修改另受阶段限制。 */
export function validateParameters(raw: unknown): Parameters {
  const names = [
    'singerPercent',
    'firstLockSeconds',
    'secondLockSeconds',
    'secondOutPercent',
    'respawnSeconds',
    'observerWaitSeconds',
    'sightingIntervalMs',
    'sightingsPerMinute',
  ];
  const p = strict(raw, names);
  const read = (name: keyof Parameters) =>
    integer(
      p[name],
      ['singerPercent', 'secondOutPercent', 'observerWaitSeconds'].includes(
        name,
      )
        ? 0
        : 1,
      name.endsWith('Percent')
        ? 100
        : name === 'sightingsPerMinute'
          ? 120
          : name === 'sightingIntervalMs'
            ? 60000
            : 86400,
    );
  return {
    singerPercent: read('singerPercent'),
    firstLockSeconds: read('firstLockSeconds'),
    secondLockSeconds: read('secondLockSeconds'),
    secondOutPercent: read('secondOutPercent'),
    respawnSeconds: read('respawnSeconds'),
    observerWaitSeconds: read('observerWaitSeconds'),
    sightingIntervalMs: read('sightingIntervalMs'),
    sightingsPerMinute: read('sightingsPerMinute'),
  };
}
