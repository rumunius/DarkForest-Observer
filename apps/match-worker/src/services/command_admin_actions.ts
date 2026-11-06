import type {SiteConfig} from '@darkforest/contracts';
import {parseJson, text} from '../../../../packages/contracts/src/backend';
import {
  COMMAND_LIMITS,
  commandSpec,
  durationMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import {
  Fault,
  accountPermissions,
  permission,
  type Actor,
} from '../storage/store';
import {updateAccount} from './accounts';
import {matchTime} from './command_clock';
import type {CommandContext} from './command_context';
import {
  validateCommandArguments,
  recordChange,
  recordDependency,
  requireHeadJudge,
  invokeJudgeAction,
  requireCommandArgument,
  parameterKeys,
  saveCommandObject,
  selectTargets,
  settingKeys,
  recordTableDependency,
  renderCommandTemplate,
  commandValue,
} from './command_context';
import {validateParameters} from './judge';
import {finishRecovery} from './recovery';

/** Execute admin commands inside the caller's existing preview or commit transaction. */
export function handleAdminAction(
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

  if (path === 'roster withdraw') {
    requireHeadJudge(commandContext);
    recordTableDependency(commandContext, 'roster_members');
    return each(id => {
      invokeJudgeAction(commandContext, `/judge/roster/${id}/withdraw`, {});
    });
  }

  if (path.startsWith('match ')) {
    return matchTime(commandContext, path, a);
  }

  if (path === 'parameter set') {
    requireHeadJudge(commandContext);
    recordTableDependency(commandContext, 'settings');
    requireCommandArgument(a[0]! in parameterKeys, '未知参数键');
    const key = parameterKeys[a[0]!]!;
    const p = {...db.parameters()};
    const n = /^[+-]?\d+$/.test(a[1]!)
      ? Number(a[1])
      : durationMs(a[1]!) / (key === 'sightingIntervalMs' ? 1 : 1000);
    p[key] = n;
    validateParameters(p);
    return invokeJudgeAction(commandContext, '/judge/parameters', {
      values: p,
      expected_version: db.one<{version: number}>(
        "SELECT version FROM settings WHERE key='parameters'",
      )!.version,
    });
  }

  if (path === 'setting set' || path === 'palette set') {
    permission(commandContext.actor, 'settings');
    const site = parseJson(m.site_json) as SiteConfig;
    const before = structuredClone(site);
    recordDependency(commandContext, 'site', site);
    if (path === 'setting set') {
      requireCommandArgument(m.phase === 'setup', 'T0后活动设置冻结');
      requireCommandArgument(a[0]! in settingKeys, '未知活动设置');
      site[settingKeys[a[0]!]!] = text(a[1], 1000, 0);
    } else {
      requireCommandArgument(
        a[0]! in site.colors && /^#[\da-f]{6}$/i.test(a[1]!),
        '颜色ID或色值不正确',
      );
      site.colors[a[0] as keyof typeof site.colors] = a[1]!;
    }
    site.version++;
    db.exec('UPDATE matches SET site_json=?', JSON.stringify(site));
    recordChange(commandContext, '活动显示配置', before, site);
    return;
  }

  if (path === 'template publish') {
    permission(commandContext.actor, 'settings');
    renderCommandTemplate(commandContext, a[1]!, 'C01');
    const rows = db.all<{version: number}>(
      "SELECT version FROM command_objects WHERE kind='template' AND json_extract(data,'$.name')=?",
      a[0]!,
    );
    const version = Math.max(0, ...rows.map(r => r.version)) + 1;
    const id = saveCommandObject(
      commandContext,
      'template',
      {name: a[0], body: a[1]},
      'TPL',
    );
    db.exec('UPDATE command_objects SET version=? WHERE id=?', version, id);
    recordChange(
      commandContext,
      id,
      '旧模板保留',
      `发布版本${version}，只用于新消息`,
    );
    return;
  }

  if (path.startsWith('account ')) {
    permission(commandContext.actor, 'system');
    const account = db.one<Actor>('SELECT * FROM accounts WHERE id=?', a[0]!);
    requireCommandArgument(account, '账号不存在');
    recordDependency(commandContext, 'account:' + account.id, {
      version: account.version,
      enabled: account.enabled,
      permissions: account.permissions,
    });
    if (path.endsWith('reset-credential')) {
      requireCommandArgument(
        !commandContext.resetAccounts.has(account.id),
        '同批次不能重复重置同一账号，请拆为两个请求',
      );
      commandContext.resetAccounts.add(account.id);
    }
    const delivery = updateAccount(
      e,
      commandContext.actor,
      {
        target: account.id,
        expected_version: account.version,
        operation: path.endsWith('reset-credential')
          ? 'reset'
          : path.split(' ')[1],
        duty: a[1] === 'communication' ? 'communications' : a[1],
      },
      e.commandCredentials[`${commandContext.actor.id}:${account.id}`],
    );
    recordChange(
      commandContext,
      account.id,
      {enabled: account.enabled, permissions: account.permissions},
      '账号已更新，旧会话已撤销',
    );
    return delivery ? {credentialDeliveryId: delivery} : undefined;
  }

  if (path === 'session revoke') {
    permission(commandContext.actor, 'system');
    const account = db.one<Actor>('SELECT * FROM accounts WHERE id=?', a[0]!);
    requireCommandArgument(account, '账号不存在');
    requireCommandArgument(
      !accountPermissions(account).includes('system'),
      '总裁判账号由部署管理员管理',
    );
    db.exec('UPDATE sessions SET revoked=1 WHERE account_id=?', account.id);
    recordChange(commandContext, account.id, '原会话', '全部撤销');
    return;
  }

  if (path === 'recovery finalize') {
    requireHeadJudge(commandContext);
    permission(commandContext.actor, 'system');
    finishRecovery(e);
    recordChange(commandContext, '恢复核对', '待核对', '已完成，维持一般暂停');
    return;
  }

  if (path === 'export create') {
    requireCommandArgument(
      ['report', 'audit', 'checkpoint'].includes(a[0]!),
      '未知导出类型',
    );
    if (a[0] === 'checkpoint') {
      requireCommandArgument(
        m.phase === 'setup' || m.phase === 'ended' || m.paused_at !== null,
        '检查点导出需要暂停、赛前或赛后',
      );
    }
    const id = saveCommandObject(
      commandContext,
      'export',
      {
        kind: a[0],
        download: `/api/judge/export?kind=${a[0]}`,
        requiresAuthentication: true,
      },
      'EXP',
    );
    recordChange(
      commandContext,
      id,
      '无',
      '已创建受保护导出入口，下载时重新鉴权和核对',
    );
    return {id, download: `/api/judge/export?kind=${a[0]}`};
  }

  throw new Fault(400, 'UNKNOWN_COMMAND', '命令没有执行处理器：' + path);
}
