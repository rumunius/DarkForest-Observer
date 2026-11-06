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

/** 把事件的UTC或有效时间映射到可唤醒UTC，暂停可能使游戏时钟事件暂不可达。 */
export function dueUtc(engine: Engine, event: Scheduled): number | null {
  if (event.clock === 'utc') {
    return event.due;
  }
  const matchState = engine.db.match();
  if (
    matchState.started_at === null ||
    matchState.start_settled === null ||
    matchState.phase === 'ended'
  ) {
    return null;
  }
  if (
    matchState.paused_at !== null &&
    event.due > gameTime(matchState, engine.now())
  ) {
    return null;
  }
  return matchState.started_at + matchState.paused_total + event.due;
}
/** 保留事件失败身份及诊断，供受控故障查询和后续重试使用。 */
export class EventFailure extends Fault {
  constructor(
    readonly eventId: string,
    reason = '事务未完成',
  ) {
    super(
      503,
      'EVENT_SETTLEMENT_FAILED',
      `到期事件结算失败（${reason}），已阻止战局操作，请总裁判暂停并核查。`,
    );
  }
}
/** 持久记录结算失败，阻断依赖到期屏障的战局操作而不伪造成功。 */
export function recordEventFailure(engine: Engine, error: EventFailure): void {
  engine.db.tx(() => {
    engine.db.exec(
      'UPDATE scheduled_events SET attempt_count=attempt_count+1,last_attempt_utc=?,last_error=?,last_error_utc=? WHERE id=?',
      engine.now(),
      error.message,
      engine.now(),
      error.eventId,
    );
    engine.db.exec(
      'UPDATE scheduler_health SET error=? WHERE id=1',
      error.message,
    );
  });
}
/** 按既定事件顺序补结算到期任务；遇到故障停止，已提交事件保持幂等。 */
export function settleDue(engine: Engine): void {
  if (engine.db.match().recovery_state) {
    return;
  }
  const db = engine.db;
  for (let count = 0; count < 128; count++) {
    const now = engine.now();
    const due = db
      .all<Scheduled>("SELECT * FROM scheduled_events WHERE status='pending'")
      .map(event => ({event, utc: dueUtc(engine, event)}))
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
        const utc = dueUtc(engine, event);
        if (utc === null || utc > engine.now()) {
          return;
        }
        db.exec(
          "UPDATE scheduled_events SET status='settled',committed_utc=?,attempt_count=attempt_count+1,last_attempt_utc=?,last_error='' WHERE id=? AND status='pending'",
          engine.now(),
          engine.now(),
          event.id,
        );
        settleEvent(engine, event, utc);
        db.exec(
          "UPDATE scheduler_health SET last_success=?,error='' WHERE id=1",
          engine.now(),
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
function settleEvent(engine: Engine, event: Scheduled, utc: number): void {
  const db = engine.db;
  const matchState = db.match();
  const payload = object(parseJson(event.payload));
  const game =
    event.clock === 'game'
      ? event.due
      : event.kind === 'match_start'
        ? 0
        : engine.game(utc);
  switch (event.kind) {
    case 'judge_command_task':
    case 'judge_command_job':
      executeCommandEvent(engine, event);
      break;
    case 'code_release':
      requireThat(
        matchState.phase === 'armed',
        'RELEASE_STATE_CONFLICT',
        '发码阶段需要裁判核查。',
      );
      db.exec("UPDATE matches SET phase='outfitting'");
      logEvent(
        engine,
        event.id,
        'stage',
        '做好准备',
        PREPARE_COPY,
        'public',
        [],
        game,
        utc,
      );
      engine.notice(event.id, 'group', '做好准备', PREPARE_COPY, game);
      break;
    case 'match_start': {
      db.exec(
        "INSERT OR IGNORE INTO participation_history SELECT m.account_id,m.local_id,? FROM memberships m JOIN roster_members r ON r.player_id=m.local_id WHERE m.kind='player' AND m.state='bound'",
        engine.now(),
      );
      const roster = db.all<{id: string}>(
        "SELECT id FROM players WHERE entry_status='registered' AND id IN (SELECT player_id FROM roster_members)",
      );
      requireThat(
        matchState.phase === 'start_countdown' && roster.length >= 2,
        'START_STATE_CONFLICT',
        '开赛状态需要裁判核查。',
      );
      for (const rosterPlayer of roster) {
        const flight = db.flight(rosterPlayer.id);
        requireThat(
          flight.status === 'ready' && flight.code_id && flight.ready !== null,
          'ROSTER_NOT_READY',
          '仍有玩家未完成穿戴。',
        );
        requireThat(
          db.all<Record<string, SqlStorageValue>>(
            "UPDATE sighting_codes SET status='active',activated_utc=?,activated_game=0 WHERE id=? AND player_id=? AND status='reserved' RETURNING id",
            utc,
            flight.code_id,
            rosterPlayer.id,
          ).length === 1,
          'CODE_STATE_CONFLICT',
          '手环配置需要裁判核查。',
        );
        db.exec(
          "UPDATE flights SET status='active' WHERE player_id=?",
          rosterPlayer.id,
        );
      }
      db.exec("UPDATE matches SET phase='forest',start_settled=?", utc);
      logEvent(
        engine,
        event.id,
        'stage',
        '比赛开始',
        '全部文明统一出航，比赛计时开始。',
        'public',
        roster.map(p => p.id),
        0,
        utc,
      );
      engine.notice(
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
        eliminate(engine, player, 'respawn_timeout', event.id, game, utc);
      }
      autoFinish(engine, game, utc, event.id);
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
          engine,
          event.id,
          'tech',
          '技术爆炸',
          techBurstCopy(engine.identity(target)),
          'personal',
          [target],
          game,
          utc,
          target,
          null,
          target,
        );
        engine.notice(
          event.id,
          target,
          '技术爆炸',
          techBurstCopy(engine.identity(target)),
          game,
        );
      } else {
        engine.audit(
          'system',
          'tech_burst_empty',
          event.id,
          '没有符合条件的文明',
        );
      }
      break;
    }
    case 'song_visit': {
      const code = coordinate(payload.code);
      const target = db.officialHome(code, true);
      const hit = target
        ? destroyHome(engine, target.player_id, event.id, game, utc)
        : false;
      const body = clearingCopy(
        'singer',
        code,
        hit ? engine.identity(target!.player_id) : undefined,
      );
      logEvent(
        engine,
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
      engine.notice(event.id, 'group', '歌者清理', body, game);
      autoFinish(engine, game, utc, event.id);
      break;
    }
    case 'apocalypse': {
      db.exec("UPDATE matches SET phase='apocalypse'");
      const homes = db.all<{player_id: string}>(
        "SELECT player_id FROM homeworlds WHERE status='verified' AND destroyed_game IS NULL AND player_id IN (SELECT player_id FROM roster_members)",
      );
      for (const h of homes) {
        destroyHome(engine, h.player_id, event.id, game, utc);
      }
      const inactive = db.all<{id: string}>(
        "SELECT p.id FROM players p JOIN flights f ON f.player_id=p.id WHERE p.entry_status='registered' AND p.id IN (SELECT player_id FROM roster_members) AND f.status NOT IN ('active','eliminated')",
      );
      for (const p of inactive) {
        eliminate(engine, p.id, 'apocalypse', event.id, game, utc);
      }
      logEvent(
        engine,
        event.id,
        'stage',
        '宇宙末日',
        APOCALYPSE_COPY,
        'public',
        [],
        game,
        utc,
      );
      engine.notice(event.id, 'group', '宇宙末日', APOCALYPSE_COPY, game);
      autoFinish(engine, game, utc, event.id);
      break;
    }
    case 'transfer_start':
      db.exec("UPDATE matches SET phase='transfer'");
      logEvent(
        engine,
        event.id,
        'stage',
        '前往终局圈',
        TRANSFER_COPY,
        'public',
        [],
        game,
        utc,
      );
      engine.notice(event.id, 'group', '前往终局圈', TRANSFER_COPY, game);
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
        engine,
        event.id,
        'stage',
        '终局资格确认中',
        HUNT_REVIEW_COPY,
        'public',
        [],
        game,
        utc,
      );
      engine.notice(
        event.id,
        'group',
        '终局资格确认中',
        HUNT_REVIEW_COPY,
        game,
      );
      break;
    case 'regulation_end':
      finish(engine, 'regulation', game, utc, event.id);
      break;
    case 'judge_delayed_command': {
      const message = text(payload.message, 1000);
      logEvent(
        engine,
        event.id,
        'notice',
        '赛事通知',
        message,
        'public',
        [],
        game,
        utc,
      );
      engine.notice(event.id, 'group', '赛事通知', message, game);
      break;
    }
    default:
      throw new Error('UNKNOWN_SCHEDULED_EVENT');
  }
}
/** 依据持久事件队列重新登记最近Alarm，不改变事件ID或重新抽取随机计划。 */
export async function rearm(engine: Engine): Promise<void> {
  const db = engine.db;
  for (let attempt = 0; attempt < 8; attempt++) {
    const revision = db.match().scheduler_revision;
    const recoveryState = db.match().recovery_state;
    const times = recoveryState
      ? []
      : db
          .all<Scheduled>(
            "SELECT * FROM scheduled_events WHERE status='pending'",
          )
          .map(event => dueUtc(engine, event))
          .filter((v): v is number => v !== null);
    const next = times.length
      ? Math.max(engine.now() + 1, Math.min(...times))
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
