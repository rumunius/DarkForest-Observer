import {
  parseJson,
  stableJson,
} from '../../../../packages/contracts/src/backend';
import {instantMs} from '../../../../packages/contracts/src/commands';
import {START_COUNTDOWN_COPY} from '../../../../packages/contracts/src/message_copy';
import {TIMES, techSchedule} from '../domain/rules';
import {type Scheduled} from '../storage/store';
import type {CommandContext, SavedCommandObject} from './command_context';
import {
  recordChange,
  requireHeadJudge,
  requireCommandArgument,
  saveCommandObject,
  selectTargets,
  recordTableDependency,
} from './command_context';

/** 处理尚未到达的赛程锁定与撤销，保留首次冻结及未来计划的校验边界。 */
export function matchTime(
  commandContext: CommandContext,
  path: string,
  commandArguments: string[],
): void {
  requireHeadJudge(commandContext);
  const engine = commandContext.engine;
  const db = engine.db;
  const matchState = db.match();
  const release = path.endsWith('release');
  const key = release ? 'release_at' : 'started_at';
  const old = matchState[key];
  const node = release ? 'code_release' : 'match_start';
  recordTableDependency(commandContext, 'scheduled_events');
  recordTableDependency(commandContext, 'roster_members');
  const time = commandArguments.length ? instantMs(commandArguments[1]!) : null;
  if (path.includes('postpone') || path.includes('cancel')) {
    requireCommandArgument(
      matchState.start_settled === null &&
        old !== null &&
        engine.now() < old &&
        matchState.phase === (release ? 'armed' : 'start_countdown'),
      '只能修改尚未到达、尚未结算的已锁定节点',
    );
    if (time !== null) {
      requireCommandArgument(time > old, '新时刻必须严格晚于原锁定时间');
    }
    const event = db.one<Scheduled>(
      'SELECT * FROM scheduled_events WHERE id=?',
      node,
    );
    requireCommandArgument(
      event?.status === 'pending',
      '原节点已结算或不可变更',
    );
    saveCommandObject(
      commandContext,
      'node-history',
      {node, old, event, newTime: time},
      'NODE',
    );
    if (time === null) {
      db.exec(
        "UPDATE scheduled_events SET status='cancelled' WHERE id=?",
        node,
      );
      db.exec(
        `UPDATE matches SET ${key}=NULL,phase=?`,
        release ? 'armed' : 'outfitting',
      );
    } else {
      db.exec(`UPDATE matches SET ${key}=?`, time);
      db.exec(
        "UPDATE scheduled_events SET due=?,last_error='',last_error_utc=NULL WHERE id=?",
        time,
        node,
      );
    }
  } else {
    requireCommandArgument(
      commandArguments[0] === 'at' && time !== null && time > engine.now(),
      '请锁定未来的带时区绝对时间',
    );
    requireCommandArgument(
      release
        ? matchState.phase === 'setup' ||
            (matchState.phase === 'armed' && matchState.release_at === null)
        : matchState.phase === 'outfitting' && matchState.started_at === null,
      '当前不能锁定此节点',
    );
    const roster = db.roster();
    requireCommandArgument(roster.length >= 2, '至少需要两名正式玩家');
    for (const id of roster) {
      selectTargets(commandContext, id);
      const flight = db.flight(id);
      const homeworld = db.home(id);
      requireCommandArgument(
        release
          ? flight.status === 'staged' &&
              flight.departed !== null &&
              flight.staged !== null &&
              !flight.code_id &&
              homeworld?.status === 'verified'
          : flight.status === 'ready' &&
              flight.ready !== null &&
              !!flight.code_id &&
              !!db.one<Record<string, SqlStorageValue>>(
                "SELECT id FROM sighting_codes WHERE id=? AND player_id=? AND status='reserved'",
                flight.code_id,
                id,
              ),
        '正式玩家尚未完成准备：' + id,
      );
    }
    if (release) {
      requireCommandArgument(
        db.one<{n: number}>('SELECT COUNT(*) n FROM sighting_codes')!.n +
          roster.length <=
          350,
        '首航码容量不足',
      );
    }
    if (release) {
      db.exec(
        "INSERT OR IGNORE INTO settings(key,value) VALUES('parameters_frozen','true')",
      );
    }
    db.exec(
      `UPDATE matches SET ${key}=?,phase=?`,
      time,
      release ? 'armed' : 'start_countdown',
    );
    const previous = db.one<Scheduled>(
      'SELECT * FROM scheduled_events WHERE id=?',
      node,
    );
    if (previous) {
      requireCommandArgument(previous.status === 'cancelled', '原节点仍有效');
      saveCommandObject(
        commandContext,
        'node-history',
        {event: previous},
        'NODE',
      );
      db.exec(
        "UPDATE scheduled_events SET due=?,status='pending',committed_utc=NULL,last_error='',last_error_utc=NULL WHERE id=?",
        time,
        node,
      );
    } else {
      engine.schedule(node, node, 'utc', time, 0);
    }
    if (!release) {
      const oldPlan = db.one<SavedCommandObject>(
        "SELECT * FROM command_objects WHERE kind='start-plan' AND status='active' ORDER BY created_utc DESC LIMIT 1",
      );
      const existing = oldPlan
        ? (parseJson(oldPlan.data) as {roster: string[]; times: number[]})
        : null;
      let times: number[];
      if (existing && stableJson(existing.roster) === stableJson(roster)) {
        times = existing.times;
      } else if (
        !oldPlan &&
        db.one<Record<string, SqlStorageValue>>(
          "SELECT id FROM scheduled_events WHERE kind='tech_burst' AND id LIKE 'tech:%'",
        )
      ) {
        times = db
          .all<{due: number}>(
            "SELECT due FROM scheduled_events WHERE kind='tech_burst' AND id LIKE 'tech:%' ORDER BY due",
          )
          .map(r => r.due);
      } else {
        times = commandContext.preview
          ? techSchedulePreview(roster.length)
          : techSchedule(roster.length);
        if (oldPlan) {
          db.exec(
            "UPDATE command_objects SET status='superseded' WHERE id=?",
            oldPlan.id,
          );
        }
        db.exec(
          "UPDATE scheduled_events SET status='cancelled' WHERE kind='tech_burst' AND status='pending' AND (id LIKE 'tech:%' OR id LIKE 'plan-tech:%')",
        );
      }
      const planId =
        oldPlan &&
        existing &&
        stableJson(existing.roster) === stableJson(roster)
          ? oldPlan.id
          : saveCommandObject(
              commandContext,
              'start-plan',
              {roster, times},
              'START',
            );
      for (const [kind, due] of [
        ['apocalypse', TIMES.apocalypse],
        ['transfer_start', TIMES.transfer],
        ['hunt_cutoff', TIMES.cutoff],
        ['regulation_end', TIMES.end],
      ] as const) {
        if (
          !db.one<Record<string, SqlStorageValue>>(
            'SELECT id FROM scheduled_events WHERE id=?',
            kind,
          )
        ) {
          engine.schedule(kind, kind, 'game', due, 0);
        }
      }
      if (!existing || stableJson(existing.roster) !== stableJson(roster)) {
        if (
          !db.one<Record<string, SqlStorageValue>>(
            "SELECT id FROM scheduled_events WHERE kind='tech_burst' AND status='pending' AND id LIKE 'tech:%'",
          )
        ) {
          for (const [index, due] of times.entries()) {
            engine.schedule(
              `plan-tech:${planId}:${index}`,
              'tech_burst',
              'game',
              due,
              2,
            );
          }
        }
      }
      commandContext.notes.push(
        `技术爆炸${times.length}次；相同名单重新锁定保留原计划，名单变化生成新版本并保全旧版。UTC管理任务不会自动顺延。`,
      );
    }
  }
  const title = release ? '统一发码时间' : '统一开赛时间';
  const pending = db.all<{id: string}>(
    "SELECT id FROM notice_queue WHERE title=? AND status<>'sent'",
    title,
  );
  for (const row of pending) {
    db.exec(
      "UPDATE notice_queue SET error='安排已被替代，请使用最新通知',status='error',version=version+1 WHERE id=?",
      row.id,
    );
  }
  engine.notice(
    `judge:${commandContext.id}:${commandContext.work}`,
    'group',
    title,
    time === null
      ? `${title}已取消，新的时间将另行通知。`
      : `${title}：${new Date(time).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}（北京时间）。${release ? '' : `\n${START_COUNTDOWN_COPY}`}`,
  );
  recordChange(
    commandContext,
    title,
    old === null ? '未锁定' : new Date(old).toISOString(),
    time === null ? '已撤销，冻结仍有效' : new Date(time).toISOString(),
  );
  commandContext.notes.push(
    '节点到达后不可修改；已复制和已发送事实保留，请人工更正QQ公告。提交后重排Alarm。',
  );
}

function techSchedulePreview(n: number): number[] {
  const count = Math.min(
    Math.max(1, Math.round(n / 3)),
    Math.floor((n - 1) / 2),
  );
  return Array.from(
    {length: count},
    (_, i) => 480000 + (i + 1) * Math.floor(2820000 / (count + 1)),
  );
}
