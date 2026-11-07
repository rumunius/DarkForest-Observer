import {type OperationResult} from '@darkforest/contracts';
import {
  integer,
  parseJson,
  stableJson,
  text,
} from '../../../../packages/contracts/src/backend';
import {requireThat, type Actor} from '../storage/store';
import {type CredentialMaterial} from './accounts';
import {completed, type Engine, type PreparedCode} from './engine';
import type {JudgeActionContext} from './judge_action_context';
import {dispatchJudgeAction} from './judge_dispatch';
import {recordNoticeStatus} from './judge_messages';
import {updateSiteConfiguration, verifyHomeworld} from './judge_setup';
import {
  authorize,
  checkSchema,
  payloadOf,
  recognized,
  validate,
} from './judge_validation';
import {logEvent} from './life';
import {managementState} from './management_impact';

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
  const context: JudgeActionContext = {
    engine,
    actor,
    id,
    path,
    raw,
    prepared,
    credentialMaterial,
    db,
    matchState,
    now,
    game,
  };
  const verify = /^\/judge\/homeworld\/(C\d{2,3})\/verify$/.exec(path);
  if (verify) {
    return verifyHomeworld(context, verify);
  }
  const notice = /^\/judge\/notices\/([^/]+)\/(copied|sent|error)$/.exec(path);
  if (notice) {
    return recordNoticeStatus(context, notice);
  }
  if (path === '/judge/site-config') {
    return updateSiteConfiguration(context);
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
  const credentialDeliveryId = dispatchJudgeAction({
    ...context,
    reason,
    source,
  });
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

export {previewAction} from './judge_preview';
export {validateParameters} from './judge_validation';
