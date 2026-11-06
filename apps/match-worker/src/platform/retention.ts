import type {DarkForestPlatform} from './platform';
import {requireThat} from '../storage/store';

// Match recovery never rewinds this database.
export function erasureFloor(p: DarkForestPlatform, matchId: string): number {
  return (
    p.db.one<{generation: number}>(
      "SELECT generation FROM erasure_ledger WHERE match_id=? AND status!='cancelled'",
      matchId,
    )?.generation ?? 0
  );
}

export async function erasureOperation(
  p: DarkForestPlatform,
  op: {id: string; actor: string; target: string},
) {
  const d = p.directory(op.target);
  const current = await p.summary(d, op.actor);
  requireThat(
    current.phase === 'ended',
    'ENDED_REQUIRED',
    '只有已完赛的比赛可以清理。',
  );
  requireThat(
    Number(current.endedUtc) > 0 &&
      p.now() >= Number(current.endedUtc) + d.retention_days * 86400000,
    'RETENTION_ACTIVE',
    '完整复盘的保留期尚未结束。',
  );
  requireThat(
    current.reportVersion,
    'REPORT_REQUIRED',
    '正式战报尚未生成，暂不能清理。',
  );
  const generation = p.db.tx(() => {
    requireThat(
      !p.db.one('SELECT match_id FROM retention_holds WHERE match_id=?', d.id),
      'RETENTION_HOLD',
      '本场资料因申诉暂缓清理。',
    );
    requireThat(
      p.dataScope(op.actor, d.id),
      'ARCHIVE_SCOPE_REQUIRED',
      '发起人已失去本场管理权限。',
      403,
    );
    const existing = erasureFloor(p, d.id);
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
    p.db.exec(
      "INSERT OR REPLACE INTO erasure_ledger VALUES(?,?,'nonessential-secrets',?,?,'pending',?)",
      d.id,
      next,
      p.now(),
      p.now(),
      '保留期限结束后的隐私清理',
    );
    return next;
  });
  const online = await p.control(
    d,
    `${op.id}:online`,
    'erase',
    op.actor,
    '保留期限结束后的隐私清理',
    {generation},
  );
  p.db.tx(() => {
    p.db.exec(
      "UPDATE erasure_ledger SET status='succeeded' WHERE match_id=?",
      d.id,
    );
    p.db.exec(
      "UPDATE match_directory SET state='purged',version=version+1 WHERE id=?",
      d.id,
    );
  });
  return {
    online,
    generation,
    warning: '网站资料已清理。请另行处理此前下载的文件。',
  };
}
