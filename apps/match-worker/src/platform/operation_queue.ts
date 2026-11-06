import {
  parseJson,
  scalarText,
} from '../../../../packages/contracts/src/backend';
import {Fault, requireThat} from '../storage/store';
import type {DarkForestPlatform} from './platform';
import {erasureOperation} from './retention';
import type {Operation} from './types';

/** 依持久队列执行平台任务，逐目标保存收据并在失败后保留重试状态。 */
export async function alarm(host: DarkForestPlatform) {
  host.db.exec(
    'UPDATE invitations SET ciphertext=NULL WHERE delivery_expires<?',
    host.now(),
  );
  host.db.exec(
    'DELETE FROM platform_sessions WHERE expires<?',
    host.now() - 30 * 86400000,
  );
  const operations = host.db.all<Operation>(
    "SELECT * FROM platform_operations WHERE status IN ('pending','partial') AND attempts<8 AND next_attempt<=? AND action!='adopt-legacy' ORDER BY created_utc LIMIT 4",
    host.now(),
  );
  for (const operation of operations) {
    try {
      const owner = host.account(operation.actor);
      requireThat(
        owner.status === 'active',
        'AUTHOR_DISABLED',
        '任务发起账号已停用，需要管理员重新核对。',
      );
      if (!operation.action.startsWith('control:')) {
        requireThat(
          host
            .roles(operation.actor)
            .some(r => ['owner', 'admin', 'archivist'].includes(r)),
          'AUTHOR_REVOKED',
          '任务发起人已失去管理权限。',
        );
      }
      const payload = parseJson(operation.payload) as Record<string, unknown>;
      let result: unknown = {};
      if (operation.action === 'create') {
        const matchEntry = host.directory(operation.target);
        result = await host.control(
          matchEntry,
          operation.id,
          'initialize',
          operation.actor,
          '网站新建独立比赛',
          payload,
        );
        host.db.exec(
          "UPDATE match_directory SET state='draft',version=version+1 WHERE id=?",
          matchEntry.id,
        );
      } else if (operation.action.startsWith('control:')) {
        const directoryEntry = host.directory(operation.target);
        const action = operation.action.slice(8);
        if (
          ['invite', 'remove-member', 'assign', 'publish'].includes(action) &&
          !host.roles(operation.actor).some(r => ['owner', 'admin'].includes(r))
        ) {
          const latest = await host.summary(directoryEntry, operation.actor);
          requireThat(
            (
              latest.members as Array<{
                account_id: string;
                local_id: string;
                state: string;
              }>
            ).some(
              m =>
                m.account_id === operation.actor &&
                m.local_id === 'J01' &&
                m.state === 'bound',
            ),
            'AUTHOR_REVOKED',
            '原总裁判已失去任职，请由新人重新提交。',
          );
        }
        if (payload.accountId && action !== 'remove-member') {
          requireThat(
            host.account(scalarText(payload.accountId)).status !== 'disabled',
            'ACCOUNT_DISABLED',
            '目标账号已停用。',
          );
        }
        result = await host.control(
          directoryEntry,
          operation.id,
          action,
          scalarText(payload.controlActor ?? operation.actor),
          '网站本场管理',
          payload,
        );
        if (action === 'publish') {
          host.db.exec(
            "UPDATE match_directory SET state='available',version=version+1 WHERE id=?",
            directoryEntry.id,
          );
        }
      } else if (operation.action === 'fence') {
        const targets = host.db.all<{target: string}>(
          'SELECT target FROM operation_targets WHERE operation_id=? AND status!=? LIMIT 8',
          operation.id,
          'succeeded',
        );
        for (const target of targets) {
          try {
            const receipt = await host.control(
              host.directory(target.target),
              `${operation.id}:${target.target}`,
              'fence',
              operation.actor,
              '全局账号授权更新',
              payload,
            );
            host.db.exec(
              "UPDATE operation_targets SET status='succeeded',receipt=? WHERE operation_id=? AND target=?",
              JSON.stringify(receipt),
              operation.id,
              target.target,
            );
          } catch {
            host.db.exec(
              "UPDATE operation_targets SET status='failed',receipt=? WHERE operation_id=? AND target=?",
              JSON.stringify({message: '连接未确认，请重试原步骤。'}),
              operation.id,
              target.target,
            );
          }
        }
        if (
          host.db.one<Record<string, SqlStorageValue>>(
            'SELECT target FROM operation_targets WHERE operation_id=? AND status!=?',
            operation.id,
            'succeeded',
          )
        ) {
          host.db.exec(
            "UPDATE platform_operations SET status='partial',attempts=attempts+1,next_attempt=? WHERE id=?",
            host.now() + Math.min(300000, 1000 * 2 ** operation.attempts),
            operation.id,
          );
          continue;
        }
        result = {allFenced: true};
      } else if (operation.action === 'purge') {
        requireThat(
          host.dataScope(operation.actor, operation.target),
          'ARCHIVE_SCOPE_REQUIRED',
          '任务发起人已失去本场数据权限。',
        );
        result = await erasureOperation(host, operation);
      } else {
        throw new Error('UNKNOWN_OPERATION');
      }
      host.db.exec(
        "UPDATE platform_operations SET status='succeeded',result=?,error='' WHERE id=?",
        JSON.stringify(result),
        operation.id,
      );
    } catch (error) {
      host.db.exec(
        "UPDATE platform_operations SET status='failed',attempts=attempts+1,error=? WHERE id=?",
        error instanceof Fault
          ? error.message
          : '未取得完整收据，源数据保留；可重试原任务。',
        operation.id,
      );
    }
  }
  await host.arm();
}
