import type { Action, OperationResult } from '@darkforest/contracts';
import {
  coordinate,
  homeworldSubmission,
  nickname,
  strict,
} from '../../../../packages/contracts/src/backend';
import { firstSongDue, normalizeArms, TIMES, uniformInt } from '../domain/rules';
import { Fault, requireThat, type Actor, type CodeRow } from '../storage/store';
import { completed, type Engine, type PreparedCode } from './engine';
import { autoFinish, destroyHome, eliminate, logEvent, retire } from './life';

export function allowedActions(e: Engine, player: string): Action[] {
  if (e.db.match().recovery_state) return [];
  const db = e.db,
    m = db.match(),
    p = db.player(player),
    f = db.flight(player),
    h = db.home(player),
    now = e.now();
  if (
    p.entry_status !== 'registered' ||
    f.status === 'eliminated' ||
    m.phase === 'ended' ||
    m.paused_at !== null
  )
    return [];
  const actions: Action[] = [];
  if (m.phase !== 'start_countdown') actions.push('withdraw');
  if (m.phase === 'setup') {
    if (!p.nickname) return [...actions, 'nickname'];
    if (f.status === 'prelaunch') {
      if (h?.status !== 'verified') actions.push('homeworld-submit');
      else if (f.departed === null) actions.push('preflight-depart');
      else actions.push('preflight-stage');
    }
  }
  if (!db.one('SELECT player_id FROM roster_members WHERE player_id=?', player))
    return m.phase === 'setup' ? actions : [];
  if (m.phase === 'outfitting') {
    if (f.status === 'staged') actions.push('preflight-issue-code');
    if (f.status === 'outfitting') actions.push('preflight-ready');
  }
  if (f.status === 'active') {
    const controls = db.one<{ locked_until: number }>(
      'SELECT locked_until FROM attack_controls WHERE player_id=?',
      player,
    )!;
    const silent = db.one(
      'SELECT id FROM admin_effects WHERE active=1 AND starts<=? AND ends>? AND target IN (?,?)',
      now,
      now,
      '@a',
      player,
    );
    if (
      ['forest', 'apocalypse', 'hunt'].includes(m.phase) &&
      (m.phase !== 'hunt' || m.hunt_finalized !== null) &&
      controls.locked_until <= now &&
      !silent
    )
      actions.push('sighting');
    if (m.phase === 'forest') {
      if (p.broadcasts < 2) actions.push('broadcast');
      if (p.tech && p.photons) actions.push('photon');
    }
  }
  if (
    m.phase === 'forest' &&
    h?.status === 'verified' &&
    h.destroyed_game === null &&
    f.deadline !== null &&
    e.game() < Math.min(f.deadline, TIMES.apocalypse)
  ) {
    if (f.status === 'returning') actions.push('return-confirm');
    if (f.status === 'preparing') actions.push('issue-code');
    if (f.status === 'issued') actions.push('launch');
  }
  return actions;
}
export function playerAction(
  e: Engine,
  actor: Actor,
  id: string,
  path: string,
  raw: Record<string, unknown>,
  prepared: PreparedCode[],
  edgeUtc: number,
  keys: Awaited<ReturnType<Engine['keys']>>,
): OperationResult {
  requireThat(actor.role === 'player', 'FORBIDDEN', '请使用参赛账号。', 403);
  const action = path === '/player/nickname' ? 'nickname' : path.slice('/action/'.length);
  const db = e.db,
    now = e.now(),
    game = e.game(now),
    m = db.match(),
    p = db.player(actor.id),
    f = db.flight(actor.id),
    home = db.home(actor.id);
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
  } else strict(raw, ['request_id']);
  requireThat(
    allowedActions(e, actor.id).includes(action as Action),
    'ACTION_UNAVAILABLE',
    '当前状态不能执行这项操作，请刷新后查看。',
  );
  const eventId = `action:${actor.id}:${id}`;
  let result: OperationResult;
  switch (action) {
    case 'nickname': {
      const name = nickname(raw.nickname);
      requireThat(
        !db.one('SELECT id FROM players WHERE nickname=?', name),
        'NICKNAME_TAKEN',
        '这个昵称已被使用。',
      );
      db.exec('UPDATE players SET nickname=? WHERE id=? AND nickname IS NULL', name, actor.id);
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
      result = completed(id, '母星登记已提交', '请复制消息，附上时间水印照片后发送给裁判。');
      break;
    }
    case 'preflight-depart':
      db.exec('UPDATE flights SET departed=? WHERE player_id=?', now, actor.id);
      result = completed(id, '已确认离开母星');
      break;
    case 'preflight-stage':
      db.exec("UPDATE flights SET status='staged',staged=? WHERE player_id=?", now, actor.id);
      result = completed(id, '准备完成', '等待统一发码。');
      break;
    case 'preflight-issue-code': {
      e.issue(actor.id, id, prepared);
      db.exec("UPDATE flights SET status='outfitting' WHERE player_id=?", actor.id);
      result = completed(id, '配置已领取', '请在安全位置按图示佩戴手环。');
      break;
    }
    case 'preflight-ready':
      db.exec("UPDATE flights SET status='ready',ready=? WHERE player_id=?", now, actor.id);
      result = completed(id, '穿戴就绪', '等待统一开赛。');
      break;
    case 'return-confirm':
      db.exec("UPDATE flights SET status='preparing' WHERE player_id=?", actor.id);
      result = completed(id, '已确认返航', '离开母星50米后领取新配置。');
      break;
    case 'issue-code':
      e.issue(actor.id, id, prepared);
      db.exec("UPDATE flights SET status='issued' WHERE player_id=?", actor.id);
      result = completed(id, '新配置已领取', '请在安全位置按图示佩戴手环。');
      break;
    case 'launch': {
      requireThat(
        f.code_id &&
          db.all(
            "UPDATE sighting_codes SET status='active',activated_utc=?,activated_game=? WHERE id=? AND status='reserved' RETURNING id",
            now,
            game,
            f.code_id,
          ).length === 1,
        'CODE_NOT_RESERVED',
        '请重新核对当前配置。',
      );
      db.exec("UPDATE flights SET status='active',deadline=NULL WHERE player_id=?", actor.id);
      db.exec(
        "UPDATE scheduled_events SET status='cancelled' WHERE kind='respawn_timeout' AND status='pending' AND json_extract(payload,'$.player')=?",
        actor.id,
      );
      logEvent(
        e,
        eventId,
        'respawn',
        '完成出航',
        `${e.identity(actor.id)}已完成出航。`,
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
      if (m.start_settled) eliminate(e, actor.id, 'withdrawn', eventId, game, now);
      else {
        retire(e, actor.id, 'withdrawn', game, now);
        db.exec("UPDATE players SET entry_status='withdrawn' WHERE id=?", actor.id);
        db.exec('DELETE FROM roster_members WHERE player_id=?', actor.id);
      }
      result = completed(id, '已退出比赛');
      autoFinish(e, game, now, eventId);
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
      const count = db.one<{ count: number }>(
        'SELECT COUNT(*) AS count FROM attacks WHERE actor=? AND committed_utc>?',
        actor.id,
        now - 60_000,
      )!.count;
      requireThat(
        (control.last_at === null || now - control.last_at >= params.sightingIntervalMs) &&
          count < params.sightingsPerMinute,
        'SIGHTING_THROTTLED',
        '提交过于频繁，请稍后再试。',
        429,
      );
      const key = normalizeArms(raw.arm_a, raw.arm_b),
        attempted = keys.codes.find((c) => c.key === key)!;
      const code = db.one<CodeRow>('SELECT * FROM sighting_codes WHERE mac=?', attempted.mac);
      const before = {
        wrong: control.wrong,
        lockedUntil: control.locked_until,
        actorHomeDestroyed: home?.destroyed_game ?? null,
        actorHomeSource: home?.source ?? null,
        actorVoyage: f.voyage,
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
      let roll: number | null = null,
        wrong = control.wrong,
        locked = control.locked_until;
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
        db.one(
          "SELECT id FROM attacks WHERE code_id=? AND classification='hit' AND valid=1",
          code.id,
        )
      )
        classification = 'lost_race';
      if (classification === 'hit' && code) {
        target = code.player_id;
        const targetFlight = db.flight(target),
          targetHome = db.home(target);
        requireThat(
          targetFlight.status === 'active' &&
            targetFlight.code_id === code.id &&
            db.player(target).entry_status === 'registered',
          'TARGET_STATE_CONFLICT',
          '请稍后重试。',
        );
        const canRespawn =
          m.phase === 'forest' &&
          targetHome?.status === 'verified' &&
          targetHome.destroyed_game === null;
        requireThat(
          db.all(
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
          db.all(
            "UPDATE sighting_codes SET status='retired',retired_game=?,retired_utc=?,retired_reason='hit' WHERE id=? AND status='active' RETURNING id",
            game,
            now,
            code.id,
          ).length === 1,
          'TARGET_STATE_CONFLICT',
          '请稍后重试。',
        );
        if (canRespawn)
          e.schedule(
            `respawn:${target}:${code.id}`,
            'respawn_timeout',
            'game',
            game + params.respawnSeconds * 1000,
            1,
            { player: target, deadline: game + params.respawnSeconds * 1000 },
          );
        else eliminate(e, target, 'sighting', eventId, game, now);
        if (targetHome)
          db.exec(
            'INSERT OR IGNORE INTO intel_grants(id,owner,target,code,source,game_ms) VALUES(?,?,?,?,?,?)',
            `${eventId}:intel`,
            actor.id,
            target,
            targetHome.code,
            eventId,
            game,
          );
        logEvent(
          e,
          eventId,
          'sighting',
          '目击成功',
          `${e.identity(actor.id)}击毁了${e.identity(target)}的飞船。`,
          'personal',
          [actor.id, target],
          game,
          now,
          actor.id,
        );
        e.notice(
          eventId,
          target,
          '飞船被击毁',
          canRespawn
            ? '你的飞船被击毁。请在安全位置摘下全部手环，在个人页面查看返航期限。'
            : '你的飞船被击毁，已永久淘汰。请摘下手环并返回中控室。',
          game,
        );
      } else if (['reserved_code', 'unknown_code'].includes(classification)) {
        wrong++;
        if (wrong === 2) roll = uniformInt(100);
        if (wrong >= 3 || (wrong === 2 && roll! < params.secondOutPercent)) {
          if (home?.destroyed_game === null)
            db.exec(
              'UPDATE homeworlds SET destroyed_game=?,source=? WHERE player_id=?',
              game,
              eventId,
              actor.id,
            );
          eliminate(e, actor.id, 'wrong_attack_direct_out', eventId, game, now);
        } else
          locked = now + (wrong === 1 ? params.firstLockSeconds : params.secondLockSeconds) * 1000;
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
      if (!target)
        logEvent(
          e,
          eventId,
          'sighting',
          '本次目击未产生击毁',
          '本次目击未产生击毁。请在当前页查看提交错误的目击码次数及攻击限制。',
          'personal',
          [actor.id],
          game,
          now,
          actor.id,
        );
      else
        logEvent(
          e,
          `${eventId}:target`,
          'sighting',
          '飞船被击毁',
          '你的飞船已被击毁，请在当前页查看返航或淘汰安排。',
          'personal',
          [target],
          game,
          now,
          target,
        );
      if (control.attempts === 120)
        e.notice(
          `sighting-threshold:${actor.id}`,
          'J01',
          '目击提交次数提醒',
          `${e.identity(actor.id)}本场已提交121次目击，请复核。`,
          game,
        );
      const intel =
        target && db.home(target)
          ? {
              id: `${eventId}:intel`,
              civilization: target,
              nickname: db.player(target).nickname ?? '',
              code: db.home(target)!.code,
              gameMs: game,
              source: '目击成功',
            }
          : undefined;
      result = completed(
        id,
        target ? '目击成功' : '本次目击未产生击毁',
        target
          ? '目标飞船已被击毁，母星情报已保存。'
          : '本次目击未产生击毁。请在当前页查看提交错误的目击码次数及攻击限制。',
        {
          outcome: {
            wrongCount: wrong,
            lockedUntilUtcMs: locked,
            eliminated: db.flight(actor.id).status === 'eliminated',
            ...(target ? { target } : {}),
            ...(intel ? { intel } : {}),
          },
        },
      );
      autoFinish(e, game, now, eventId);
      break;
    }
    case 'broadcast': {
      const code = coordinate(raw.code);
      requireThat(
        !db.one('SELECT id FROM broadcasts WHERE code=?', code),
        'ALREADY_BROADCAST',
        '这个坐标已经正式广播。',
      );
      const probability = db.parameters().singerPercent;
      const songDue = firstSongDue(game, uniformInt, probability);
      logEvent(
        e,
        eventId,
        'broadcast',
        '正式坐标广播',
        `${e.identity(actor.id)}广播了坐标${code}。`,
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
      db.exec('UPDATE players SET broadcasts=broadcasts+1 WHERE id=?', actor.id);
      if (songDue !== null)
        e.schedule(`song:${eventId}`, 'song_visit', 'game', songDue, 2, {
          code,
          broadcast: eventId,
        });
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
        e.notice(
          eventId,
          target.player_id,
          '收到母星情报',
          `${e.identity(actor.id)}的母星坐标为${home.code}。`,
          game,
        );
      }
      e.notice(
        eventId,
        'group',
        '正式坐标广播',
        `${e.identity(actor.id)}广播了坐标${code}。`,
        game,
      );
      result = completed(id, '广播已发布', '正式广播已受理。', {
        outcome: { accepted: true, eventId, remaining: 1 - p.broadcasts },
      });
      break;
    }
    case 'photon': {
      const code = coordinate(raw.code);
      const target = db.officialHome(code, true);
      const hit = target ? destroyHome(e, target.player_id, eventId, game, now) : false;
      const body = hit
        ? `${e.identity(target!.player_id)}的母星已被光粒摧毁。`
        : '清理完成，未摧毁任何现存母星。';
      logEvent(
        e,
        eventId,
        'photon',
        '光粒清理',
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
      e.notice(eventId, 'group', '光粒清理', `坐标${code}。${body}`, game);
      result = completed(id, '光粒已发射', '光粒已发射，剩余0枚。', {
        outcome: { accepted: true, eventId, remaining: 0 },
      });
      autoFinish(e, game, now, eventId);
      break;
    }
    default:
      throw new Fault(404, 'NOT_FOUND', '接口不存在。');
  }
  e.audit(actor.id, path, actor.id, '玩家操作', { requestId: id });
  db.bump();
  result.revision = db.match().revision;
  return result;
}
