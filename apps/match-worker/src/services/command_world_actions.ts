import {
  coordinate,
  integer,
  text,
} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  commandSpec,
  durationMs,
  instantMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {Fault, permission} from '../storage/store';
import {correctAttack, correctionTarget} from './attack_correction';
import type {CommandContext} from './command_context';
import {
  validateCommandArguments,
  recordChange,
  emitCommandMessage,
  requireHeadJudge,
  invokeJudgeAction,
  requireCommandArgument,
  singleTarget,
  requireRunningMatch,
  saveCommandObject,
  selectTargets,
  recordTableDependency,
  commandValue,
} from './command_context';
import {judgeAction} from './judge';

/** Execute world commands inside the caller's existing preview or commit transaction. */
export function handleWorldAction(
  commandContext: CommandContext,
  n: CommandNode,
): unknown {
  const spec = commandSpec(n)!;

  permission(commandContext.actor, spec.permission);

  validateCommandArguments(n);

  const e = commandContext.e;

  const db = e.db;

  const m = db.match();

  const path = spec.path;

  const a = n.words
    .slice(path.split(' ').length)
    .map(v => commandValue(v, commandContext));

  const chosen = (index = 0, pool = false) =>
    selectTargets(commandContext, a[index]!, pool);

  const each = (fn: (id: string) => void, pool = false) => {
    const ids = chosen(0, pool);
    for (const id of ids) {
      if (++commandContext.work > COMMAND_LIMITS.work) {
        throw new Fault(
          413,
          'COMMAND_BUDGET',
          '一次提交的操作过多，请缩小范围，或添加 --mode sequential 分步执行。',
        );
      }
      const before = {
        player: db.player(id),
        flight: db.flight(id),
        home: db.home(id) ?? null,
      };
      fn(id);
      recordChange(commandContext, id, before, {
        player: db.player(id),
        flight: db.flight(id),
        home: db.home(id) ?? null,
      });
    }
    if (!ids.length) {
      commandContext.notes.push('0人，无变化。');
    }
    return ids;
  };

  if (path === 'homeworld verify' || path === 'homeworld reject') {
    const id = singleTarget(commandContext, a[0]!);
    const h = db.home(id);
    requireCommandArgument(h, '尚无登记');
    return judgeAction(
      e,
      commandContext.actor,
      `${commandContext.id}-${commandContext.work}`,
      `/judge/homeworld/${id}/verify`,
      {
        request_id: `${commandContext.id}-${commandContext.work}`,
        expected_version: integer(Number(a[2]), 1),
        expected_code: path.endsWith('verify') ? coordinate(a[4]) : h.code,
        decision: path.endsWith('verify') ? 'approve' : 'reject',
        reason: commandContext.reason,
      },
      commandContext.prepared,
    );
  }

  if (path === 'homeworld correct-coordinate') {
    requireHeadJudge(commandContext);
    requireCommandArgument(m.phase === 'setup', 'T0首次锁定后不能修改母星登记');
    const id = singleTarget(commandContext, a[0]!);
    const h = db.home(id);
    requireCommandArgument(h, '尚无登记');
    db.exec(
      "UPDATE homeworlds SET code=?,version=version+1,status='pending',verified_by=NULL,rejection='' WHERE player_id=?",
      coordinate(a[1]),
      id,
    );
    recordChange(commandContext, id + '母星', h, db.home(id));
    return;
  }

  if (path.startsWith('code ')) {
    requireHeadJudge(commandContext);
    recordTableDependency(commandContext, 'sighting_codes');
    return each(id => {
      const f = db.flight(id);
      if (path === 'code replace-same') {
        requireCommandArgument(
          ['BK', 'WH', 'GY', 'YL', 'OR', 'SB', 'PU'].includes(a[1]!),
          '未知颜色',
        );
        requireCommandArgument(f.code_id, '当前没有可替换手环');
        recordChange(commandContext, id + '实物替换', '原同色实物', a[1]);
        return;
      }
      if (path === 'code activate') {
        if (a[1]) {
          requireCommandArgument(
            a[1] === 'issue' && a[2] === f.code_id,
            '发行编号与当前待激活配置不符',
          );
        }
        if (commandContext.deferred) {
          requireCommandArgument(
            db.one<Record<string, SqlStorageValue>>(
              "SELECT id FROM command_objects WHERE kind='equipment-check' AND json_extract(data,'$.issue')=? AND json_extract(data,'$.target')=?",
              f.code_id,
              id,
            ),
            '定时器不能代替现场佩戴核对，请现场执行code activate',
          );
        } else {
          saveCommandObject(
            commandContext,
            'equipment-check',
            {target: id, issue: f.code_id, checkedBy: commandContext.actor.id},
            'WEAR',
          );
        }
      }
      invokeJudgeAction(commandContext, '/judge/equipment-correction', {
        target: id,
        mode: path === 'code activate' ? 'activate' : 'reissue',
      });
    });
  }

  if (path === 'attack invalidate' || path === 'attack correct-penalty') {
    requireHeadJudge(commandContext);
    recordTableDependency(commandContext, 'attacks');
    recordTableDependency(commandContext, 'sighting_codes');
    const attack = correctionTarget(e, a[0]);
    if (path.endsWith('correct-penalty')) {
      requireCommandArgument(
        attack.wrong_index !== null,
        '这次攻击没有因提交错误目击码而受到处罚。',
      );
    }
    correctAttack(
      e,
      `${commandContext.id}-${commandContext.work}`,
      commandContext.actor.id,
      attack,
      commandContext.reason,
      commandContext.prepared,
    );
    recordChange(
      commandContext,
      a[0]!,
      attack,
      '已审计更正，保留原抽签和传播事实',
    );
    return;
  }

  if (path.startsWith('effect ')) {
    recordTableDependency(commandContext, 'admin_effects');
    if (path === 'effect create attack-silence') {
      requireRunningMatch(commandContext);
      const ids = chosen();
      const global = a[0] === '@a';
      const length = a[2] === 'until-revoked' ? null : durationMs(a[2]!);
      const end = n.options['end-at']
        ? instantMs(n.options['end-at'])
        : length === null
          ? 8640000000000000
          : e.now() + length;
      requireCommandArgument(
        a[1] === 'for' && end > e.now(),
        '静默期限必须晚于当前时间',
      );
      integer(end);
      for (const id of global ? ['@a'] : ids) {
        const fx = `FX-${commandContext.id}-${commandContext.work++}`;
        db.exec(
          'INSERT INTO admin_effects VALUES(?,?,?,?,?,?,1)',
          fx,
          id,
          e.now(),
          end,
          commandContext.reason,
          commandContext.actor.name,
        );
        recordChange(
          commandContext,
          fx,
          '未生效',
          `${id} 目击静默至 ${new Date(end).toISOString()}`,
        );
      }
      return;
    }
    const ids = path === 'effect clear' ? chosen() : [];
    const effects = db
      .all<{id: string; target: string}>(
        'SELECT id,target FROM admin_effects WHERE active=1 AND ends>?',
        e.now(),
      )
      .filter(f =>
        path === 'effect revoke'
          ? f.id === a[0]
          : f.target === '@a' || ids.includes(f.target),
      );
    for (const f of effects) {
      if (f.target === '@a') {
        commandContext.notes.push(
          '将撤销这项全场效果。个人处罚和当前阶段的行动限制继续生效。',
        );
      }
      db.exec('UPDATE admin_effects SET active=0 WHERE id=?', f.id);
      recordChange(commandContext, f.id, '生效', '撤销');
    }
    return;
  }

  if (path === 'announce' || path === 'tell') {
    const ids = chosen();
    emitCommandMessage(
      commandContext,
      ids,
      text(a[1], COMMAND_LIMITS.bytes),
      path === 'announce' && a[0] === '@a',
    );
    return;
  }

  throw new Fault(400, 'UNKNOWN_COMMAND', '命令没有执行处理器：' + path);
}
