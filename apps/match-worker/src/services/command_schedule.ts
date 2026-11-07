import {integer, parseJson} from '../../../../packages/contracts/src/backend';
import {
  commandSpec,
  durationMs,
  instantMs,
  type CommandNode,
} from '../../../../packages/contracts/src/commands';
import type {CommandContext} from './command_context';
import {
  commandValue,
  recordChange,
  requireCommandArgument,
  saveCommandObject,
  unquoteArgument,
} from './command_context';
import {pin, type MacroData} from './command_macros';
import {targets} from './command_targets';
import {type Engine} from './engine';

/** 持久定时命令的正文与目标快照，恢复后仍需重新核对创建者授权。 */
export interface TaskData {
  node: CommandNode;
  due: number;
  clock: 'utc' | 'game';
  late: 'run' | 'skip' | 'review';
  maxLateness: number | null;
  afterEnd: 'keep' | 'cancel';
  snapshot: Record<string, string[]>;
  reason: string;
  source: string;
  caseId?: string | undefined;
  results?: unknown;
  error?: string;
  job?: string;
}

function macroBody(
  engine: Engine,
  commandNode: CommandNode,
): CommandNode[] | undefined {
  if (commandSpec(commandNode)?.path !== 'macro run') {
    return;
  }
  const versionIndex = commandNode.words.indexOf('version');
  if (versionIndex < 0) {
    return;
  }
  const row = engine.db.one<{data: string}>(
    "SELECT data FROM command_objects WHERE kind='macro' AND json_extract(data,'$.name')=? AND version=?",
    unquoteArgument(commandNode.words[2]),
    integer(Number(commandNode.words[versionIndex + 1]), 1),
  );
  return row ? (parseJson(row.data) as MacroData).block : undefined;
}

/** 判断命令树是否仅产生管理消息，用于完赛后保留通知任务的策略。 */
export function isMessage(engine: Engine, commandNode: CommandNode): boolean {
  if (
    ['announce', 'tell', 'notice', 'reveal', 'replay'].includes(
      commandNode.words[0]!,
    )
  ) {
    return true;
  }
  const block =
    macroBody(engine, commandNode) ??
    (['batch', 'execute'].includes(commandNode.words[0]!)
      ? commandNode.block
      : undefined);
  if (block) {
    return block.every(child => isMessage(engine, child));
  }
  return false;
}

