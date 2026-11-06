import {
  coordinate,
  parseJson,
} from '../../../../packages/contracts/src/backend';
import {
  commandSpec,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {clearingCopy} from '../../../../packages/contracts/src/message_copy';
import {dueUtc, settleDue} from '../scheduler/events';
import {Fault, permission, requireThat, type Scheduled} from '../storage/store';
import type {CommandContext} from './command_context';
import {handlePlayerAction} from './command_player_actions';
import {
  requireLivingTarget,
  validateCommandArguments,
  recordChange,
  recordDependency,
  requireForestPhase,
  requireHeadJudge,
  invokeJudgeAction,
  requireCommandArgument,
  commandObject,
  recordPopulationDependency,
  saveCommandObject,
  selectTargets,
  recordTableDependency,
  updateCommandObject,
  commandValue,
} from './command_context';
import {destroyHome, logEvent} from './life';

/** Execute event commands inside the caller's existing preview or commit transaction. */
export function handleEventAction(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  const spec = commandSpec(commandNode)!;

  permission(commandContext.actor, spec.permission);

  validateCommandArguments(commandNode);

  const engine = commandContext.engine;

  const db = engine.db;

  const matchState = db.match();

  const path = spec.path;

  const commandArguments = commandNode.words
    .slice(path.split(' ').length)
    .map(v => commandValue(v, commandContext));

  const source = `judge:${commandContext.actor.id}:${commandContext.id}:${commandContext.work}`;

  if (path === 'event retry' || path === 'event cancel') {
    requireHeadJudge(commandContext);
    recordTableDependency(commandContext, 'scheduled_events');
    const event = db.one<Scheduled>(
      'SELECT * FROM scheduled_events WHERE id=?',
      commandArguments[0]!,
    );
    requireCommandArgument(event, '事件不存在');
    if (path.endsWith('cancel')) {
      requireThat(
        matchState.paused_at !== null,
        'PAUSE_REQUIRED',
        '请先暂停比赛后核对要取消的事件。',
      );
      requireCommandArgument(
        event.status === 'pending' &&
          [
            'song_visit',
            'tech_burst',
            'judge_delayed_command',
            'judge_command_task',
          ].includes(event.kind),
        '阶段节点和重生超时不能通用取消',
      );
      db.exec(
        "UPDATE scheduled_events SET status='cancelled' WHERE id=?",
        event.id,
      );
      if (event.kind === 'judge_command_task') {
        db.exec(
          "UPDATE command_objects SET status='cancelled' WHERE id=?",
          event.id,
        );
      }
      recordChange(commandContext, event.id, 'pending', 'cancelled');
      return;
    }
    requireCommandArgument(event.status !== 'cancelled', '已取消事件不能重开');
    const utc = dueUtc(engine, event);
    requireCommandArgument(
      event.status === 'settled' || (utc !== null && utc <= engine.now()),
      '事件尚未到期',
    );
    if (event.status !== 'settled') {
      settleDue(engine);
      recordChange(commandContext, event.id, event.status, 'settled');
    } else {
      commandContext.notes.push('事件已经结算，返回原结算事实，不重新执行。');
    }
    return {
      event: db.one<Record<string, SqlStorageValue>>(
        'SELECT id,kind,clock,due,status,committed_utc,attempt_count,last_error FROM scheduled_events WHERE id=?',
        event.id,
      ),
      outcome:
        db.one<Record<string, SqlStorageValue>>(
          'SELECT id,kind,title,body,game_ms,utc_ms FROM event_log WHERE id=?',
          event.id,
        ) ?? null,
    };
  }

  if (path === 'event trigger singer') {
    requireHeadJudge(commandContext);
    requireForestPhase(commandContext);
    recordPopulationDependency(commandContext);
    const code = coordinate(commandArguments[0]);
    const home = db.officialHome(code, true);
    if (home) {
      selectTargets(commandContext, home.player_id);
      destroyHome(engine, home.player_id, source, engine.game(), engine.now());
    }
    logEvent(
      engine,
      source,
      'singer',
      '歌者清理',
      clearingCopy(
        'singer',
        code,
        home ? engine.identity(home.player_id) : undefined,
      ),
      'public',
      home ? [home.player_id] : [],
      engine.game(),
      engine.now(),
      null,
      code,
    );
    engine.notice(
      source,
      'group',
      '歌者清理',
      clearingCopy(
        'singer',
        code,
        home ? engine.identity(home.player_id) : undefined,
      ),
    );
    recordChange(commandContext, code, '未清理', '新增管理清理，不消耗原计划');
    return;
  }

  if (path === 'event trigger tech-burst') {
    requireHeadJudge(commandContext);
    requireForestPhase(commandContext);
    const v =
      commandArguments[0] ??
      '@alive[homeworld=alive,tech=0,sort=random,limit=1]';
    return handlePlayerAction(commandContext, {
      words: ['tech', 'grant', v],
      options: {},
    });
  }

  if (path === 'scheduler rearm') {
    requireHeadJudge(commandContext);
    recordChange(commandContext, 'Alarm', '原排程', '提交后按最新版本重排');
    return;
  }

  if (path === 'scheduler settle-due') {
    requireHeadJudge(commandContext);
    settleDue(engine);
    recordChange(commandContext, '事件积压', '待补结算', '已按顺序补结算');
    return;
  }

  if (path.startsWith('hunt draft ')) {
    requireHeadJudge(commandContext);
    requireCommandArgument(
      matchState.phase === 'hunt' &&
        matchState.pause_reason === 'hunt_review' &&
        matchState.hunt_finalized === null,
      '当前不在终局核验窗口',
    );
    if (path.endsWith('create')) {
      const id = saveCommandObject(
        commandContext,
        'hunt',
        {eliminations: []},
        'HD',
      );
      recordChange(commandContext, id, '无', '空核验草稿');
      return id;
    }
    const row = commandObject(engine, commandArguments[0]!, 'hunt');
    const data = parseJson(row.data) as {
      eliminations: Array<{id: string; reason: string}>;
    };
    const ids = selectTargets(commandContext, commandArguments[1]!);
    if (path.endsWith('set')) {
      requireCommandArgument(
        ['no_share_at_cutoff', 'outside_at_cutoff'].includes(
          commandArguments[2]!,
        ),
        '未知截止原因',
      );
      for (const id of ids) {
        requireLivingTarget(commandContext, id);
      }
    }
    data.eliminations = data.eliminations.filter(p => !ids.includes(p.id));
    if (path.endsWith('set')) {
      data.eliminations.push(
        ...ids.map(id => ({id, reason: commandArguments[2]!})),
      );
    }
    updateCommandObject(commandContext, row, data);
    recordChange(commandContext, row.id, '原草稿', data);
    return;
  }

  if (path === 'hunt finalize') {
    requireHeadJudge(commandContext);
    recordPopulationDependency(commandContext);
    const row = commandObject(engine, commandArguments[0]!, 'hunt');
    recordDependency(commandContext, 'object:' + row.id, row);
    invokeJudgeAction(
      commandContext,
      '/judge/hunt-finalize',
      parseJson(row.data) as Record<string, unknown>,
    );
    updateCommandObject(commandContext, row, parseJson(row.data), 'complete');
    return;
  }

  if (path === 'case open') {
    requireHeadJudge(commandContext);
    requireCommandArgument(
      (commandArguments.length === 3 && commandArguments[1] === 'note') ||
        (commandArguments.length === 5 &&
          commandArguments[1] === 'ref' &&
          commandArguments[3] === 'note'),
      '用法：case open 类型 [ref ID] note "说明"',
    );
    const id = saveCommandObject(
      commandContext,
      'case',
      {
        kind: commandArguments[0],
        evidence: [
          {
            ref: commandArguments.length === 5 ? commandArguments[2] : null,
            note: commandArguments.at(-1),
          },
        ],
      },
      'CASE',
    );
    recordChange(commandContext, id, '无', '已建个案');
    return id;
  }

  throw new Fault(400, 'UNKNOWN_COMMAND', '命令没有执行处理器：' + path);
}
