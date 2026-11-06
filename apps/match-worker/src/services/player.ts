import type {Action, OperationResult} from '@darkforest/contracts';
import {
  coordinate,
  homeworldSubmission,
  nickname,
  strict,
} from '../../../../packages/contracts/src/backend';
import {firstSongDue, normalizeArms, TIMES, uniformInt} from '../domain/rules';
import {Fault, requireThat, type Actor, type CodeRow} from '../storage/store';
import {completed, type Engine, type PreparedCode} from './engine';
import {autoFinish, destroyHome, eliminate, logEvent, retire} from './life';
import {
  broadcastCopy,
  clearingCopy,
  reverseListeningCopy,
  shipDestroyedCopy,
  gameTimeCopy,
  messageDuration,
} from '../../../../packages/contracts/src/message_copy';

/** 计算当前玩家可用动作；页面显示只作提示，写接口必须重新判定。 */
export function allowedActions(engine: Engine, player: string): Action[] {
  if (engine.db.match().recovery_state) {
    return [];
  }
  const db = engine.db;
  const matchState = db.match();
  const playerState = db.player(player);
  const flight = db.flight(player);
  const homeworld = db.home(player);
  const now = engine.now();
  if (
    playerState.entry_status !== 'registered' ||
    flight.status === 'eliminated' ||
    matchState.phase === 'ended' ||
    matchState.paused_at !== null
  ) {
    return [];
  }
  const actions: Action[] = [];
  if (matchState.phase !== 'start_countdown') {
    actions.push('withdraw');
  }
  if (matchState.phase === 'setup') {
    if (!playerState.nickname) {
      return [...actions, 'nickname'];
    }
    if (flight.status === 'prelaunch') {
      if (homeworld?.status !== 'verified') {
        actions.push('homeworld-submit');
      } else if (flight.departed === null) {
        actions.push('preflight-depart');
      } else {
        actions.push('preflight-stage');
      }
    }
  }
  if (
    !db.one<Record<string, SqlStorageValue>>(
      'SELECT player_id FROM roster_members WHERE player_id=?',
      player,
    )
  ) {
    return matchState.phase === 'setup' ? actions : [];
  }
  if (matchState.phase === 'outfitting') {
    if (flight.status === 'staged') {
      actions.push('preflight-issue-code');
    }
    if (flight.status === 'outfitting') {
      actions.push('preflight-ready');
    }
  }
  if (flight.status === 'active') {
    const controls = db.one<{locked_until: number}>(
      'SELECT locked_until FROM attack_controls WHERE player_id=?',
      player,
    )!;
    const silent = db.one<Record<string, SqlStorageValue>>(
      'SELECT id FROM admin_effects WHERE active=1 AND starts<=? AND ends>? AND target IN (?,?)',
      now,
      now,
      '@a',
      player,
    );
    if (
      ['forest', 'apocalypse', 'hunt'].includes(matchState.phase) &&
      (matchState.phase !== 'hunt' || matchState.hunt_finalized !== null) &&
      controls.locked_until <= now &&
      !silent
    ) {
      actions.push('sighting');
    }
    if (matchState.phase === 'forest') {
      if (playerState.broadcasts < 2) {
        actions.push('broadcast');
      }
      if (playerState.tech && playerState.photons) {
        actions.push('photon');
      }
    }
  }
  if (
    matchState.phase === 'forest' &&
    homeworld?.status === 'verified' &&
    homeworld.destroyed_game === null &&
    flight.deadline !== null &&
    engine.game() < Math.min(flight.deadline, TIMES.apocalypse)
  ) {
    if (flight.status === 'returning') {
      actions.push('return-confirm');
    }
    if (flight.status === 'preparing') {
      actions.push('issue-code');
    }
    if (flight.status === 'issued') {
      actions.push('launch');
    }
  }
  return actions;
}
/** 在本场事务中执行玩家行动，复核身份、阶段、资源和目标合法性。 */
export function playerAction(
  engine: Engine,
  actor: Actor,
  id: string,
  path: string,
  raw: Record<string, unknown>,
  prepared: PreparedCode[],
  edgeUtc: number,
  keys: Awaited<ReturnType<Engine['keys']>>,
): OperationResult {
  requireThat(actor.role === 'player', 'FORBIDDEN', '请使用参赛账号。', 403);
  const action =
    path === '/player/nickname' ? 'nickname' : path.slice('/action/'.length);
  const db = engine.db;
  const now = engine.now();
  const game = engine.game(now);
  const matchState = db.match();
  const playerState = db.player(actor.id);
  const flight = db.flight(actor.id);
  const home = db.home(actor.id);
  // Format validation precedes eligibility, rate accounting, and random penalties.
  if (action === 'sighting') {
    strict(raw, ['request_id', 'arm_a', 'arm_b']);
    normalizeArms(raw.arm_a, raw.arm_b);
  } else if (action === 'homeworld-submit') {
    homeworldSubmission(raw);
  } else if (['broadcast', 'photon'].includes(action)) {
    strict(raw, ['request_id', 'code']);
    coordinate(raw.code);
  } else if (action === 'nickname') {
    strict(raw, ['request_id', 'nickname']);
    nickname(raw.nickname);
  } else {
    strict(raw, ['request_id']);
  }
  requireThat(
    allowedActions(engine, actor.id).includes(action as Action),
    'ACTION_UNAVAILABLE',
    '当前状态不能执行这项操作，请刷新后查看。',
  );
  const eventId = `action:${actor.id}:${id}`;
  let result: OperationResult;
  switch (action) {
    case 'nickname': {
      const name = nickname(raw.nickname);
      requireThat(
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM players WHERE nickname=?',
          name,
        ),
        'NICKNAME_TAKEN',
        '这个昵称已被使用。',
      );
      db.exec(
        'UPDATE players SET nickname=? WHERE id=? AND nickname IS NULL',
        name,
        actor.id,
      );
      result = completed(id, '昵称已确认');
      break;
    }
    case 'homeworld-submit': {
      const code = coordinate(raw.code);
      db.exec(
        "INSERT INTO homeworlds(player_id,code,status,version) VALUES(?,?,'pending',1) ON CONFLICT(player_id) DO UPDATE SET code=excluded.code,status='pending',version=version+1,rejection='',verified_by=NULL",
        actor.id,
        code,
      );
      result = completed(
        id,
        '母星登记已提交',
        '请复制消息，附上时间水印照片后发送给裁判。',
      );
      break;
    }
    case 'preflight-depart':
      db.exec('UPDATE flights SET departed=? WHERE player_id=?', now, actor.id);
      result = completed(id, '已确认离开母星');
      break;
    case 'preflight-stage':
      db.exec(
        "UPDATE flights SET status='staged',staged=? WHERE player_id=?",
        now,
        actor.id,
      );
      result = completed(id, '准备完成', '等待统一发码。');
      break;
    case 'preflight-issue-code': {
      engine.issue(actor.id, id, prepared);
      db.exec(
        "UPDATE flights SET status='outfitting' WHERE player_id=?",
        actor.id,
      );
      result = completed(id, '配置已领取', '请在安全位置按图示佩戴手环。');
      break;
    }
    case 'preflight-ready':
      db.exec(
        "UPDATE flights SET status='ready',ready=? WHERE player_id=?",
        now,
        actor.id,
      );
      result = completed(id, '穿戴就绪', '等待统一开赛。');
      break;
    case 'return-confirm':
      db.exec(
        "UPDATE flights SET status='preparing' WHERE player_id=?",
        actor.id,
      );
      result = completed(id, '已确认返航', '离开母星50米后领取新配置。');
      break;
    case 'issue-code':
      engine.issue(actor.id, id, prepared);
      db.exec("UPDATE flights SET status='issued' WHERE player_id=?", actor.id);
      result = completed(id, '新配置已领取', '请在安全位置按图示佩戴手环。');
      break;
    case 'launch': {
      requireThat(
        flight.code_id &&
          db.all<Record<string, SqlStorageValue>>(
            "UPDATE sighting_codes SET status='active',activated_utc=?,activated_game=? WHERE id=? AND status='reserved' RETURNING id",
            now,
            game,
            flight.code_id,
          ).length === 1,
        'CODE_NOT_RESERVED',
        '请重新核对当前配置。',
      );
      db.exec(
        "UPDATE flights SET status='active',deadline=NULL WHERE player_id=?",
        actor.id,
      );
      db.exec(
        "UPDATE scheduled_events SET status='cancelled' WHERE kind='respawn_timeout' AND status='pending' AND json_extract(payload,'$.player')=?",
        actor.id,
      );
      logEvent(
        engine,
        eventId,
        'respawn',
        '完成出航',
        `${engine.identity(actor.id)}已完成出航。`,
        'personal',
        [actor.id],
        game,
        now,
        actor.id,
      );
      result = completed(id, '已完成出航');
      break;
    }
    case 'withdraw': {
      if (matchState.start_settled) {
        eliminate(engine, actor.id, 'withdrawn', eventId, game, now);
      } else {
        retire(engine, actor.id, 'withdrawn', game, now);
        db.exec(
          "UPDATE players SET entry_status='withdrawn' WHERE id=?",
          actor.id,
        );
        db.exec('DELETE FROM roster_members WHERE player_id=?', actor.id);
      }
      result = completed(id, '已退出比赛');
      autoFinish(engine, game, now, eventId);
      break;
    }
    case 'sighting': {
      const params = db.parameters();
      const control = db.one<{
        last_at: number | null;
        attempts: number;
        wrong: number;
        locked_until: number;
      }>('SELECT * FROM attack_controls WHERE player_id=?', actor.id)!;
      const count = db.one<{count: number}>(
        'SELECT COUNT(*) AS count FROM attacks WHERE actor=? AND committed_utc>?',
        actor.id,
        now - 60_000,
      )!.count;
      requireThat(
        (control.last_at === null ||
          now - control.last_at >= params.sightingIntervalMs) &&
          count < params.sightingsPerMinute,
        'SIGHTING_THROTTLED',
        '提交过于频繁，请稍后再试。',
        429,
      );
      const key = normalizeArms(raw.arm_a, raw.arm_b);
      const attempted = keys.codes.find(c => c.key === key)!;
      const code = db.one<CodeRow>(
        'SELECT * FROM sighting_codes WHERE mac=?',
        attempted.mac,
      );
      const before = {
        wrong: control.wrong,
        lockedUntil: control.locked_until,
        actorHomeDestroyed: home?.destroyed_game ?? null,
        actorHomeSource: home?.source ?? null,
        actorVoyage: flight.voyage,
      };
      let classification = !code
        ? 'unknown_code'
        : code.player_id === actor.id
          ? 'self_code'
          : code.status === 'retired'
            ? 'retired_code'
            : code.status === 'reserved'
              ? 'reserved_code'
              : 'hit';
      let roll: number | null = null;
      let wrong = control.wrong;
      let locked = control.locked_until;
      let target: string | null = null;
      if (
        classification === 'retired_code' &&
        code &&
        code.retired_reason === 'hit' &&
        code.activated_utc !== null &&
        code.retired_utc !== null &&
        edgeUtc >= code.activated_utc &&
        edgeUtc <= code.retired_utc &&
        code.retired_utc - edgeUtc <= 500 &&
        db.one<Record<string, SqlStorageValue>>(
          "SELECT id FROM attacks WHERE code_id=? AND classification='hit' AND valid=1",
          code.id,
        )
      ) {
        classification = 'lost_race';
      }
      if (classification === 'hit' && code) {
        target = code.player_id;
        const targetFlight = db.flight(target);
        const targetHome = db.home(target);
        requireThat(
          targetFlight.status === 'active' &&
            targetFlight.code_id === code.id &&
            db.player(target).entry_status === 'registered',
          'TARGET_STATE_CONFLICT',
          '请稍后重试。',
        );
        const canRespawn =
          matchState.phase === 'forest' &&
          targetHome?.status === 'verified' &&
          targetHome.destroyed_game === null;
        requireThat(
          db.all<Record<string, SqlStorageValue>>(
            "UPDATE flights SET status=?,code_id=NULL,deadline=? WHERE player_id=? AND status='active' AND code_id=? RETURNING player_id",
            canRespawn ? 'returning' : 'active',
            canRespawn ? game + params.respawnSeconds * 1000 : null,
            target,
            code.id,
          ).length === 1,
          'TARGET_STATE_CONFLICT',
          '请稍后重试。',
        );
        requireThat(
          db.all<Record<string, SqlStorageValue>>(
            "UPDATE sighting_codes SET status='retired',retired_game=?,retired_utc=?,retired_reason='hit' WHERE id=? AND status='active' RETURNING id",
            game,
            now,
            code.id,
          ).length === 1,
          'TARGET_STATE_CONFLICT',
          '请稍后重试。',
        );
        if (canRespawn) {
          engine.schedule(
            `respawn:${target}:${code.id}`,
            'respawn_timeout',
            'game',
            game + params.respawnSeconds * 1000,
            1,
            {player: target, deadline: game + params.respawnSeconds * 1000},
          );
        } else {
          eliminate(engine, target, 'sighting', eventId, game, now);
        }
        if (targetHome) {
          db.exec(
            'INSERT OR IGNORE INTO intel_grants(id,owner,target,code,source,game_ms) VALUES(?,?,?,?,?,?)',
            `${eventId}:intel`,
            actor.id,
            target,
            targetHome.code,
            eventId,
            game,
          );
        }
        logEvent(
          engine,
          eventId,
          'sighting',
          '目击成功',
          `${engine.identity(actor.id)}击毁了${engine.identity(target)}的飞船。`,
          'personal',
          [actor.id, target],
          game,
          now,
          actor.id,
        );
        engine.notice(
          eventId,
          target,
          '飞船被击毁',
          shipDestroyedCopy(engine.identity(target)) +
            (canRespawn
              ? `\n请在比赛时间${gameTimeCopy(Math.min(game + params.respawnSeconds * 1000, TIMES.apocalypse))}前完成重生。`
              : ''),
          game,
        );
      } else if (['reserved_code', 'unknown_code'].includes(classification)) {
        wrong++;
        if (wrong === 2) {
          roll = uniformInt(100);
        }
        if (wrong >= 3 || (wrong === 2 && roll! < params.secondOutPercent)) {
          if (home?.destroyed_game === null) {
            db.exec(
              'UPDATE homeworlds SET destroyed_game=?,source=? WHERE player_id=?',
              game,
              eventId,
              actor.id,
            );
          }
          eliminate(
            engine,
            actor.id,
            'wrong_attack_direct_out',
            eventId,
            game,
            now,
          );
        } else {
          locked =
            now +
            (wrong === 1 ? params.firstLockSeconds : params.secondLockSeconds) *
              1000;
        }
      }
      db.exec(
        'UPDATE attack_controls SET wrong=?,locked_until=?,last_at=?,attempts=attempts+1 WHERE player_id=?',
        wrong,
        locked,
        now,
        actor.id,
      );
      db.exec(
        'INSERT INTO attacks(id,actor,target,code_id,request_id,classification,roll,wrong_index,edge_utc,committed_utc,game_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        `${eventId}:attack`,
        actor.id,
        target,
        code?.id ?? null,
        id,
        classification,
        roll,
        wrong > control.wrong ? wrong : null,
        edgeUtc,
        now,
        game,
      );
      db.exec(
        'UPDATE attacks SET before_json=? WHERE id=?',
        JSON.stringify(before),
        `${eventId}:attack`,
      );
      const eliminated = db.flight(actor.id).status === 'eliminated';
      const mismatch = wrong > control.wrong;
      const missedTitle = mismatch
        ? eliminated
          ? '直接出局'
          : '禁止攻击'
        : '本次目击未产生击毁';
      const missedBody = mismatch
        ? eliminated
          ? `文明${engine.identity(actor.id)}，本次提交的手环颜色有误，你已永久淘汰。\n请在安全位置摘下全部比赛手环，返回中控室，查看官网上的宇宙观测开放时间。`
          : `文明${engine.identity(actor.id)}，本次提交的手环颜色有误。\n累计错误：${wrong}次。禁止目击攻击：${messageDuration((locked - now) / 1000)}。\n恢复攻击时间：${new Date(locked).toLocaleTimeString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false})}。\n再次提交错误颜色的处罚：${wrong === 1 ? `${params.secondOutPercent}%概率永久淘汰，${100 - params.secondOutPercent}%概率禁止目击攻击${messageDuration(params.secondLockSeconds)}` : '永久淘汰'}。`
        : '本次目击未产生击毁。';
      if (!target) {
        logEvent(
          engine,
          eventId,
          'sighting',
          missedTitle,
          missedBody,
          'personal',
          [actor.id],
          game,
          now,
          actor.id,
        );
      } else {
        logEvent(
          engine,
          `${eventId}:target`,
          'sighting',
          '飞船被击毁',
          shipDestroyedCopy(engine.identity(target)),
          'personal',
          [target],
          game,
          now,
          target,
        );
      }
      if (control.attempts === 120) {
        engine.notice(
          `sighting-threshold:${actor.id}`,
          'J01',
          '目击提交次数提醒',
          `${engine.identity(actor.id)}本场已提交121次目击，请复核。`,
          game,
        );
      }
      const intel =
        target && db.home(target)
          ? {
              id: `${eventId}:intel`,
              civilization: target,
              nickname: db.player(target).nickname ?? '',
              code: db.home(target)!.code,
              gameMs: game,
              source: '击毁飞船',
            }
          : undefined;
      result = completed(
        id,
        target ? '目击成功' : missedTitle,
        target
          ? '目标飞船已被击毁，母星情报已保存。'
          : missedBody.replace(`文明${engine.identity(actor.id)}，`, ''),
        {
          outcome: {
            wrongCount: wrong,
            lockedUntilUtcMs: locked,
            eliminated,
            ...(target ? {target} : {}),
            ...(intel ? {intel} : {}),
          },
        },
      );
      autoFinish(engine, game, now, eventId);
      break;
    }
    case 'broadcast': {
      const code = coordinate(raw.code);
      requireThat(
        !db.one<Record<string, SqlStorageValue>>(
          'SELECT id FROM broadcasts WHERE code=?',
          code,
        ),
        'ALREADY_BROADCAST',
        '这个坐标已经正式广播。',
      );
      const probability = db.parameters().singerPercent;
      const songDue = firstSongDue(game, uniformInt, probability);
      logEvent(
        engine,
        eventId,
        'broadcast',
        '坐标广播',
        broadcastCopy(engine.identity(actor.id), code),
        'public',
        [actor.id],
        game,
        now,
        null,
        code,
        actor.id,
      );
      db.exec(
        'INSERT INTO broadcasts VALUES(?,?,?,?,?)',
        eventId,
        actor.id,
        code,
        songDue,
        songDue === null ? 'not_selected' : 'pending',
      );
      db.exec(
        'UPDATE players SET broadcasts=broadcasts+1 WHERE id=?',
        actor.id,
      );
      if (songDue !== null) {
        engine.schedule(`song:${eventId}`, 'song_visit', 'game', songDue, 2, {
          code,
          broadcast: eventId,
        });
      }
      const target = db.officialHome(code);
      if (target && home) {
        db.exec(
          'INSERT INTO intel_grants VALUES(?,?,?,?,?,?)',
          `${eventId}:reverse`,
          target.player_id,
          actor.id,
          home.code,
          eventId,
          game,
        );
        engine.notice(
          eventId,
          target.player_id,
          '你被广播了',
          reverseListeningCopy(
            engine.identity(target.player_id),
            code,
            engine.identity(actor.id),
            home.code,
          ),
          game,
        );
      }
      engine.notice(
        eventId,
        'group',
        '坐标广播',
        broadcastCopy(engine.identity(actor.id), code),
        game,
      );
      result = completed(id, '广播已发布', `坐标${code}已暴露给全宇宙。`, {
        outcome: {
          accepted: true,
          eventId,
          remaining: 1 - playerState.broadcasts,
        },
      });
      break;
    }
    case 'photon': {
      const code = coordinate(raw.code);
      const target = db.officialHome(code, true);
      const hit = target
        ? destroyHome(engine, target.player_id, eventId, game, now)
        : false;
      const body = clearingCopy(
        'photon',
        code,
        hit ? engine.identity(target!.player_id) : undefined,
      );
      const title = hit ? '光粒命中' : '光粒清理';
      logEvent(
        engine,
        eventId,
        'photon',
        title,
        body,
        'public',
        hit ? [target!.player_id] : [],
        game,
        now,
        null,
        code,
        actor.id,
      );
      db.exec(
        'INSERT INTO photon_shots VALUES(?,?,?,?)',
        eventId,
        actor.id,
        code,
        hit ? target!.player_id : null,
      );
      db.exec('UPDATE players SET photons=0 WHERE id=?', actor.id);
      engine.notice(eventId, 'group', title, body, game);
      result = completed(id, '光粒已发射', body, {
        outcome: {accepted: true, eventId, remaining: 0},
      });
      autoFinish(engine, game, now, eventId);
      break;
    }
    default:
      throw new Fault(404, 'NOT_FOUND', '未找到这项操作。');
  }
  engine.audit(actor.id, path, actor.id, '玩家操作', {requestId: id});
  db.bump();
  result.revision = db.match().revision;
  return result;
}
