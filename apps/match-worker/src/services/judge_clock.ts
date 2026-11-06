import {integer} from '../../../../packages/contracts/src/backend';
import {START_COUNTDOWN_COPY} from '../../../../packages/contracts/src/message_copy';
import {techSchedule, TIMES} from '../domain/rules';
import {requireThat} from '../storage/store';
import {type Engine} from './engine';
import type {JudgeMutationContext} from './judge_action_context';

/** 冻结参数并安排统一发码UTC事件，沿用当前审计来源。 */
export function armCodeRelease(context: JudgeMutationContext): void {
  const {db, raw, engine, source, game} = context;
  db.exec(
    "INSERT OR IGNORE INTO settings(key,value) VALUES('parameters_frozen','true')",
  );
  const time = integer(raw.time);
  db.exec("UPDATE matches SET phase='armed',release_at=?", time);
  engine.schedule('code_release', 'code_release', 'utc', time, 0);
  engine.notice(
    source,
    'group',
    '统一发码时间',
    `统一发码时间：${new Date(time).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}。`,
    game,
  );
}

/** 安排开赛、阶段转换和科技爆发事件，保持原优先级与时基。 */
export function armMatchStart(context: JudgeMutationContext): void {
  const {raw, db, engine, source, game} = context;
  const time = integer(raw.time);
  const playerCount = db.roster().length;
  db.exec("UPDATE matches SET phase='start_countdown',started_at=?", time);
  engine.schedule('match_start', 'match_start', 'utc', time, 0);
  for (const [kind, due] of [
    ['apocalypse', TIMES.apocalypse],
    ['transfer_start', TIMES.transfer],
    ['hunt_cutoff', TIMES.cutoff],
    ['regulation_end', TIMES.end],
  ] as const) {
    engine.schedule(kind, kind, 'game', due, 0);
  }
  for (const [index, due] of techSchedule(playerCount).entries()) {
    engine.schedule(`tech:${index}`, 'tech_burst', 'game', due, 2);
  }
  engine.notice(
    source,
    'group',
    '统一开赛时间',
    `统一开赛时间：${new Date(time).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}。\n${START_COUNTDOWN_COPY}`,
    game,
  );
}

/** 同时记录暂停时点和开放暂停区间，供恢复比赛时核对。 */
export function pauseMatch(context: JudgeMutationContext): void {
  const {db, now, reason, actor} = context;
  db.exec('UPDATE matches SET paused_at=?,pause_reason=?', now, reason);
  db.exec(
    'INSERT INTO clock_pauses(opened,reason,actor) VALUES(?,?,?)',
    now,
    reason,
    actor.id,
  );
}

/** 关闭唯一开放暂停区间并累加真实UTC暂停时长，拒绝不一致记录。 */
export function closePause(engine: Engine, now: number): void {
  const matchState = engine.db.match();
  requireThat(matchState.paused_at !== null, 'NOT_PAUSED', '比赛当前未暂停。');
  requireThat(
    engine.db.all<Record<string, SqlStorageValue>>(
      'UPDATE clock_pauses SET closed=? WHERE closed IS NULL RETURNING id',
      now,
    ).length === 1,
    'PAUSE_STATE_CONFLICT',
    '暂停记录需要核查。',
  );
  engine.db.exec(
    "UPDATE matches SET paused_total=paused_total+?,paused_at=NULL,pause_reason=''",
    now - matchState.paused_at,
  );
}
