import {parseJson} from '../../../../packages/contracts/src/backend';
import {gameTime, uniformInt} from '../domain/rules';
import {
  APOCALYPSE_COPY,
  HUNT_REVIEW_COPY,
  PREPARE_COPY,
  TRANSFER_COPY,
  clearingCopy,
  techBurstCopy,
} from '../../../../packages/contracts/src/message_copy';
import {Fault, requireThat, type Scheduled} from '../storage/store';
import type {Engine} from '../services/engine';
import {
  autoFinish,
  destroyHome,
  eliminate,
  finish,
  logEvent,
} from '../services/life';
import {executeCommandEvent} from '../services/commands';
import {
  ContractError,
  coordinate,
  integer,
  object,
  text,
} from '../../../../packages/contracts/src/backend';

export function dueUtc(e: Engine, event: Scheduled): number | null {
  if (event.clock === 'utc') {
    return event.due;
  }
  const m = e.db.match();
  if (
    m.started_at === null ||
    m.start_settled === null ||
    m.phase === 'ended'
  ) {
    return null;
  }
  if (m.paused_at !== null && event.due > gameTime(m, e.now())) {
    return null;
  }
  return m.started_at + m.paused_total + event.due;
}
export class EventFailure extends Fault {
  constructor(
    public eventId: string,
    reason = '事务未完成',
  ) {
    super(
      503,
      'EVENT_SETTLEMENT_FAILED',
      `到期事件结算失败（${reason}），已阻止战局操作，请总裁判暂停并核查。`,
    );
  }
}
export function recordEventFailure(e: Engine, error: EventFailure): void {
  e.db.tx(() => {
    e.db.exec(
      'UPDATE scheduled_events SET attempt_count=attempt_count+1,last_attempt_utc=?,last_error=?,last_error_utc=? WHERE id=?',
      e.now(),
      error.message,
      e.now(),
      error.eventId,
    );
    e.db.exec('UPDATE scheduler_health SET error=? WHERE id=1', error.message);
  });
}
export function settleDue(e: Engine): void {
  if (e.db.match().recovery_state) {
    return;
  }
  const db = e.db;
  for (let count = 0; count < 128; count++) {
    const now = e.now();
    const due = db
      .all<Scheduled>("SELECT * FROM scheduled_events WHERE status='pending'")
      .map(event => ({event, utc: dueUtc(e, event)}))
      .filter(
        (v): v is {event: Scheduled; utc: number} =>
          v.utc !== null && v.utc <= now,
      )
      .sort(
        (a, b) =>
          a.utc - b.utc ||
          a.event.priority - b.event.priority ||
          a.event.id.localeCompare(b.event.id),
      );
    const next = due[0];
    if (!next) {
      return;
    }
    try {
      db.tx(() => {
        const event = db.one<Scheduled>(
          "SELECT * FROM scheduled_events WHERE id=? AND status='pending'",
          next.event.id,
        );
        if (!event) {
          return;
        }
        const utc = dueUtc(e, event);
        if (utc === null || utc > e.now()) {
          return;
        }
        db.exec(
          "UPDATE scheduled_events SET status='settled',committed_utc=?,attempt_count=attempt_count+1,last_attempt_utc=?,last_error='' WHERE id=? AND status='pending'",
          e.now(),
          e.now(),
          event.id,
        );
        settleEvent(e, event, utc);
        db.exec(
          "UPDATE scheduler_health SET last_success=?,error='' WHERE id=1",
          e.now(),
        );
        db.bump();
      });
    } catch (error) {
      throw new EventFailure(
        next.event.id,
        error instanceof SyntaxError
          ? '事件负载不是有效JSON'
          : error instanceof ContractError
            ? '事件参数格式不正确'
            : error instanceof Fault
              ? error.code
              : '事务未完成',
      );
    }
  }
  throw new Fault(503, 'EVENT_BACKLOG', '正在处理到期赛事事件，请稍后再试。');
}
function settleEvent(e: Engine, event: Scheduled, utc: number): void {
  const db = e.db;
  const m = db.match();
  const payload = object(parseJson(event.payload));
  const game =
    event.clock === 'game'
      ? event.due
      : event.kind === 'match_start'
        ? 0
        : e.game(utc);
  switch (event.kind) {
    case 'judge_command_task':
    case 'judge_command_job':
      executeCommandEvent(e, event);
      break;
    case 'code_release':
      requireThat(
        m.phase === 'armed',
        'RELEASE_STATE_CONFLICT',
        '发码阶段需要裁判核查。',
      );
      db.exec("UPDATE matches SET phase='outfitting'");
      logEvent(
        e,
        event.id,
        'stage',
        '做好准备',
        PREPARE_COPY,
        'public',
        [],
        game,
        utc,
      );
      e.notice(event.id, 'group', '做好准备', PREPARE_COPY, game);
      break;
    case 'match_start': {
      db.exec(
        "INSERT OR IGNORE INTO participation_history SELECT m.account_id,m.local_id,? FROM memberships m JOIN roster_members r ON r.player_id=m.local_id WHERE m.kind='player' AND m.state='bound'",
        e.now(),
      );
      const roster = db.all<{id: string}>(
        "SELECT id FROM players WHERE entry_status='registered' AND id IN (SELECT player_id FROM roster_members)",
      );
      requireThat(
        m.phase === 'start_countdown' && roster.length >= 2,
        'START_STATE_CONFLICT',
        '开赛状态需要裁判核查。',
      );
      for (const p of roster) {
        const flight = db.flight(p.id);
        requireThat(
          flight.status === 'ready' && flight.code_id && flight.ready !== null,
          'ROSTER_NOT_READY',
          '仍有玩家未完成穿戴。',
        );
        requireThat(
          db.all(
            "UPDATE sighting_codes SET status='active',activated_utc=?,activated_game=0 WHERE id=? AND player_id=? AND status='reserved' RETURNING id",
            utc,
            flight.code_id,
            p.id,
          ).length === 1,
          'CODE_STATE_CONFLICT',
          '手环配置需要裁判核查。',
        );
        db.exec("UPDATE flights SET status='active' WHERE player_id=?", p.id);
      }
      db.exec("UPDATE matches SET phase='forest',start_settled=?", utc);
      logEvent(
        e,
        event.id,
        'stage',
        '比赛开始',
        '全部文明统一出航，比赛计时开始。',
        'public',
        roster.map(p => p.id),
        0,
        utc,
      );
      e.notice(
        event.id,
        'group',
        '比赛开始',
        '全部文明统一出航，比赛计时开始。',
        0,
      );
      break;
    }
    case 'respawn_timeout': {
      const player = text(payload.player, 16);
      const flight = db.flight(player);
      integer(payload.deadline, 0);
      if (
        ['returning', 'preparing', 'issued'].includes(flight.status) &&
        flight.deadline === payload.deadline
      ) {
        eliminate(e, player, 'respawn_timeout', event.id, game, utc);
      }
      autoFinish(e, game, utc, event.id);
      break;
    }
    case 'tech_burst': {
      const candidates = db.all<{id: string}>(
        "SELECT p.id FROM players p JOIN flights f ON f.player_id=p.id JOIN homeworlds h ON h.player_id=p.id WHERE p.entry_status='registered' AND p.id IN (SELECT player_id FROM roster_members) AND f.status!='eliminated' AND p.tech=0 AND h.status='verified' AND h.destroyed_game IS NULL ORDER BY p.id",
      );
      const target = candidates.length
        ? candidates[uniformInt(candidates.length)]!.id
        : null;
      if (target) {
        db.exec('UPDATE players SET tech=1,photons=1 WHERE id=?', target);
        logEvent(
          e,
          event.id,
          'tech',
          '技术爆炸',
          techBurstCopy(e.identity(target)),
          'personal',
          [target],
          game,
          utc,
          target,
          null,
          target,
        );
        e.notice(
          event.id,
          target,
          '技术爆炸',
          techBurstCopy(e.identity(target)),
          game,
        );
      } else {
        e.audit('system', 'tech_burst_empty', event.id, '没有符合条件的文明');
      }
      break;
    }
    case 'song_visit': {
      const code = coordinate(payload.code);
      const target = db.officialHome(code, true);
      const hit = target
        ? destroyHome(e, target.player_id, event.id, game, utc)
        : false;
      const body = clearingCopy(
        'singer',
        code,
        hit ? e.identity(target!.player_id) : undefined,
      );
      logEvent(
        e,
        event.id,
        'singer',
        '歌者清理',
        body,
        'public',
        hit ? [target!.player_id] : [],
        game,
        utc,
        null,
        code,
      );
      db.exec(
        "UPDATE broadcasts SET singer_status='settled' WHERE id=?",
        String(payload.broadcast),
      );
      e.notice(event.id, 'group', '歌者清理', body, game);
      autoFinish(e, game, utc, event.id);
      break;
    }
    case 'apocalypse': {
      db.exec("UPDATE matches SET phase='apocalypse'");
      const homes = db.all<{player_id: string}>(
        "SELECT player_id FROM homeworlds WHERE status='verified' AND destroyed_game IS NULL AND player_id IN (SELECT player_id FROM roster_members)",
      );
      for (const h of homes) {
        destroyHome(e, h.player_id, event.id, game, utc);
      }
      const inactive = db.all<{id: string}>(
        "SELECT p.id FROM players p JOIN flights f ON f.player_id=p.id WHERE p.entry_status='registered' AND p.id IN (SELECT player_id FROM roster_members) AND f.status NOT IN ('active','eliminated')",
      );
      for (const p of inactive) {
        eliminate(e, p.id, 'apocalypse', event.id, game, utc);
      }
      logEvent(
        e,
        event.id,
        'stage',
        '宇宙末日',
        APOCALYPSE_COPY,
        'public',
        [],
        game,
        utc,
      );
      e.notice(event.id, 'group', '宇宙末日', APOCALYPSE_COPY, game);
      autoFinish(e, game, utc, event.id);
      break;
    }
    case 'transfer_start':
      db.exec("UPDATE matches SET phase='transfer'");
      logEvent(
        e,
        event.id,
        'stage',
        '前往终局圈',
        TRANSFER_COPY,
        'public',
        [],
        game,
        utc,
      );
      e.notice(event.id, 'group', '前往终局圈', TRANSFER_COPY, game);
      break;
    case 'hunt_cutoff':
      db.exec(
        "UPDATE matches SET phase='hunt',paused_at=?,pause_reason='hunt_review'",
        utc,
      );
      db.exec(
        "INSERT INTO clock_pauses(opened,reason,actor) VALUES(?,'hunt_review','system')",
        utc,
      );
      logEvent(
        e,
        event.id,
        'stage',
        '终局资格确认中',
        HUNT_REVIEW_COPY,
        'public',
        [],
        game,
        utc,
      );
      e.notice(event.id, 'group', '终局资格确认中', HUNT_REVIEW_COPY, game);
      break;
    case 'regulation_end':
      finish(e, 'regulation', game, utc, event.id);
      break;
    case 'judge_delayed_command': {
      const message = text(payload.message, 1000);
      logEvent(
        e,
        event.id,
        'notice',
        '赛事通知',
        message,
        'public',
        [],
        game,
        utc,
      );
      e.notice(event.id, 'group', '赛事通知', message, game);
      break;
    }
    default:
      throw new Error('UNKNOWN_SCHEDULED_EVENT');
  }
}
export async function rearm(e: Engine): Promise<void> {
  const db = e.db;
  for (let attempt = 0; attempt < 8; attempt++) {
    const revision = db.match().scheduler_revision;
    const recoveryState = db.match().recovery_state;
    const times = recoveryState
      ? []
      : db
          .all<Scheduled>(
            "SELECT * FROM scheduled_events WHERE status='pending'",
          )
          .map(event => dueUtc(e, event))
          .filter((v): v is number => v !== null);
    const next = times.length
      ? Math.max(e.now() + 1, Math.min(...times))
      : null;
    try {
      if (next === null) {
        await db.storage.deleteAlarm();
      } else {
        await db.storage.setAlarm(next);
      }
      if (
        db.match().scheduler_revision !== revision ||
        db.match().recovery_state !== recoveryState
      ) {
        continue;
      }
      db.exec(
        "UPDATE scheduler_health SET next_wake=?,error=CASE WHEN EXISTS(SELECT 1 FROM scheduled_events WHERE status='pending' AND last_error!='') THEN '到期事件结算失败，请总裁判核查。' ELSE '' END WHERE id=1",
        next,
      );
      return;
    } catch {
      db.exec(
        "UPDATE scheduler_health SET next_wake=NULL,error='事件唤醒登记失败，请总裁判重新安排。' WHERE id=1",
      );
      return; // A committed action remains committed; a later RPC can repair registration.
    }
  }
  db.exec(
    "UPDATE scheduler_health SET error='事件安排持续变化，请总裁判核查。' WHERE id=1",
  );
}
