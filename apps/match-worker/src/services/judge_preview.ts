import {
  type ManagementPreview,
  type OperationResult,
} from '@darkforest/contracts';
import {
  integer,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import {token} from '../security/crypto';
import {requireThat, type Actor, type Parameters} from '../storage/store';
import {completed, type Engine} from './engine';
import {
  authorize,
  checkSchema,
  payloadOf,
  recognized,
  validate,
  validateParameters,
} from './judge_validation';
import {survivors} from './life';
import {managementImpact} from './management_impact';

/** 执行真实管理影响预览并保存版本依赖，确认前不会提交战局变更。 */
export function previewAction(
  engine: Engine,
  actor: Actor,
  id: string,
  raw: Record<string, unknown>,
): OperationResult {
  const path = text(raw.path, 160);
  requireThat(
    recognized(path),
    'NOT_IMPLEMENTED',
    '这项管理操作暂未开放。',
    501,
  );
  authorize(actor, path);
  const body: Record<string, unknown> = {
    ...payloadOf(raw),
    request_id: id,
    expected_revision: raw.expected_revision,
  };
  checkSchema(path, body);
  text(body.reason, 500);
  requireThat(
    integer(raw.expected_revision, 1) === engine.db.match().revision,
    'VERSION_CONFLICT',
    '比赛状态已变化，请刷新后重新预览。',
  );
  validate(engine, path, body, actor);
  const previewToken = token();
  engine.db.exec(
    'INSERT INTO previews(token,actor,path,payload,revision,expires) VALUES(?,?,?,?,?,?)',
    previewToken,
    actor.id,
    path,
    stableJson(payloadOf(body)),
    engine.db.match().revision,
    engine.now() + 120_000,
  );
  const title = '确认管理操作';
  let changes: ManagementPreview['changes'];
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
    const before = engine.db.parameters();
    const after = validateParameters(body.values);
    changes = (Object.keys(labels) as Array<keyof Parameters>)
      .filter(key => before[key] !== after[key])
      .map(key => ({
        target: labels[key],
        before: String(before[key]),
        after: String(after[key]),
      }));
  } else if (path === '/judge/roster') {
    changes = [
      {
        target: '参赛人数',
        before: String(engine.db.roster().length),
        after: String((body.members as string[]).length),
      },
      {
        target: '正式参赛名单',
        before: engine.db.roster().join('、'),
        after: (body.members as string[]).join('、'),
      },
    ];
  } else if (path === '/judge/pause' || path === '/judge/resume') {
    changes = [
      {
        target: '比赛计时',
        before: engine.db.match().paused_at === null ? '正在运行' : '已暂停',
        after: path.endsWith('/pause') ? '暂停计时' : '继续计时',
      },
    ];
  } else if (path === '/judge/hunt-finalize') {
    changes = (body.eliminations as Array<{id: string; reason: string}>).map(
      p => ({
        target: p.id,
        before: '存活',
        after:
          p.reason === 'outside_at_cutoff'
            ? '截止时未进入终局圈，永久淘汰'
            : '未按时加入位置共享，永久淘汰',
      }),
    );
  } else {
    const impact = managementImpact(engine, path, body);
    changes = impact.changes;
    consequences.push(...impact.consequences);
  }
  if (path === '/judge/hunt-finalize') {
    const remaining =
      survivors(engine).length - (body.eliminations as unknown[]).length;
    changes.push({
      target: '存活文明',
      before: String(survivors(engine).length),
      after: String(remaining),
    });
    consequences.push(
      remaining <= 1
        ? '整批结算后提前完赛，封存排名并取消剩余正赛计划。'
        : '整批结算后关闭核验暂停，恢复最后狩猎。',
    );
  }
  const impact = {title, changes, consequences};
  engine.db.exec(
    'UPDATE previews SET impact=? WHERE token=?',
    JSON.stringify(impact),
    previewToken,
  );
  engine.audit(
    actor.id,
    path,
    typeof body.target === 'string' ? body.target : engine.db.match().id,
    text(body.reason, 500),
    {
      requestId: id,
      status: 'previewed',
      parameters: payloadOf(body),
      preview: impact,
    },
  );
  return completed(id, '请核对操作影响', '', {
    preview: {
      token: previewToken,
      revision: engine.db.match().revision,
      title,
      changes,
      consequences,
    },
  });
}
