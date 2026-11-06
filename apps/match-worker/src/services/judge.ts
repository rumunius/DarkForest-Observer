import {
  COLORS,
  type OperationResult,
  type SiteConfig,
} from '@darkforest/contracts';
import {
  coordinate,
  integer,
  nickname,
  object,
  parseJson,
  scalarText,
  stableJson,
  strict,
  text,
} from '../../../../packages/contracts/src/backend';
import {
  HUNT_START_COPY,
  START_COUNTDOWN_COPY,
} from '../../../../packages/contracts/src/message_copy';
import {techSchedule, TIMES} from '../domain/rules';
import {settleDue} from '../scheduler/events';
import {Fault, permission, requireThat, type Actor} from '../storage/store';
import {updateAccount, type CredentialMaterial} from './accounts';
import {correctAttack, correctionTarget} from './attack_correction';
import {completed, type Engine, type PreparedCode} from './engine';
import {
  authorize,
  checkSchema,
  payloadOf,
  recognized,
  validate,
  validateParameters,
} from './judge_validation';
import {autoFinish, eliminate, logEvent, retire} from './life';
import {managementState} from './management_impact';
import {restorePlayer} from './player_correction';
import {finishRecovery} from './recovery';
import {correctReport} from './report_correction';

/** 在调用方权威事务内执行裁判操作，复核权限、版本及预览依据。 */
export function judgeAction(
  engine: Engine,
  actor: Actor,
  id: string,
  path: string,
  raw: Record<string, unknown>,
  prepared: PreparedCode[],
  credentialMaterial?: CredentialMaterial,
): OperationResult {
  const db = engine.db;
  const matchState = db.match();
  const now = engine.now();
  const game = engine.game(now);
  const verify = /^\/judge\/homeworld\/(C\d{2,3})\/verify$/.exec(path);
  if (verify) {
    permission(actor, 'homeworlds');
    strict(raw, [
      'request_id',
      'expected_version',
      'expected_code',
      'decision',
      'reason',
    ]);
    requireThat(
      matchState.phase === 'setup',
      'REGISTRATION_CLOSED',
      '母星审核已结束。',
    );
    const target = verify[1]!;
    const homeworld = db.home(target);
    requireThat(
      homeworld?.status === 'pending' &&
        homeworld.version === integer(raw.expected_version, 1) &&
        homeworld.code === coordinate(raw.expected_code),
      'HOMEWORLD_VERSION_CONFLICT',
      '提交内容已更新，请核对最新版本。',
    );
    requireThat(
      raw.decision === 'approve' || raw.decision === 'reject',
      'BAD_DECISION',
      '请选择审核结果。',
      400,
    );
    if (raw.decision === 'approve') {
      requireThat(
        !db.one<Record<string, SqlStorageValue>>(
          "SELECT player_id FROM homeworlds WHERE code=? AND status='verified'",
          homeworld.code,
        ),
        'HOMEWORLD_DUPLICATE',
        '这个坐标已有审核通过的母星。',
      );
      db.exec(
        "UPDATE homeworlds SET status='verified',verified_by=? WHERE player_id=?",
        actor.id,
        target,
      );
    } else {
      db.exec(
        "UPDATE homeworlds SET status='rejected',rejection=? WHERE player_id=?",
        text(raw.reason, 500),
        target,
      );
    }
    engine.audit(
      actor.id,
      path,
      target,
      raw.decision === 'approve' ? '母星审核通过' : text(raw.reason, 500),
      {
        requestId: id,
        status: 'executed',
        before: homeworld,
        after: db.home(target),
        parameters: {
          decision: raw.decision,
          expected_version: raw.expected_version,
        },
      },
    );
    db.bump();
    engine.notice(
      `verify:${target}:${homeworld.version}`,
      target,
      '母星审核结果',
      raw.decision === 'approve'
        ? `文明${engine.identity(target)}，你的母星已登记，请离开母星至少50米，准备首航。`
        : `文明${engine.identity(target)}，你的母星登记已退回：${String(raw.reason)}`,
      game,
    );
    return completed(
      id,
      raw.decision === 'approve' ? '审核通过' : '已退回修改',
      undefined,
      {
        revision: db.match().revision,
      },
    );
  }
  const notice = /^\/judge\/notices\/([^/]+)\/(copied|sent|error)$/.exec(path);
  if (notice) {
    permission(actor, 'notices');
    strict(raw, ['request_id', 'expected_version', 'reason']);
    const previous = db.one<{status: string; version: number}>(
      'SELECT * FROM notice_queue WHERE id=?',
      notice[1]!,
    );
    requireThat(
      previous &&
        previous.version === integer(raw.expected_version, 1) &&
        previous.status !== 'sent',
      'NOTICE_VERSION_CONFLICT',
      '通知状态已更新，请刷新后查看。',
    );
    const reason = notice[2] === 'error' ? text(raw.reason, 500) : '';
    db.exec(
      'UPDATE notice_queue SET status=?,version=version+1,operator=?,error=? WHERE id=? AND version=?',
      notice[2]!,
      actor.name,
      reason,
      notice[1]!,
      previous.version,
    );
    if (notice[2] === 'copied') {
      db.exec(
        'UPDATE notice_queue SET copied_by=?,copied_utc=? WHERE id=?',
        actor.name,
        now,
        notice[1]!,
      );
    }
    if (notice[2] === 'sent') {
      db.exec(
        'UPDATE notice_queue SET sent_by=?,sent_utc=? WHERE id=?',
        actor.name,
        now,
        notice[1]!,
      );
    }
    const after = db.one<Record<string, SqlStorageValue>>(
      'SELECT * FROM notice_queue WHERE id=?',
      notice[1]!,
    );
    db.exec(
      'INSERT INTO notice_actions VALUES(?,?,?,?,?,?)',
      `${actor.id}:${id}`,
      notice[1]!,
      actor.id,
      notice[2]!,
      now,
      JSON.stringify({before: previous, after, error: reason}),
    );
    engine.audit(actor.id, path, notice[1]!, reason || '通知状态更新', {
      requestId: id,
      status: 'executed',
      before: previous,
      after,
    });
    db.bump();
    return completed(id, '通知状态已更新');
  }
  if (path === '/judge/site-config') {
    permission(actor, 'settings');
    strict(raw, ['request_id', 'site', 'expected_version', 'reason']);
    requireThat(
      matchState.phase === 'setup',
      'PARAMETERS_LOCKED',
      '活动设置已锁定。',
    );
    const previous = parseJson(matchState.site_json) as SiteConfig;
    const site = strict(raw.site, [
      'version',
      'title',
      'description',
      'timezone',
      'qqGroup',
      'judgeContact',
      'endgameFile',
      'colors',
    ]);
    requireThat(
      integer(raw.expected_version, 1) === previous.version,
      'VERSION_CONFLICT',
      '活动设置已更新，请刷新后查看。',
    );
    for (const name of [
      'title',
      'description',
      'timezone',
      'qqGroup',
      'judgeContact',
      'endgameFile',
    ]) {
      text(site[name], 1000, name === 'title' || name === 'timezone' ? 1 : 0);
    }
    requireThat(
      site.timezone === 'Asia/Shanghai',
      'BAD_TIMEZONE',
      '活动时区为北京时间。',
      400,
    );
    const colors = strict(
      site.colors,
      COLORS.map(c => c.id),
    );
    for (const c of COLORS) {
      requireThat(
        /^#[0-9a-f]{6}$/i.test(text(colors[c.id], 7)),
        'BAD_COLOR',
        '颜色值格式不正确。',
        400,
      );
    }
    const reason = text(raw.reason, 500);
    site.version = previous.version + 1;
    db.exec('UPDATE matches SET site_json=?', JSON.stringify(site));
    engine.audit(actor.id, path, matchState.id, reason, {
      requestId: id,
      status: 'executed',
      before: previous,
      after: site,
    });
    db.bump();
    return completed(id, '活动设置已保存');
  }
  requireThat(
    recognized(path),
    'NOT_IMPLEMENTED',
    '这项管理操作暂未开放。',
    501,
  );
  authorize(actor, path);
  checkSchema(path, raw);
  const reason = text(raw.reason, 500);
  const preview = db.one<{
    actor: string;
    path: string;
    payload: string;
    revision: number;
    expires: number;
    used: number;
    impact: string | null;
  }>('SELECT * FROM previews WHERE token=?', text(raw.preview_token, 100));
  requireThat(
    preview &&
      preview.actor === actor.id &&
      preview.path === path &&
      preview.payload === stableJson(payloadOf(raw)) &&
      !preview.used &&
      preview.expires > now &&
      preview.revision === matchState.revision &&
      integer(raw.expected_revision, 1) === matchState.revision,
    'PREVIEW_EXPIRED',
    '预览已过期，请重新核对操作影响。',
  );
  validate(engine, path, raw, actor);
  const before = managementState(engine);
  db.exec(
    'UPDATE previews SET used=1 WHERE token=?',
    String(raw.preview_token),
  );
  const source = `judge:${actor.id}:${id}`;
  let credentialDeliveryId: string | undefined;
  switch (path) {
    case '/judge/recovery-finalize':
      finishRecovery(engine);
      break;
    case '/judge/report-correction':
      correctReport(engine, raw, reason);
      break;
    case '/judge/accounts':
      credentialDeliveryId = updateAccount(
        engine,
        actor,
        raw,
        credentialMaterial,
      );
      break;
    case '/judge/arm-code-release': {
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
      break;
    }
    case '/judge/arm-start': {
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
      break;
    }
    case '/judge/parameters':
      db.exec(
        "UPDATE settings SET value=?,version=version+1 WHERE key='parameters'",
        JSON.stringify(validateParameters(raw.values)),
      );
      break;
    case '/judge/attack-correction':
      correctAttack(
        engine,
        id,
        actor.id,
        correctionTarget(engine, raw.attack_id),
        reason,
        prepared,
      );
      break;
    case '/judge/event-control':
      if (raw.operation === 'cancel') {
        db.exec(
          "UPDATE scheduled_events SET status='cancelled' WHERE id=? AND status='pending'",
          String(raw.event_id),
        );
      } else {
        settleDue(engine);
      }
      break;
    case '/judge/event-trigger':
      engine.schedule(`${source}:manual-song`, 'song_visit', 'game', game, 2, {
        code: coordinate(raw.code),
        actor: actor.id,
      });
      settleDue(engine);
      break;
    case '/judge/schedule-announcement':
      engine.schedule(
        `${source}:delayed`,
        'judge_delayed_command',
        'utc',
        now + integer(raw.seconds) * 1000,
        3,
        {message: text(raw.message, 1000), actor: actor.id},
      );
      break;
    case '/judge/reveal': {
      let body: string;
      if (raw.statistic === 'alive_homeworlds') {
        body = `尚存母星共${db.one<{count: number}>("SELECT COUNT(*) AS count FROM homeworlds WHERE status='verified' AND destroyed_game IS NULL AND player_id IN (SELECT player_id FROM roster_members)")!.count}颗。`;
      } else if (raw.statistic === 'unused_photoids') {
        body = `存活文明持有的未使用光粒共${db.one<{count: number}>("SELECT COALESCE(SUM(p.photons),0) AS count FROM players p JOIN flights f ON f.player_id=p.id WHERE p.entry_status='registered' AND f.status!='eliminated' AND p.id IN (SELECT player_id FROM roster_members)")!.count}枚。`;
      } else {
        body = `过去10分钟成功击毁飞船共${db.one<{count: number}>("SELECT COUNT(*) AS count FROM attacks WHERE classification='hit' AND valid=1 AND game_ms>?", game - 600000)!.count}次。`;
      }
      logEvent(
        engine,
        `${source}:statistic`,
        'notice',
        '赛事统计',
        body,
        'public',
        [],
        game,
        now,
      );
      engine.notice(source, 'group', '赛事统计', body, game);
      break;
    }
    case '/judge/replay': {
      const rows = db.all<{
        id: string;
        title: string;
        body: string;
        code: string | null;
      }>(
        "SELECT id,title,body,code FROM event_log WHERE audience='public' ORDER BY seq DESC LIMIT ?",
        integer(raw.count, 1, 10),
      );
      for (const row of rows) {
        engine.notice(
          `${source}:replay:${row.id}`,
          'group',
          `重播：${row.title}`,
          `${row.body}${row.code && !row.body.includes(row.code) ? `\n坐标：${row.code}` : ''}`,
          game,
        );
      }
      break;
    }
    case '/judge/roster': {
      db.exec('DELETE FROM roster_members');
      for (const member of raw.members as string[]) {
        db.exec('INSERT INTO roster_members VALUES(?)', member);
      }
      break;
    }
    case '/judge/pause':
      db.exec('UPDATE matches SET paused_at=?,pause_reason=?', now, reason);
      db.exec(
        'INSERT INTO clock_pauses(opened,reason,actor) VALUES(?,?,?)',
        now,
        reason,
        actor.id,
      );
      break;
    case '/judge/resume':
      closePause(engine, now);
      break;
    case '/judge/hunt-finalize': {
      for (const rawOut of raw.eliminations as unknown[]) {
        const out = object(rawOut);
        eliminate(
          engine,
          String(out.id),
          String(out.reason),
          'hunt_cutoff',
          TIMES.cutoff,
          matchState.paused_at!,
          'hunt_cutoff',
        );
      }
      db.exec('UPDATE matches SET hunt_finalized=?', now);
      closePause(engine, now);
      autoFinish(engine, TIMES.cutoff, matchState.paused_at!, source);
      if (db.match().phase !== 'ended') {
        engine.notice(source, 'group', '最后狩猎开始', HUNT_START_COPY, game);
      }
      break;
    }
    case '/judge/hunt-eliminate':
      eliminate(
        engine,
        String(raw.target),
        String(raw.reason_code),
        source,
        game,
        now,
      );
      autoFinish(engine, game, now, source);
      break;
    case '/judge/player-eliminate':
      eliminate(
        engine,
        String(raw.target),
        'judge_violation',
        source,
        game,
        now,
      );
      autoFinish(engine, game, now, source);
      break;
    case '/judge/player-restore':
      restorePlayer(engine, String(raw.target), id, source, prepared);
      break;
    case '/judge/effects':
      if (raw.revoke) {
        db.exec(
          'UPDATE admin_effects SET active=0 WHERE id=?',
          scalarText(raw.revoke),
        );
      } else {
        db.exec(
          'INSERT INTO admin_effects VALUES(?,?,?,?,?,?,1)',
          `FX-${id}`,
          String(raw.target),
          now,
          now + integer(raw.seconds) * 1000,
          reason,
          actor.name,
        );
      }
      break;
    case '/judge/announce': {
      const target = String(raw.target);
      const message = text(raw.message, 1000);
      logEvent(
        engine,
        `${source}:message`,
        'notice',
        '赛事通知',
        message,
        target === '@a' ? 'public' : 'personal',
        target === '@a' ? [] : [target],
        game,
        now,
        target === '@a' ? null : target,
      );
      engine.notice(
        source,
        target === '@a' ? 'group' : target,
        '赛事通知',
        message,
        game,
      );
      break;
    }
    case '/judge/scheduler/rearm':
      break;
    case '/judge/events/settle-due':
      settleDue(engine);
      break;
    case '/judge/observer-access':
      db.exec(
        'UPDATE players SET observer_revoked=? WHERE id=?',
        raw.allowed ? 0 : 1,
        String(raw.target),
      );
      break;
    case '/judge/equipment-correction': {
      const target = String(raw.target);
      if (raw.mode === 'reissue') {
        retire(engine, target, 'equipment_correction', game, now);
        engine.issue(target, id, prepared);
        db.exec("UPDATE flights SET status='issued' WHERE player_id=?", target);
      } else if (raw.mode === 'activate') {
        requireThat(
          db.all<Record<string, SqlStorageValue>>(
            "UPDATE sighting_codes SET status='active',activated_utc=?,activated_game=? WHERE id=? AND status='reserved' RETURNING id",
            now,
            game,
            db.flight(target).code_id,
          ).length === 1,
          'CODE_STATE_CONFLICT',
          '请重新核对当前配置。',
        );
        db.exec("UPDATE flights SET status='active' WHERE player_id=?", target);
      }
      break;
    }
    case '/judge/correction': {
      const target = String(raw.target);
      if (raw.field === 'nickname') {
        db.exec(
          'UPDATE players SET nickname=? WHERE id=?',
          nickname(raw.value),
          target,
        );
      } else if (raw.field === 'photons') {
        db.exec(
          'UPDATE players SET photons=?,tech=CASE WHEN ?=1 THEN 1 ELSE tech END WHERE id=?',
          Number(raw.value),
          Number(raw.value),
          target,
        );
      } else if (raw.field === 'broadcasts') {
        db.exec(
          'UPDATE players SET broadcasts=? WHERE id=?',
          2 - Number(raw.value),
          target,
        );
      } else {
        restorePlayer(engine, target, id, source, prepared);
      }
      break;
    }
    default: {
      if (!path.startsWith('/judge/roster/')) {
        throw new Fault(501, 'NOT_IMPLEMENTED', '这项管理操作暂未开放。');
      }
      const target = path.split('/')[3]!;
      retire(engine, target, 'absent', game, now);
      db.exec("UPDATE players SET entry_status='absent' WHERE id=?", target);
      db.exec('DELETE FROM roster_members WHERE player_id=?', target);
      break;
    }
  }
  if (
    ![
      '/judge/parameters',
      '/judge/arm-code-release',
      '/judge/arm-start',
    ].includes(path)
  ) {
    logEvent(
      engine,
      source,
      'review',
      '裁判操作',
      reason,
      'global',
      typeof raw.target === 'string' ? [raw.target] : [],
      game,
      now,
    );
  }
  db.bump();
  engine.audit(
    actor.id,
    path,
    typeof raw.target === 'string' ? raw.target : matchState.id,
    reason,
    {
      requestId: id,
      status: 'executed',
      parameters: payloadOf(raw),
      preview: preview.impact ? parseJson(preview.impact) : null,
      before,
      after: managementState(engine),
    },
  );
  return completed(id, '操作已完成', undefined, {
    revision: db.match().revision,
    ...(credentialDeliveryId ? {credentialDeliveryId} : {}),
  });
}

function closePause(engine: Engine, now: number): void {
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
export {previewAction} from './judge_preview';
export {validateParameters} from './judge_validation';
