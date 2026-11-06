import {
  COLORS,
  type OperationResult,
  type SiteConfig,
} from '@darkforest/contracts';
import {
  coordinate,
  integer,
  parseJson,
  strict,
  text,
} from '../../../../packages/contracts/src/backend';
import {Fault, permission, requireThat} from '../storage/store';
import {completed} from './engine';
import type {
  JudgeActionContext,
  JudgeMutationContext,
} from './judge_action_context';
import {retire} from './life';

/** 核对待审核母星版本并保存决定、审计和本人通知。 */
export function verifyHomeworld(
  context: JudgeActionContext,
  verify: RegExpExecArray,
): OperationResult {
  const {actor, raw, matchState, db, engine, path, id, game} = context;
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

/** 仅在准备阶段更新公开站点设置，检查版本并保存审计。 */
export function updateSiteConfiguration(
  context: JudgeActionContext,
): OperationResult {
  const {actor, raw, matchState, db, engine, path, id} = context;
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

/** 在已验证的预览事务中替换正式名单。 */
export function replaceRoster(context: JudgeMutationContext): void {
  const {db, raw} = context;
  db.exec('DELETE FROM roster_members');
  for (const member of raw.members as string[]) {
    db.exec('INSERT INTO roster_members VALUES(?)', member);
  }
}

/** 仅处理正式名单移除路径，并退役现有码与参赛资格。 */
export function withdrawRosterMember(context: JudgeMutationContext): void {
  const {path, engine, game, now, db} = context;
  if (!path.startsWith('/judge/roster/')) {
    throw new Fault(501, 'NOT_IMPLEMENTED', '这项管理操作暂未开放。');
  }
  const target = path.split('/')[3]!;
  retire(engine, target, 'absent', game, now);
  db.exec("UPDATE players SET entry_status='absent' WHERE id=?", target);
  db.exec('DELETE FROM roster_members WHERE player_id=?', target);
}
