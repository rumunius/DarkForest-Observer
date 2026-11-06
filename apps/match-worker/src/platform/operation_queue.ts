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
  for (const op of operations) {
    try {
      const owner = host.account(op.actor);
      requireThat(
        owner.status === 'active',
        'AUTHOR_DISABLED',
        '任务发起账号已停用，需要管理员重新核对。',
      );
      if (!op.action.startsWith('control:')) {
        requireThat(
          host
            .roles(op.actor)
            .some(r => ['owner', 'admin', 'archivist'].includes(r)),
          'AUTHOR_REVOKED',
          '任务发起人已失去管理权限。',
        );
      }
      const p = parseJson(op.payload) as Record<string, unknown>;
      let result: unknown = {};
      if (op.action === 'create') {
        const d = host.directory(op.target);
        result = await host.control(
          d,
          op.id,
          'initialize',
          op.actor,
          '网站新建独立比赛',
          p,
        );
        host.db.exec(
          "UPDATE match_directory SET state='draft',version=version+1 WHERE id=?",
          d.id,
        );
      } else if (op.action.startsWith('control:')) {
        const d = host.directory(op.target);
        const action = op.action.slice(8);
        if (
          ['invite', 'remove-member', 'assign', 'publish'].includes(action) &&
          !host.roles(op.actor).some(r => ['owner', 'admin'].includes(r))
        ) {
          const latest = await host.summary(d, op.actor);
          requireThat(
            (
              latest.members as Array<{
                account_id: string;
                local_id: string;
                state: string;
              }>
            ).some(
              m =>
                m.account_id === op.actor &&
                m.local_id === 'J01' &&
                m.state === 'bound',
            ),
            'AUTHOR_REVOKED',
            '原总裁判已失去任职，请由新人重新提交。',
          );
        }
        if (p.accountId && action !== 'remove-member') {
          requireThat(
            host.account(scalarText(p.accountId)).status !== 'disabled',
            'ACCOUNT_DISABLED',
            '目标账号已停用。',
          );
        }
        result = await host.control(
          d,
          op.id,
          action,
          scalarText(p.controlActor ?? op.actor),
          '网站本场管理',
          p,
        );
        if (action === 'publish') {
          host.db.exec(
            "UPDATE match_directory SET state='available',version=version+1 WHERE id=?",
            d.id,
          );
        }
      } else if (op.action === 'fence') {
        const targets = host.db.all<{target: string}>(
          'SELECT target FROM operation_targets WHERE operation_id=? AND status!=? LIMIT 8',
          op.id,
          'succeeded',
        );
        for (const target of targets) {
          try {
            const receipt = await host.control(
              host.directory(target.target),
              `${op.id}:${target.target}`,
              'fence',
              op.actor,
              '全局账号授权更新',
              p,
            );
            host.db.exec(
              "UPDATE operation_targets SET status='succeeded',receipt=? WHERE operation_id=? AND target=?",
              JSON.stringify(receipt),
              op.id,
              target.target,
            );
          } catch {
            host.db.exec(
              "UPDATE operation_targets SET status='failed',receipt=? WHERE operation_id=? AND target=?",
              JSON.stringify({message: '连接未确认，请重试原步骤。'}),
              op.id,
              target.target,
            );
          }
        }
        if (
          host.db.one<Record<string, SqlStorageValue>>(
            'SELECT target FROM operation_targets WHERE operation_id=? AND status!=?',
            op.id,
            'succeeded',
          )
        ) {
          host.db.exec(
            "UPDATE platform_operations SET status='partial',attempts=attempts+1,next_attempt=? WHERE id=?",
            host.now() + Math.min(300000, 1000 * 2 ** op.attempts),
            op.id,
          );
          continue;
        }
        result = {allFenced: true};
      } else if (op.action === 'purge') {
        requireThat(
          host.dataScope(op.actor, op.target),
          'ARCHIVE_SCOPE_REQUIRED',
          '任务发起人已失去本场数据权限。',
        );
        result = await erasureOperation(host, op);
      } else {
        throw new Error('UNKNOWN_OPERATION');
      }
      host.db.exec(
        "UPDATE platform_operations SET status='succeeded',result=?,error='' WHERE id=?",
        JSON.stringify(result),
        op.id,
      );
    } catch (error) {
      host.db.exec(
        "UPDATE platform_operations SET status='failed',attempts=attempts+1,error=? WHERE id=?",
        error instanceof Fault
          ? error.message
          : '未取得完整收据，源数据保留；可重试原任务。',
        op.id,
      );
    }
  }
  await host.arm();
}
