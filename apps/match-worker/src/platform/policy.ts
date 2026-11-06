import {integer} from '../../../../packages/contracts/src/backend';
import {requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import type {Operation} from './types';

/** 要求提交版本与当前持久版本一致，拒绝对过时预览继续操作。 */
export function assertVersion(
  _host: DarkForestPlatform,
  row: {version: number},
  version: unknown,
) {
  requireThat(
    row.version === integer(version, 1),
    'VERSION_CONFLICT',
    '内容已变化，请刷新后重新预览。',
  );
}

/** 阻止移除最后一名有效所有者，保留平台恢复访问的责任主体。 */
export function protectOwner(host: DarkForestPlatform, id: string) {
  if (host.roles(id).includes('owner')) {
    requireThat(
      host.db.one<{n: number}>(
        "SELECT COUNT(*) AS n FROM platform_roles r JOIN platform_accounts a ON a.id=r.account_id WHERE r.role='owner' AND a.status='active' AND a.id!=?",
        id,
      )!.n > 0,
      'LAST_OWNER',
      '至少保留一名已激活且可恢复访问的所有者。',
    );
  }
}

/** 隐藏内部请求摘要和负载，仅投影当前操作及各目标执行收据。 */
export function operationView(host: DarkForestPlatform, op: Operation) {
  return {
    ...op,
    payload: undefined,
    body_hash: undefined,
    receipts: host.db.all<Record<string, SqlStorageValue>>(
      'SELECT target,status,receipt FROM operation_targets WHERE operation_id=?',
      op.id,
    ),
  };
}
