import type {DarkForestPlatform} from './platform';
import {requireThat} from '../storage/store';

// Match recovery never rewinds this database.
/** 读取不可回退的资料清理世代，用于阻止恢复旧检查点重新暴露已清理信息。 */
export function erasureFloor(p: DarkForestPlatform, matchId: string): number {
  return (
    p.db.one<{generation: number}>(
      "SELECT generation FROM erasure_ledger WHERE match_id=? AND status!='cancelled'",
      matchId,
    )?.generation ?? 0
  );
}

/** 执行有持久收据的清理协议；重试复用原操作并保留不可回退边界。 */
export async function erasureOperation(
  platform: DarkForestPlatform,
  op: {id: string; actor: string; target: string},
) {
  const matchEntry = platform.directory(op.target);
  const current = await platform.summary(matchEntry, op.actor);
  requireThat(
    current.phase === 'ended',
    'ENDED_REQUIRED',
    '只有已完赛的比赛可以清理。',
  );
  requireThat(
    Number(current.endedUtc) > 0 &&
      platform.now() >=
        Number(current.endedUtc) + matchEntry.retention_days * 86400000,
    'RETENTION_ACTIVE',
    '完整复盘的保留期尚未结束。',
  );
  requireThat(
    current.reportVersion,
    'REPORT_REQUIRED',
    '正式战报尚未生成，暂不能清理。',
  );
  const generation = platform.db.tx(() => {
    requireThat(
      !platform.db.one<Record<string, SqlStorageValue>>(
        'SELECT match_id FROM retention_holds WHERE match_id=?',
        matchEntry.id,
      ),
      'RETENTION_HOLD',
      '本场资料因申诉暂缓清理。',
    );
    requireThat(
      platform.dataScope(op.actor, matchEntry.id),
      'ARCHIVE_SCOPE_REQUIRED',
      '发起人已失去本场管理权限。',
      403,
    );
    const existing = erasureFloor(platform, matchEntry.id);
    if (existing) {
      return existing;
    }
    requireThat(
      !current.recovering,
      'RECOVERY_LOCKED',
      '比赛正在恢复，请先完成恢复再清理。',
    );
    requireThat(
      Number.isSafeInteger(current.erasureGeneration) &&
        Number(current.erasureGeneration) >= 0,
      'ERASURE_STATE_UNKNOWN',
      '暂时无法核对比赛的清理记录，请稍后重试。',
      503,
    );
    const next = Number(current.erasureGeneration) + 1;
    platform.db.exec(
      "INSERT OR REPLACE INTO erasure_ledger VALUES(?,?,'nonessential-secrets',?,?,'pending',?)",
      matchEntry.id,
      next,
      platform.now(),
      platform.now(),
      '保留期限结束后的隐私清理',
    );
    return next;
  });
  const online = await platform.control(
    matchEntry,
    `${op.id}:online`,
    'erase',
    op.actor,
    '保留期限结束后的隐私清理',
    {generation},
  );
  platform.db.tx(() => {
    platform.db.exec(
      "UPDATE erasure_ledger SET status='succeeded' WHERE match_id=?",
      matchEntry.id,
    );
    platform.db.exec(
      "UPDATE match_directory SET state='purged',version=version+1 WHERE id=?",
      matchEntry.id,
    );
  });
  return {
    online,
    generation,
    warning: '网站资料已清理。请另行处理此前下载的文件。',
  };
}
