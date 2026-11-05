import { COLORS, type OperationResult, type SiteConfig } from '@darkforest/contracts';
import {
  coordinate,
  integer,
  nickname,
  object,
  stableJson,
  strict,
  text,
} from '../../../../packages/contracts/src/backend';
import { techSchedule, TIMES } from '../domain/rules';
import { token } from '../security/crypto';
import { Fault, permission, requireThat, type Actor, type Parameters } from '../storage/store';
import { completed, type Engine, type PreparedCode } from './engine';
import { autoFinish, eliminate, logEvent, retire, survivors } from './life';
import { correctionTarget, correctAttack } from './attack-correction';
import { validateAccount, updateAccount, type CredentialMaterial } from './accounts';
import { validateReportCorrection, correctReport } from './report-correction';
import { finishRecovery } from './recovery';
import { restoration, restorePlayer } from './player-correction';
import { dueUtc, settleDue } from '../scheduler/events';
import type { Scheduled } from '../storage/store';
import { managementImpact, managementState } from './management-impact';

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
function payloadOf(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([k]) => !['request_id', 'preview_token', 'expected_revision', 'change', 'path'].includes(k),
    ),
  );
}
function recognized(path: string): boolean {
  return !!fields[path] || /^\/judge\/roster\/C\d{2,3}\/withdraw$/.test(path);
}
function authorize(actor: Actor, path: string): void {
  permission(
    actor,
    ['/judge/accounts', '/judge/recovery-finalize'].includes(path)
      ? 'system'
      : path === '/judge/roster'
        ? 'clock'
        : (capabilities[path] ?? 'commands'),
  );
}
function checkSchema(path: string, body: Record<string, unknown>): void {
  strict(body, [...metadata, ...(fields[path] ?? ['target', 'field', 'value'])]);
}
function validate(e: Engine, path: string, body: Record<string, unknown>, actor: Actor): void {
  const db = e.db,
    m = db.match();
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
    validateAccount(e, actor, body);
    return;
  }
  if (path === '/judge/report-correction') {
    permission(actor, 'commands');
    validateReportCorrection(e, body);
    return;
  }
  if (['/judge/arm-code-release', '/judge/arm-start'].includes(path)) {
    requireThat(
      m.phase === (path.endsWith('release') ? 'setup' : 'outfitting'),
      'WRONG_PHASE',
      '当前阶段不能安排这个时间。',
    );
    const utc = integer(body.time, e.now() + 1000, e.now() + 7 * 86400_000);
    void utc;
    const roster = db.all<{ id: string }>(
      "SELECT id FROM players WHERE entry_status='registered' AND id IN (SELECT player_id FROM roster_members) ORDER BY id",
    );
    requireThat(
      Array.isArray(body.expected_roster) &&
        stableJson([...body.expected_roster].sort()) === stableJson(roster.map((p) => p.id)),
      'ROSTER_CHANGED',
      '正式名单已变化，请刷新后重新核对。',
    );
    requireThat(roster.length >= 2, 'ROSTER_TOO_SMALL', '至少需要两名正式玩家。');
    for (const p of roster) {
      const f = db.flight(p.id),
        h = db.home(p.id);
      if (path.endsWith('release'))
        requireThat(
          f.status === 'staged' &&
            f.departed !== null &&
            f.staged !== null &&
            f.code_id === null &&
            h?.status === 'verified',
          'ROSTER_NOT_READY',
          '仍有正式玩家未完成准备。',
        );
      else
        requireThat(
          f.status === 'ready' &&
            f.ready !== null &&
            f.code_id &&
            db.one(
              "SELECT id FROM sighting_codes WHERE id=? AND player_id=? AND status='reserved'",
              f.code_id,
              p.id,
            ),
          'ROSTER_NOT_READY',
          '仍有正式玩家未完成穿戴。',
        );
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
    for (const id of body.members)
      requireThat(
        db.player(text(id, 16)).entry_status === 'registered',
        'NOT_REGISTERED',
        '退出正式名单的账号不能加入本场。',
      );
  } else if (path === '/judge/parameters') {
    requireThat(m.phase === 'setup', 'PARAMETERS_LOCKED', '比赛参数已锁定。');
    requireThat(
      integer(body.expected_version, 1) ===
        db.one<{ version: number }>("SELECT version FROM settings WHERE key='parameters'")!.version,
      'VERSION_CONFLICT',
      '参数已更新，请刷新后重新核对。',
    );
    validateParameters(body.values);
  } else if (path === '/judge/pause')
    requireThat(
      m.start_settled !== null && m.phase !== 'ended' && m.paused_at === null,
      'CANNOT_PAUSE',
      '当前不能暂停比赛。',
    );
  else if (path === '/judge/resume')
    requireThat(
      m.paused_at !== null && m.pause_reason !== 'hunt_review' && m.phase !== 'ended',
      'CANNOT_RESUME',
      '请先完成终局资格核验。',
    );
  else if (path === '/judge/hunt-finalize') {
    requireThat(
      m.phase === 'hunt' &&
        m.paused_at !== null &&
        m.pause_reason === 'hunt_review' &&
        m.hunt_finalized === null,
      'HUNT_NOT_REVIEWING',
      '当前未进行终局资格核验。',
    );
    requireThat(Array.isArray(body.eliminations), 'BAD_ELIMINATIONS', '请核对淘汰名单。', 400);
    const seen = new Set<string>();
    for (const raw of body.eliminations) {
      const p = strict(raw, ['id', 'reason']);
      const id = text(p.id, 16);
      requireThat(
        survivors(e).includes(id) && !seen.has(id),
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
      survivors(e).includes(text(body.target, 16)),
      'TARGET_NOT_ALIVE',
      '目标已不在存活名单中。',
    );
    requireThat(
      ['left_zone', 'sharing_stopped', 'location_violation'].includes(String(body.reason_code)),
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
      survivors(e).includes(text(body.target, 16)),
      'TARGET_NOT_ALIVE',
      '目标已不在存活名单中。',
    );
  } else if (path === '/judge/player-restore') {
    restoration(e, text(body.target, 16));
  } else if (path === '/judge/effects') {
    if (body.revoke)
      requireThat(
        db.one('SELECT id FROM admin_effects WHERE id=? AND active=1', text(body.revoke, 100)),
        'EFFECT_NOT_ACTIVE',
        '该临时效果已经结束。',
      );
    else {
      const target = text(body.target, 16);
      requireThat(
        target === '@a' || !!db.one('SELECT id FROM players WHERE id=?', target),
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
      db.flight(target).status === (body.mode === 'activate' ? 'issued' : 'active') ||
        (m.recovery_state.startsWith('review:') &&
          body.mode === 'reissue' &&
          ['issued', 'outfitting', 'ready'].includes(db.flight(target).status)),
      'FLIGHT_STATE_CONFLICT',
      '请重新核对当前航次。',
    );
  } else if (path === '/judge/correction') {
    db.player(text(body.target, 16));
    requireThat(m.phase !== 'ended', 'RESULTS_SEALED', '比赛已结束，请通过赛后更正处理。');
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
        !db.one('SELECT id FROM players WHERE nickname=? AND id<>?', n, String(body.target)),
        'NICKNAME_TAKEN',
        '这个昵称已被使用。',
      );
    } else if (field === 'restore') restoration(e, String(body.target));
    else integer(Number(body.value), 0, field === 'photons' ? 1 : 2);
  } else if (path === '/judge/observer-access') {
    db.player(text(body.target, 16));
    requireThat(typeof body.allowed === 'boolean', 'BAD_ACCESS', '观战权限设置不正确。', 400);
  } else if (path === '/judge/announce') {
    const target = text(body.target, 16);
    if (target !== '@a') db.player(target);
    text(body.message, 1000);
  } else if (path === '/judge/attack-correction') correctionTarget(e, body.attack_id);
  else if (path === '/judge/event-control') {
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
    if (body.operation === 'cancel')
      requireThat(
        m.paused_at !== null &&
          event.status === 'pending' &&
          ['song_visit', 'tech_burst', 'judge_delayed_command'].includes(event.kind),
        'EVENT_NOT_CANCELLABLE',
        '请暂停比赛后核对该事件。',
      );
    else {
      requireThat(!m.recovery_state, 'RECOVERY_REVIEW', '请先完成比赛恢复核对，再重试赛事事件。');
      requireThat(
        event.status !== 'cancelled',
        'EVENT_CANCELLED',
        '已取消事件不能重开；需要新增事件时请使用独立的手动触发操作。',
      );
      const utc = dueUtc(e, event);
      requireThat(
        event.status === 'settled' || (utc !== null && utc <= e.now()),
        'EVENT_NOT_DUE',
        '该计划尚未到期，不能提前执行。',
      );
    }
  } else if (path === '/judge/event-trigger') {
    requireThat(
      m.paused_at !== null && m.phase === 'forest' && e.game() < TIMES.apocalypse,
      'PAUSE_REQUIRED',
      '请在第一阶段暂停后核对手动事件。',
    );
    requireThat(body.kind === 'song_visit', 'BAD_EVENT_KIND', '当前手动事件仅支持歌者清理。', 400);
    coordinate(body.code);
  } else if (path === '/judge/schedule-announcement') {
    integer(body.seconds, 1, 86400);
    text(body.message, 1000);
  } else if (path === '/judge/reveal')
    requireThat(
      ['alive_homeworlds', 'unused_photoids', 'kills_last_10min'].includes(String(body.statistic)),
      'BAD_STATISTIC',
      '请选择统计项目。',
      400,
    );
  else if (path === '/judge/replay') integer(body.count, 1, 10);
}
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
  for (const name of names)
    integer(
      p[name],
      ['singerPercent', 'secondOutPercent', 'observerWaitSeconds'].includes(name) ? 0 : 1,
      name.endsWith('Percent')
        ? 100
        : name === 'sightingsPerMinute'
          ? 120
          : name === 'sightingIntervalMs'
            ? 60000
            : 86400,
    );
  return p as unknown as Parameters;
}
export function previewAction(
  e: Engine,
  actor: Actor,
  id: string,
  raw: Record<string, unknown>,
): OperationResult {
  const path = text(raw.path, 160);
  requireThat(recognized(path), 'NOT_IMPLEMENTED', '这项管理操作暂未开放。', 501);
  authorize(actor, path);
  const body: Record<string, unknown> = {
    ...payloadOf(raw),
    request_id: id,
    expected_revision: raw.expected_revision,
  };
  checkSchema(path, body);
  text(body.reason, 500);
  requireThat(
    integer(raw.expected_revision, 1) === e.db.match().revision,
    'VERSION_CONFLICT',
    '比赛状态已变化，请刷新后重新预览。',
  );
  validate(e, path, body, actor);
  const previewToken = token();
  e.db.exec(
    'INSERT INTO previews(token,actor,path,payload,revision,expires) VALUES(?,?,?,?,?,?)',
    previewToken,
    actor.id,
    path,
    stableJson(payloadOf(body)),
    e.db.match().revision,
    e.now() + 120_000,
  );
  const title = '确认管理操作';
  let changes: import('@darkforest/contracts').ManagementPreview['changes'];
  const consequences = [text(body.reason, 500)];
  if (path === '/judge/parameters') {
    const labels: Record<keyof Parameters, string> = {
      singerPercent: '歌者每分钟清扫概率（%）',
      firstLockSeconds: '第一次禁止攻击时长（秒）',
      secondLockSeconds: '第二次禁止攻击时长（秒）',
      secondOutPercent: '第二次错误淘汰概率（%）',
      respawnSeconds: '重生总时限（秒）',
      observerWaitSeconds: '观战等待时长（秒）',
      sightingIntervalMs: '目击最短间隔（毫秒）',
      sightingsPerMinute: '每分钟目击次数上限',
    };
    const before = e.db.parameters(),
      after = validateParameters(body.values);
    changes = (Object.keys(labels) as (keyof Parameters)[])
      .filter((key) => before[key] !== after[key])
      .map((key) => ({
        target: labels[key],
        before: String(before[key]),
        after: String(after[key]),
      }));
  } else if (path === '/judge/roster')
    changes = [
      {
        target: '参赛人数',
        before: String(e.db.roster().length),
        after: String((body.members as string[]).length),
      },
      {
        target: '正式参赛名单',
        before: e.db.roster().join('、'),
        after: (body.members as string[]).join('、'),
      },
    ];
  else if (path === '/judge/pause' || path === '/judge/resume')
    changes = [
      {
        target: '比赛计时',
        before: e.db.match().paused_at === null ? '正在运行' : '已暂停',
        after: path.endsWith('/pause') ? '暂停计时' : '继续计时',
      },
    ];
  else if (path === '/judge/hunt-finalize')
    changes = (body.eliminations as { id: string; reason: string }[]).map((p) => ({
      target: p.id,
      before: '存活',
      after:
        p.reason === 'outside_at_cutoff'
          ? '截止时未进入终局圈，永久淘汰'
          : '未按时加入位置共享，永久淘汰',
    }));
  else {
    const impact = managementImpact(e, path, body);
    changes = impact.changes;
    consequences.push(...impact.consequences);
  }
  if (path === '/judge/hunt-finalize') {
    const remaining = survivors(e).length - (body.eliminations as unknown[]).length;
    changes.push({
      target: '存活文明',
      before: String(survivors(e).length),
      after: String(remaining),
    });
    consequences.push(
      remaining <= 1
        ? '整批结算后提前完赛，封存排名并取消剩余正赛计划。'
        : '整批结算后关闭核验暂停，恢复最后狩猎。',
    );
  }
  const impact = { title, changes, consequences };
  e.db.exec('UPDATE previews SET impact=? WHERE token=?', JSON.stringify(impact), previewToken);
  e.audit(
    actor.id,
    path,
    typeof body.target === 'string' ? body.target : e.db.match().id,
    text(body.reason, 500),
    { requestId: id, status: 'previewed', parameters: payloadOf(body), preview: impact },
  );
  return completed(id, '请核对操作影响', '', {
    preview: {
      token: previewToken,
      revision: e.db.match().revision,
      title,
      changes,
      consequences,
    },
  });
}
export function judgeAction(
  e: Engine,
  actor: Actor,
  id: string,
  path: string,
  raw: Record<string, unknown>,
  prepared: PreparedCode[],
  credentialMaterial?: CredentialMaterial,
): OperationResult {
  const db = e.db,
    m = db.match(),
    now = e.now(),
    game = e.game(now);
  const verify = /^\/judge\/homeworld\/(C\d{2,3})\/verify$/.exec(path);
  if (verify) {
    permission(actor, 'homeworlds');
    strict(raw, ['request_id', 'expected_version', 'expected_code', 'decision', 'reason']);
    requireThat(m.phase === 'setup', 'REGISTRATION_CLOSED', '母星审核已结束。');
    const target = verify[1]!,
      h = db.home(target);
    requireThat(
      h?.status === 'pending' &&
        h.version === integer(raw.expected_version, 1) &&
        h.code === coordinate(raw.expected_code),
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
        !db.one("SELECT player_id FROM homeworlds WHERE code=? AND status='verified'", h.code),
        'HOMEWORLD_DUPLICATE',
        '这个坐标已有审核通过的母星。',
      );
      db.exec(
        "UPDATE homeworlds SET status='verified',verified_by=? WHERE player_id=?",
        actor.id,
        target,
      );
    } else
      db.exec(
        "UPDATE homeworlds SET status='rejected',rejection=? WHERE player_id=?",
        text(raw.reason, 500),
        target,
      );
    e.audit(
      actor.id,
      path,
      target,
      raw.decision === 'approve' ? '母星审核通过' : text(raw.reason, 500),
      {
        requestId: id,
        status: 'executed',
        before: h,
        after: db.home(target),
        parameters: { decision: raw.decision, expected_version: raw.expected_version },
      },
    );
    db.bump();
    e.notice(
      `verify:${target}:${h.version}`,
      target,
      '母星审核结果',
      raw.decision === 'approve'
        ? '母星审核通过，请继续完成首航准备。'
        : `母星登记已退回：${String(raw.reason)}`,
      game,
    );
    return completed(id, raw.decision === 'approve' ? '审核通过' : '已退回修改', undefined, {
      revision: db.match().revision,
    });
  }
  const notice = /^\/judge\/notices\/([^/]+)\/(copied|sent|error)$/.exec(path);
  if (notice) {
    permission(actor, 'notices');
    strict(raw, ['request_id', 'expected_version', 'reason']);
    const previous = db.one<{ status: string; version: number }>(
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
    if (notice[2] === 'copied')
      db.exec(
        'UPDATE notice_queue SET copied_by=?,copied_utc=? WHERE id=?',
        actor.name,
        now,
        notice[1]!,
      );
    if (notice[2] === 'sent')
      db.exec(
        'UPDATE notice_queue SET sent_by=?,sent_utc=? WHERE id=?',
        actor.name,
        now,
        notice[1]!,
      );
    const after = db.one('SELECT * FROM notice_queue WHERE id=?', notice[1]!);
    db.exec(
      'INSERT INTO notice_actions VALUES(?,?,?,?,?,?)',
      `${actor.id}:${id}`,
      notice[1]!,
      actor.id,
      notice[2]!,
      now,
      JSON.stringify({ before: previous, after, error: reason }),
    );
    e.audit(actor.id, path, notice[1]!, reason || '通知状态更新', {
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
    requireThat(m.phase === 'setup', 'PARAMETERS_LOCKED', '活动设置已锁定。');
    const previous = JSON.parse(m.site_json) as SiteConfig,
      site = strict(raw.site, [
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
    ])
      text(site[name], 1000, name === 'title' || name === 'timezone' ? 1 : 0);
    requireThat(site.timezone === 'Asia/Shanghai', 'BAD_TIMEZONE', '活动时区为北京时间。', 400);
    const colors = strict(
      site.colors,
      COLORS.map((c) => c.id),
    );
    for (const c of COLORS)
      requireThat(
        /^#[0-9a-f]{6}$/i.test(text(colors[c.id], 7)),
        'BAD_COLOR',
        '颜色值格式不正确。',
        400,
      );
    const reason = text(raw.reason, 500);
    site.version = previous.version + 1;
    db.exec('UPDATE matches SET site_json=?', JSON.stringify(site));
    e.audit(actor.id, path, m.id, reason, {
      requestId: id,
      status: 'executed',
      before: previous,
      after: site,
    });
    db.bump();
    return completed(id, '活动设置已保存');
  }
  requireThat(recognized(path), 'NOT_IMPLEMENTED', '这项管理操作暂未开放。', 501);
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
      preview.revision === m.revision &&
      integer(raw.expected_revision, 1) === m.revision,
    'PREVIEW_EXPIRED',
    '预览已过期，请重新核对操作影响。',
  );
  validate(e, path, raw, actor);
  const before = managementState(e);
  db.exec('UPDATE previews SET used=1 WHERE token=?', String(raw.preview_token));
  const source = `judge:${actor.id}:${id}`;
  let credentialDeliveryId: string | undefined;
  switch (path) {
    case '/judge/recovery-finalize':
      finishRecovery(e);
      break;
    case '/judge/report-correction':
      correctReport(e, raw, reason);
      break;
    case '/judge/accounts':
      credentialDeliveryId = updateAccount(e, actor, raw, credentialMaterial);
      break;
    case '/judge/arm-code-release': {
      const time = integer(raw.time);
      db.exec("UPDATE matches SET phase='armed',release_at=?", time);
      e.schedule('code_release', 'code_release', 'utc', time, 0);
      e.notice(
        source,
        'group',
        '统一发码时间',
        `统一发码时间：${new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。`,
        game,
      );
      break;
    }
    case '/judge/arm-start': {
      const time = integer(raw.time),
        n = db.roster().length;
      db.exec("UPDATE matches SET phase='start_countdown',started_at=?", time);
      e.schedule('match_start', 'match_start', 'utc', time, 0);
      for (const [kind, due] of [
        ['apocalypse', TIMES.apocalypse],
        ['transfer_start', TIMES.transfer],
        ['hunt_cutoff', TIMES.cutoff],
        ['regulation_end', TIMES.end],
      ] as const)
        e.schedule(kind, kind, 'game', due, 0);
      for (const [index, due] of techSchedule(n).entries())
        e.schedule(`tech:${index}`, 'tech_burst', 'game', due, 2);
      e.notice(
        source,
        'group',
        '统一开赛时间',
        `统一开赛时间：${new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。`,
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
      correctAttack(e, id, actor.id, correctionTarget(e, raw.attack_id), reason, prepared);
      break;
    case '/judge/event-control':
      if (raw.operation === 'cancel')
        db.exec(
          "UPDATE scheduled_events SET status='cancelled' WHERE id=? AND status='pending'",
          String(raw.event_id),
        );
      else settleDue(e);
      break;
    case '/judge/event-trigger':
      e.schedule(`${source}:manual-song`, 'song_visit', 'game', game, 2, {
        code: coordinate(raw.code),
        actor: actor.id,
      });
      settleDue(e);
      break;
    case '/judge/schedule-announcement':
      e.schedule(
        `${source}:delayed`,
        'judge_delayed_command',
        'utc',
        now + integer(raw.seconds) * 1000,
        3,
        { message: text(raw.message, 1000), actor: actor.id },
      );
      break;
    case '/judge/reveal': {
      let body: string;
      if (raw.statistic === 'alive_homeworlds')
        body = `尚存母星共${db.one<{ count: number }>("SELECT COUNT(*) AS count FROM homeworlds WHERE status='verified' AND destroyed_game IS NULL AND player_id IN (SELECT player_id FROM roster_members)")!.count}颗。`;
      else if (raw.statistic === 'unused_photoids')
        body = `存活文明持有的未使用光粒共${db.one<{ count: number }>("SELECT COALESCE(SUM(p.photons),0) AS count FROM players p JOIN flights f ON f.player_id=p.id WHERE p.entry_status='registered' AND f.status!='eliminated' AND p.id IN (SELECT player_id FROM roster_members)")!.count}枚。`;
      else
        body = `过去10分钟成功击毁飞船共${db.one<{ count: number }>("SELECT COUNT(*) AS count FROM attacks WHERE classification='hit' AND valid=1 AND game_ms>?", game - 600000)!.count}次。`;
      logEvent(e, `${source}:statistic`, 'notice', '赛事统计', body, 'public', [], game, now);
      e.notice(source, 'group', '赛事统计', body, game);
      break;
    }
    case '/judge/replay': {
      const rows = db.all<{ id: string; title: string; body: string; code: string | null }>(
        "SELECT id,title,body,code FROM event_log WHERE audience='public' ORDER BY seq DESC LIMIT ?",
        integer(raw.count, 1, 10),
      );
      for (const row of rows)
        e.notice(
          `${source}:replay:${row.id}`,
          'group',
          `重播：${row.title}`,
          `${row.body}${row.code ? `\n坐标：${row.code}` : ''}`,
          game,
        );
      break;
    }
    case '/judge/roster': {
      db.exec('DELETE FROM roster_members');
      for (const member of raw.members as string[])
        db.exec('INSERT INTO roster_members VALUES(?)', member);
      break;
    }
    case '/judge/pause':
      db.exec('UPDATE matches SET paused_at=?,pause_reason=?', now, reason);
      db.exec('INSERT INTO clock_pauses(opened,reason,actor) VALUES(?,?,?)', now, reason, actor.id);
      break;
    case '/judge/resume':
      closePause(e, now);
      break;
    case '/judge/hunt-finalize': {
      for (const rawOut of raw.eliminations as unknown[]) {
        const out = object(rawOut);
        eliminate(
          e,
          String(out.id),
          String(out.reason),
          'hunt_cutoff',
          TIMES.cutoff,
          m.paused_at!,
          'hunt_cutoff',
        );
      }
      db.exec('UPDATE matches SET hunt_finalized=?', now);
      closePause(e, now);
      autoFinish(e, TIMES.cutoff, m.paused_at!, source);
      if (db.match().phase !== 'ended')
        e.notice(
          source,
          'group',
          '最后狩猎开始',
          '终局资格核验完成，恢复目击攻击。请持续共享位置。',
          game,
        );
      break;
    }
    case '/judge/hunt-eliminate':
      eliminate(e, String(raw.target), String(raw.reason_code), source, game, now);
      autoFinish(e, game, now, source);
      break;
    case '/judge/player-eliminate':
      eliminate(e, String(raw.target), 'judge_violation', source, game, now);
      autoFinish(e, game, now, source);
      break;
    case '/judge/player-restore':
      restorePlayer(e, String(raw.target), id, source, prepared);
      break;
    case '/judge/effects':
      if (raw.revoke) db.exec('UPDATE admin_effects SET active=0 WHERE id=?', String(raw.revoke));
      else
        db.exec(
          'INSERT INTO admin_effects VALUES(?,?,?,?,?,?,1)',
          `FX-${id}`,
          String(raw.target),
          now,
          now + integer(raw.seconds) * 1000,
          reason,
          actor.name,
        );
      break;
    case '/judge/announce': {
      const target = String(raw.target),
        message = text(raw.message, 1000);
      logEvent(
        e,
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
      e.notice(source, target === '@a' ? 'group' : target, '赛事通知', message, game);
      break;
    }
    case '/judge/scheduler/rearm':
      break;
    case '/judge/events/settle-due':
      settleDue(e);
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
        retire(e, target, 'equipment_correction', game, now);
        e.issue(target, id, prepared);
        db.exec("UPDATE flights SET status='issued' WHERE player_id=?", target);
      } else if (raw.mode === 'activate') {
        requireThat(
          db.all(
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
      if (raw.field === 'nickname')
        db.exec('UPDATE players SET nickname=? WHERE id=?', nickname(raw.value), target);
      else if (raw.field === 'photons')
        db.exec(
          'UPDATE players SET photons=?,tech=CASE WHEN ?=1 THEN 1 ELSE tech END WHERE id=?',
          Number(raw.value),
          Number(raw.value),
          target,
        );
      else if (raw.field === 'broadcasts')
        db.exec('UPDATE players SET broadcasts=? WHERE id=?', 2 - Number(raw.value), target);
      else restorePlayer(e, target, id, source, prepared);
      break;
    }
    default: {
      if (!path.startsWith('/judge/roster/'))
        throw new Fault(501, 'NOT_IMPLEMENTED', '这项管理操作暂未开放。');
      const target = path.split('/')[3]!;
      retire(e, target, 'absent', game, now);
      db.exec("UPDATE players SET entry_status='absent' WHERE id=?", target);
      db.exec('DELETE FROM roster_members WHERE player_id=?', target);
      break;
    }
  }
  if (!['/judge/parameters', '/judge/arm-code-release', '/judge/arm-start'].includes(path))
    logEvent(
      e,
      source,
      'review',
      '裁判操作',
      reason,
      'global',
      typeof raw.target === 'string' ? [raw.target] : [],
      game,
      now,
    );
  db.bump();
  e.audit(actor.id, path, typeof raw.target === 'string' ? raw.target : m.id, reason, {
    requestId: id,
    status: 'executed',
    parameters: payloadOf(raw),
    preview: preview.impact ? JSON.parse(preview.impact) : null,
    before,
    after: managementState(e),
  });
  return completed(id, '操作已完成', undefined, {
    revision: db.match().revision,
    ...(credentialDeliveryId ? { credentialDeliveryId } : {}),
  });
}
function closePause(e: Engine, now: number): void {
  const m = e.db.match();
  requireThat(m.paused_at !== null, 'NOT_PAUSED', '比赛当前未暂停。');
  requireThat(
    e.db.all('UPDATE clock_pauses SET closed=? WHERE closed IS NULL RETURNING id', now).length ===
      1,
    'PAUSE_STATE_CONFLICT',
    '暂停记录需要核查。',
  );
  e.db.exec(
    "UPDATE matches SET paused_total=paused_total+?,paused_at=NULL,pause_reason=''",
    now - m.paused_at,
  );
}
