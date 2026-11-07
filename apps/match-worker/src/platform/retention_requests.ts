import {integer, text} from '../../../../packages/contracts/src/backend';
import type {RpcReply} from '../rpc/types';
import {requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import {assertVersion} from './policy';
import type {PlatformMutation} from './request_context';
import {erasureFloor} from './retention';
import type {Operation} from './types';

/** 增加或释放有审计的资料保留，继续核对当前版本与资料范围。 */
export function changeRetentionHold(
  host: DarkForestPlatform,
  request: PlatformMutation,
): RpcReply {
  const {requestPayload, session, reason, id, bodyHash} = request;

  const directoryEntry = host.directory(text(requestPayload.matchId, 100));
  requireThat(
    host.dataScope(session.account_id, directoryEntry.id),
    'ARCHIVE_SCOPE_REQUIRED',
    '当前账号未获本场数据管理权限。',
    403,
  );
  assertVersion(host, directoryEntry, requestPayload.expected_version);
  host.db.tx(() => {
    if (requestPayload.release === true) {
      host.db.exec(
        'DELETE FROM retention_holds WHERE match_id=?',
        directoryEntry.id,
      );
    } else {
      host.db.exec(
        'INSERT OR REPLACE INTO retention_holds VALUES(?,?,?,?)',
        directoryEntry.id,
        reason,
        session.account_id,
        integer(requestPayload.reviewUtc, host.now() + 60000),
      );
    }
    host.db.exec(
      'UPDATE match_directory SET version=version+1 WHERE id=?',
      directoryEntry.id,
    );
    host.insertOperation(
      id,
      session.account_id,
      'hold',
      directoryEntry.id,
      bodyHash,
      {},
      reason,
      'succeeded',
    );
  });
  return {status: 200, body: {status: 'succeeded', operationId: id}};
}

/** 核对完赛、保留期及申诉状态后安排原七天等待清理。 */
export async function queueRetentionPurge(
  host: DarkForestPlatform,
  request: PlatformMutation,
): Promise<RpcReply> {
  const {requestPayload, session, id, bodyHash, reason} = request;

  const retentionEntry = host.directory(text(requestPayload.matchId, 100));
  requireThat(
    host.dataScope(session.account_id, retentionEntry.id),
    'ARCHIVE_SCOPE_REQUIRED',
    '当前账号未获本场数据管理权限。',
    403,
  );
  assertVersion(host, retentionEntry, requestPayload.expected_version);
  const summary = await host.summary(retentionEntry, session.account_id);
  requireThat(
    summary.phase === 'ended',
    'ENDED_REQUIRED',
    '只有已完赛的比赛可以清理。',
  );
  requireThat(
    !summary.recovering,
    'RECOVERY_LOCKED',
    '请先完成比赛恢复再清理。',
  );
  const ended = Number(summary.endedUtc);
  requireThat(
    ended > 0 && host.now() >= ended + retentionEntry.retention_days * 86400000,
    'RETENTION_ACTIVE',
    '完整复盘的保留期尚未结束。',
  );
  requireThat(
    summary.reportVersion,
    'REPORT_REQUIRED',
    '正式战报尚未生成，暂不能清理。',
  );
  host.db.tx(() => {
    assertVersion(
      host,
      host.directory(retentionEntry.id),
      requestPayload.expected_version,
    );
    requireThat(
      retentionEntry.state !== 'purge_pending' &&
        erasureFloor(host, retentionEntry.id) === 0,
      'CLEANUP_ALREADY_REQUESTED',
      '本场已经安排清理或已经清理。请查看管理待办。',
    );
    requireThat(
      !host.db.one<Record<string, SqlStorageValue>>(
        'SELECT match_id FROM retention_holds WHERE match_id=?',
        retentionEntry.id,
      ),
      'RETENTION_HOLD',
      '本场资料因申诉暂缓清理。',
    );
    host.db.exec(
      "UPDATE match_directory SET state='purge_pending',version=version+1 WHERE id=?",
      retentionEntry.id,
    );
    host.insertOperation(
      id,
      session.account_id,
      'purge',
      retentionEntry.id,
      bodyHash,
      requestPayload,
      reason,
    );
    host.db.exec(
      'UPDATE platform_operations SET next_attempt=? WHERE id=?',
      host.now() + 7 * 86400000,
      id,
    );
  });
  await host.arm();
  return {status: 202, body: {operationId: id, status: 'pending'}};
}

/** 取消尚未执行的清理并恢复目录状态，保留原清理记录。 */
export function cancelRetentionPurge(
  host: DarkForestPlatform,
  request: PlatformMutation,
): RpcReply {
  const {requestPayload, session, id, bodyHash, reason} = request;

  const pendingOperation = host.db.one<Operation>(
    "SELECT * FROM platform_operations WHERE id=? AND action='purge' AND status='pending'",
    text(requestPayload.operationId, 100),
  );
  requireThat(
    pendingOperation &&
      !host.db.one<Record<string, SqlStorageValue>>(
        'SELECT match_id FROM erasure_ledger WHERE match_id=? AND status!=?',
        pendingOperation.target,
        'cancelled',
      ),
    'CANNOT_CANCEL',
    '清理已进入不可撤销步骤。',
  );
  requireThat(
    host.dataScope(session.account_id, pendingOperation.target),
    'ARCHIVE_SCOPE_REQUIRED',
    '当前账号未获本场数据管理权限。',
    403,
  );
  host.db.tx(() => {
    host.db.exec(
      "UPDATE platform_operations SET status='cancelled' WHERE id=?",
      pendingOperation.id,
    );
    host.db.exec(
      "UPDATE match_directory SET state='available',version=version+1 WHERE id=?",
      pendingOperation.target,
    );
    host.insertOperation(
      id,
      session.account_id,
      'cancel-purge',
      pendingOperation.target,
      bodyHash,
      {},
      reason,
      'succeeded',
    );
  });
  return {status: 200, body: {status: 'cancelled'}};
}
