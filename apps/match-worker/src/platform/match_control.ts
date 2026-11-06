import {
  object,
  parseJson,
  stableJson,
} from '../../../../packages/contracts/src/backend';
import type {BackendEnv} from '../rpc/types';
import {digest} from '../security/crypto';
import type {Engine} from '../services/engine';
import {requireThat} from '../storage/store';
import {historyRecord} from './history';
import {dispatchMatchControl} from './match_control_dispatch';
import {controlSignature} from './security';

/** 平台发往指定比赛对象的签名控制请求，绑定操作ID、发起者和到期UTC。 */
export interface ControlRequest {
  id: string;
  matchId: string;
  action: string;
  actor: string;
  reason: string;
  payload: Record<string, unknown>;
  expires: number;
}
/** 校验平台控制请求并在本场执行幂等变更，权限与版本条件在权威对象内复核。 */
export async function matchControl(
  engine: Engine,
  env: BackendEnv,
  request: ControlRequest,
  signature: string,
): Promise<unknown> {
  requireThat(
    request.expires >= Date.now() &&
      request.expires <= Date.now() + 60000 &&
      signature === (await controlSignature(env, stableJson(request))),
    'FORBIDDEN',
    '内部授权无效。',
    403,
  );
  requireThat(
    request.matchId === engine.matchId,
    'MATCH_MISMATCH',
    '请求的场次与对象身份不一致。',
    409,
  );
  requireThat(
    request.matchId === engine.env.MATCH_ID,
    'OBJECT_ID_MISMATCH',
    '比赛与已登记对象地址不一致。',
  );
  if (request.action === 'history-record') {
    return historyRecord(engine, request.actor, request.payload);
  }
  const hash = await digest(stableJson({...request, expires: 0}));
  const prior = engine.db.one<{body_hash: string; result: string}>(
    'SELECT * FROM control_operations WHERE id=?',
    request.id,
  );
  if (prior) {
    requireThat(
      prior.body_hash === hash,
      'OPERATION_CONFLICT',
      '该操作编号已用于不同内容。',
    );
    return parseJson(prior.result);
  }
  const payload = object(request.payload);
  if (request.action === 'initialize') {
    engine.platformKeys = true;
  }
  const keys =
    request.action === 'initialize' ? await engine.keys() : undefined;
  const fingerprint = keys?.fingerprint ?? '';
  return engine.db.tx(() => {
    const old = engine.db.one<{body_hash: string; result: string}>(
      'SELECT * FROM control_operations WHERE id=?',
      request.id,
    );
    if (old) {
      requireThat(
        old.body_hash === hash,
        'OPERATION_CONFLICT',
        '操作编号冲突。',
      );
      return parseJson(old.result);
    }
    const db = engine.db;
    const result = dispatchMatchControl({
      engine,
      db,
      request,
      payload,
      hash,
      fingerprint,
    });
    if (!['summary', 'template'].includes(request.action)) {
      engine.audit(
        request.actor,
        `platform:${request.action}`,
        request.matchId,
        request.reason,
        result,
      );
    }
    if (!['summary', 'template'].includes(request.action)) {
      db.exec(
        'INSERT INTO control_operations VALUES(?,?,?)',
        request.id,
        hash,
        JSON.stringify(result),
      );
    }
    return result;
  });
}

export {HEAD_PERMISSIONS, membershipActor} from './match_members';