function collectSnapshot(
  commandContext: CommandContext,
  commandNode: CommandNode,
  result: Record<string, string[]>,
): void {
  for (const w of commandNode.words) {
    if (/^@(a|alive|dead|random|pool)(\[|$)/.test(w)) {
      result[w] = targets(
        commandContext.engine,
        w,
        commandContext.self,
        true,
        commandContext.bindings,
      ).candidates;
    }
  }
  for (const child of commandNode.block ?? []) {
    collectSnapshot(commandContext, child, result);
  }
  for (const child of macroBody(commandContext.engine, commandNode) ?? []) {
    collectSnapshot(commandContext, child, result);
  }
}
/** 按原授权顺序固定正文、核对计划并持久登记一次定时命令。 */
export function createSchedule(
  commandContext: CommandContext,
  commandNode: CommandNode,
): unknown {
  requireCommandArgument(
    (commandNode.block?.length &&
      commandNode.words.length === 7 &&
      commandNode.words[5] === 'run') ||
      (commandNode.block?.length &&
        commandNode.words.length === 6 &&
        commandNode.words[5] === 'run'),
    '用法：schedule create utc|game in|at 时间 run { 操作 }',
  );
  const clock = commandNode.words[2];
  const mode = commandNode.words[3];
  const raw = commandValue(commandNode.words[4], commandContext);
  requireCommandArgument(
    clock === 'utc' || clock === 'game',
    '时基为utc或game',
  );
  requireCommandArgument(mode === 'at' || mode === 'in', '时间模式为at或in');
  const block = structuredClone(commandNode.block);
  for (const node of block) {
    pin(commandContext, node);
  }
  const due = scheduleTime(commandContext, clock, mode, raw);
  const node: CommandNode = {words: ['batch', 'run'], block, options: {}};
  const {late, afterEnd} = schedulePolicy(commandContext, commandNode, node);
  const snapshot: Record<string, string[]> = {};
  if (commandNode.options.targets === 'snapshot') {
    collectSnapshot(commandContext, node, snapshot);
  }
  const data: TaskData = {
    node,
    due,
    clock,
    late,
    maxLateness: commandNode.options['max-lateness']
      ? durationMs(commandNode.options['max-lateness'])
      : null,
    afterEnd,
    snapshot,
    reason: commandContext.reason,
    source: commandContext.source,
    caseId: commandContext.caseId,
  };
  const id = saveCommandObject(
    commandContext,
    'schedule',
    data,
    'SCH',
    'pending',
  );
  commandContext.engine.schedule(id, 'judge_command_task', clock, due, 3, {id});
  recordChange(
    commandContext,
    id,
    '无定时任务',
    `${clock === 'utc' ? new Date(due).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}) + ' 北京时间' : `有效比赛${due}毫秒`}；目标${commandNode.options.targets ?? 'live'}；迟到${late}；赛后${afterEnd}`,
  );
  commandContext.notes.push(
    '到期时重新检查创建者权限、比赛暂停情况、现场核对记录和当前操作条件。随机目标在执行时抽取；淘汰或恢复文明可能影响提前完赛。',
  );
  return {id};
}

/** 顺序作业的持久进度与步骤，失败后保持已完成步骤和原操作来源。 */
export interface JobData {
  steps: CommandNode[];
  next: number;
  results: unknown[];
  reason: string;
  error?: string;
}
/** 保存固定版本的逐步作业及首个唤醒，不执行其中业务步骤。 */
export function createJob(
  commandContext: CommandContext,
  steps: CommandNode[],
): unknown {
  const pinned = structuredClone(steps);
  for (const node of pinned) {
    pin(commandContext, node);
  }
  const id = saveCommandObject(
    commandContext,
    'job',
    {
      steps: pinned,
      next: 0,
      results: [],
      reason: commandContext.reason,
    } satisfies JobData,
    'JOB',
    'pending',
  );
  commandContext.engine.schedule(
    `${id}:0`,
    'judge_command_job',
    'utc',
    commandContext.engine.now(),
    3,
    {
      job: id,
      index: 0,
    },
  );
  recordChange(
    commandContext,
    id,
    '无作业',
    `${steps.length}步独立提交；失败停止，已提交步骤不回滚，每步检查提前完赛。`,
  );
  return {id};
}
/** 转换已核对的时基和时间模式，拒绝溢出或非整数生效时刻。 */
function scheduleTime(
  commandContext: CommandContext,
  clock: TaskData['clock'],
  mode: 'in' | 'at',
  raw: string,
): number {
  let due: number;
  if (mode === 'in') {
    due =
      (clock === 'utc'
        ? commandContext.engine.now()
        : commandContext.engine.game()) + durationMs(raw);
  } else if (clock === 'utc') {
    due = instantMs(raw);
  } else {
    const m = /^g(\d+):([0-5]\d)(?:\.(\d{3}))?$/.exec(raw);
    requireCommandArgument(m, '游戏时刻须为g分:秒[.毫秒]');
    due = Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3] ?? 0);
  }
  integer(due);
  return due;
}
interface SchedulePolicy {
  late: TaskData['late'];
  afterEnd: TaskData['afterEnd'];
}
/** 按展开内容核对迟到、赛后和目标策略，混合战局任务不能保留到赛后。 */
function schedulePolicy(
  commandContext: CommandContext,
  commandNode: CommandNode,
  node: CommandNode,
): SchedulePolicy {
  const message = isMessage(commandContext.engine, node);
  const late = commandNode.options.late ?? (message ? 'run' : 'review');
  const afterEnd =
    commandNode.options['after-end'] ?? (message ? 'keep' : 'cancel');
  requireCommandArgument(
    ['run', 'skip', 'review'].includes(late),
    'late须为run/skip/review',
  );
  requireCommandArgument(
    ['keep', 'cancel'].includes(afterEnd),
    'after-end须为keep/cancel',
  );
  requireCommandArgument(
    afterEnd !== 'keep' || message,
    '混合或战局任务不能在赛后执行',
  );
  requireCommandArgument(
    !commandNode.options.targets ||
      ['live', 'snapshot'].includes(commandNode.options.targets),
    'targets为live或snapshot',
  );
  // 上述白名单检查已限定这两个联合值；不把断言当作另一层校验。
  return {
    late: late as TaskData['late'],
    afterEnd: afterEnd as TaskData['afterEnd'],
  };
}
