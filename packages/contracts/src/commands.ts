import {parseJson} from './backend';
/** DF-Judge/1: shared, executable command catalogue and syntax. No browser rule engine. */
export const LANGUAGE_VERSION = 'DF-Judge/1';
/** 共享命令语法与执行预算，服务端仍必须限制组合深度和输出大小。 */
export const COMMAND_LIMITS = {
  bytes: 256 * 1024,
  depth: 32,
  page: 50,
  maxPage: 1000,
  responseBytes: 1024 * 1024,
  work: 12000,
};
/** Count UTF-8 without importing a DOM or Node runtime into the public contracts package. */
export function commandByteLength(input: string): number {
  let size = 0;
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    size += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return size;
}
/** 注册命令的参数、权限及执行模式描述，供解析和帮助共同使用。 */
export interface CommandSpec {
  path: string;
  args: string;
  description: string;
  permission: string;
  query: boolean;
  direct: boolean;
}
const groups: Array<[string, string, string]> = [
  [
    'help|["命令路径"]|中文帮助;version||语言版本;whoami||当前操作者;capability list||权限列表;selector inspect|<target>|预览目标集合;match status||比赛状态;roster list||正式名单;preflight list||准备缺项;player list||文明列表;inspect|<target>|文明状态;history|<target> [kind <history-kind>]|文明分类历史;flight list|<target>|航次历史;flight inspect|<id>|航次详情;player resources|<target>|资源与来源;player restrictions|<target>|行动限制;clock status||比赛时钟;clock pauses||暂停历史;tag list|<target>|文明标签;observer status|<target>|观战资格;stats count|<target>|文明数量;stats sum|<score> of <target>|资源与战绩总计;stats events|<kind> [window <duration>]|有效事件统计;event-log list||已发生事件;event-log inspect|<id>|事件事实详情',
    'overview',
    'query',
  ],
  [
    'homeworld pending||待审核母星;homeworld inspect|<target>|母星登记详情',
    'homeworlds',
    'query',
  ],
  [
    'event list||真实事件计划;event inspect|<id>|计划详情;effect list||静默效果;effect inspect|<id>|效果详情;scheduler health||调度健康',
    'events',
    'query',
  ],
  [
    'notice list||通知待办;notice inspect|<id>|通知及发送履历;template list||消息模板;template preview|<id> for <target>|预览模板',
    'notices',
    'query',
  ],
  [
    'audit list||业务审计;audit inspect|<id>|审计详情;command history||命令历史',
    'audit',
    'query',
  ],
  [
    'codebook status||码本容量;codebook list||发行历史;code inspect|<id>|手环发行详情;attack list|[<target>]|攻击记录;attack inspect|<id>|攻击详情;case list||个案列表;case inspect|<id>|个案详情;case graph|<id>|个案关联图;hunt status||终局核验;hunt draft inspect|<id>|核验草稿;report show|[version <int>]|正式战报;report versions||战报版本;schedule list||定时任务;schedule inspect|<id>|任务详情;macro list||宏版本;macro inspect|<text> [version <int>]|宏详情;job list||逐步作业;job inspect|<id>|作业进度',
    'commands',
    'query',
  ],
  [
    'parameter list||赛前参数;parameter inspect|<parameter>|参数详情;setting list||活动设置;palette list||七色显示;account list||账号列表;account inspect|<id>|账号详情;session list|<id>|会话概况;export inspect|<id>|导出记录;recovery status||恢复状态;recovery checklist||恢复核对清单',
    'system',
    'query',
  ],
  [
    'roster add|<target>|加入正式名单;roster remove|<target>|移出正式名单;roster withdraw|<target>|登记缺席退出;match arm-release|at <instant>|锁定未来发码时间;match arm-start|at <instant>|锁定未来开赛时间;match postpone-release|at <instant>|推迟未来发码;match postpone-start|at <instant>|推迟未来开赛;match cancel-release||撤销未来发码;match cancel-start||撤销未来开赛;clock pause||暂停比赛;clock resume||恢复比赛;penalty lock|<target> for <duration>|个人禁止目击攻击;penalty clear|<target>|解除个人禁止目击攻击;penalty wrong-set|<target> <int>|设置错误目击码次数;player eliminate|<target> [<reason>]|永久淘汰;player restore|<target>|恢复参赛资格;player rename|<target> <text>|更改昵称;resource set|<target> <resource> <int>|设置资源;resource add|<target> <resource> <int>|增减资源;photon grant|<target>|补给一枚光粒;photon revoke|<target>|收回光粒;tech grant|<target>|升级并补给光粒;homeworld correct-coordinate|<target> <coordinate>|更正母星登记;homeworld destroy|<target>|主动毁灭母星;homeworld restore|<target>|恢复已登记母星;code replace-same|<target> <color>|同色实物替换;code reissue|<target>|暂停中重发新码;code activate|<target> [issue <id>]|现场核对后激活;attack invalidate|<id>|撤销错误攻击;attack correct-penalty|<id>|修正攻击判罚;hunt finalize|<id>|提交整批终局核验;hunt eliminate|<target> <reason>|终局持续执裁;event retry|<id>|重试原事件;event cancel|<id>|取消可撤销事件;event trigger singer|<coordinate>|新增歌者清理;event trigger tech-burst|[<target>]|额外技术爆炸;scheduler rearm||重新安排闹钟;scheduler settle-due||补结算到期事件;observer revoke|<target>|撤销观战;observer restore|<target>|解除观战处分;report correct|[from <id>]|创建战报更正;report publish|<id>|发布战报版本',
    'commands',
    'write',
  ],
  [
    'homeworld verify|<target> version <int> code <coordinate>|审核最新版母星;homeworld reject|<target> version <int>|退回母星登记',
    'homeworlds',
    'write',
  ],
  [
    'effect create attack-silence|<target> for <duration>|创建目击静默;effect revoke|<id>|撤销静默;effect clear|<target>|清除管理静默',
    'events',
    'write',
  ],
  [
    'announce|<target> <text>|群体公告;tell|<target> <text>|逐人私信;reveal|<target> <statistic>|公开聚合统计;replay|<target> public-events <int>|重播公开事件;message retract|<id>|标记消息撤回;notice mark|<id> <notice-status>|登记复制发送结果;notice retry|<id>|重新加入通知待办',
    'notices',
    'write',
  ],
  [
    'parameter set|<parameter> <value>|修改赛前参数;setting set|<setting> <text>|修改活动设置;palette set|<color> <hex>|修正显示色值;template publish|<id> <text>|发布模板新版本;account enable|<id>|启用账号;account disable|<id>|停用账号;account reset-credential|<id>|重置登录口令;account duty|<id> <duty>|调整普通裁判职责;session revoke|<id>|撤销旧会话;export create|<export-kind>|创建受保护导出;recovery finalize||完成恢复核对',
    'system',
    'write',
  ],
  [
    'preflight note|<target> <text>|保存现场备注;tag add|<target> <text>|添加标签;tag remove|<target> <text>|移除标签',
    'notices',
    'direct',
  ],
  [
    'case open|<kind> [ref <id>] note <text>|建立可选个案;case evidence|<id> ref <id> note <text>|追加个案证据;case close|<id>|关闭个案;hunt draft create||建立核验草稿;hunt draft set|<id> <target> <reason>|编辑核验名单;hunt draft remove|<id> <target>|移除草稿成员;macro define|<text> [params (...)] run { ... }|定义不可变宏版本;macro retire|<text> version <int>|停用宏版本',
    'commands',
    'direct',
  ],
  [
    'batch run|{ ... }|整批提交操作;execute|[as <target>] [if ...] run { ... }|条件执行;schedule create|<clock> in <duration> run { ... }|安排定时操作;macro run|<text> [(...)] [version <int>]|调用参数宏;schedule cancel|<id>|取消定时任务;job cancel|<id>|停止后续作业',
    'overview',
    'write',
  ],
  [
    'plan|/<command>|显式预览;plan inspect|<id>|查看计划;plan cancel|<id>|关闭未执行计划;confirm|<id>|确认计划;request inspect|<id>|查询原请求结果',
    'overview',
    'control',
  ],
];
/** 完整注册命令目录；未知路径不能动态变成可执行代码。 */
export const COMMAND_SPECS: CommandSpec[] = groups.flatMap(
  ([source, permission, mode]) =>
    source.split(';').map(entry => {
      const [path = '', args = '', description = ''] = entry.split('|');
      return {
        path,
        args,
        description,
        permission:
          mode === 'query' && /^(schedule|job|macro) (list|inspect)$/.test(path)
            ? 'overview'
            : permission,
        query: mode === 'query',
        direct: mode === 'direct',
      };
    }),
);
/** 解析后的命令树节点，包含位置参数、选项及可选组合块。 */
export interface CommandNode {
  words: string[];
  block?: CommandNode[];
  options: Record<string, string>;
}
/** 包含位置证据的命令语法错误，供控制台展示可定位提示。 */
export class CommandSyntaxError extends Error {
  constructor(
    message: string,
    public offset = 0,
  ) {
    super(`${message}（位置 ${offset + 1}）`);
  }
}
/** 命令词法单元及其原文跨度，避免提示丢失准确位置。 */
export interface Lexeme {
  value: string;
  start: number;
  end: number;
}
/** 按引号、转义和组合括号拆词；不执行或授权任何命令。 */
export function tokenizeCommand(input: string): Lexeme[] {
  const result: Lexeme[] = [];
  for (let index = 0; index < input.length;) {
    if (/[ \t\r]/.test(input[index]!)) {
      index++;
      continue;
    }
    const start = index;
    if (input[index] === '"') {
      index++;
      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\') {
          index++;
        }
        index++;
      }
      if (index >= input.length) {
        throw new CommandSyntaxError('字符串缺少结束引号', start);
      }
      index++;
      try {
        parseJson(input.slice(start, index));
      } catch {
        throw new CommandSyntaxError('字符串须使用JSON转义', start);
      }
    } else if (
      input[index] === '@' ||
      (input[index] === '{' && /^\{\s*C\d/.test(input.slice(index)))
    ) {
      let brackets = 0;
      let braces = 0;
      let quoted = false;
      do {
        const character = input[index++]!;
        if (character === '\\' && quoted) {
          index++;
          continue;
        }
        if (character === '"') {
          quoted = !quoted;
        }
        if (!quoted) {
          if (character === '[') {
            brackets++;
          }
          if (character === ']') {
            brackets--;
          }
          if (character === '{') {
            braces++;
          }
          if (character === '}') {
            braces--;
          }
        }
      } while (
        index < input.length &&
        (brackets > 0 || braces > 0 || !/[\s;(){}]/.test(input[index]!))
      );
      if (brackets || braces || quoted) {
        throw new CommandSyntaxError('目标集合或选择器未闭合', start);
      }
    } else if (/[{}();,\n]/.test(input[index]!)) {
      index++;
    } else {
      while (index < input.length && !/[\s{}();,]/.test(input[index]!)) {
        index++;
      }
    }
    result.push({value: input.slice(start, index), start, end: index});
  }
  return result;
}
const optionNames = new Set([
  'reason',
  'source',
  'case',
  'mode',
  'targets',
  'late',
  'max-lateness',
  'end-at',
  'after-end',
  'limit',
  'before',
  'format',
  'target',
  'actor',
  'kind',
  'status',
  'since',
  'until',
  'search',
]);
/** 构造受预算限制的命令语法树，未知或非法结构在执行前拒绝。 */
export function parseCommandTree(input: string): CommandNode {
  if (commandByteLength(input) > COMMAND_LIMITS.bytes) {
    throw new CommandSyntaxError('输入超过256KiB');
  }
  if (!input.trimStart().startsWith('/')) {
    throw new CommandSyntaxError('指令须以 / 开头');
  }
  const tokens = tokenizeCommand(input.trimStart().slice(1));
  let index = 0;
  const read = (depth: number): CommandNode => {
    if (depth > COMMAND_LIMITS.depth) {
      throw new CommandSyntaxError('嵌套超过32层', tokens[index]?.start);
    }
    const node: CommandNode = {words: [], options: {}};
    while (
      index < tokens.length &&
      ![';', '\n', '}'].includes(tokens[index]!.value)
    ) {
      const token = tokens[index++]!;
      if (token.value === '{') {
        if (node.block) {
          throw new CommandSyntaxError('一个操作只能有一个块', token.start);
        }
        node.block = [];
        while (tokens[index] && tokens[index]!.value !== '}') {
          if ([';', '\n'].includes(tokens[index]!.value)) {
            index++;
            continue;
          }
          node.block.push(read(depth + 1));
        }
        if (tokens[index++]?.value !== '}') {
          throw new CommandSyntaxError('操作块未闭合', token.start);
        }
      } else if (token.value.startsWith('--')) {
        const key = token.value.slice(2);
        if (!optionNames.has(key) || key in node.options) {
          throw new CommandSyntaxError(
            '未知或重复选项 ' + token.value,
            token.start,
          );
        }
        const value = tokens[index++];
        if (
          !value ||
          /^[;{}\n]/.test(value.value) ||
          value.value.startsWith('--')
        ) {
          throw new CommandSyntaxError('选项缺少值', token.start);
        }
        node.options[key] = value.value.startsWith('"')
          ? (parseJson(value.value) as string)
          : value.value;
      } else {
        let atom = token.value.replace(/^\//, '');
        if (atom.startsWith('"')) {
          atom = JSON.stringify(parseJson(atom));
        } else if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(atom)) {
          atom = durationMs(atom) + 'ms';
        }
        node.words.push(atom);
      }
    }
    if (!node.words.length) {
      throw new CommandSyntaxError('缺少操作', tokens[index]?.start);
    }
    return node;
  };
  const node = read(0);
  while ([';', '\n'].includes(tokens[index]?.value ?? '')) {
    index++;
  }
  if (index !== tokens.length) {
    throw new CommandSyntaxError(
      '顶层仅允许一条指令，请使用batch run',
      tokens[index]?.start,
    );
  }
  return node;
}
/** 把已解析节点匹配到固定命令目录，未注册路径没有执行权限。 */
export function commandSpec(node: CommandNode): CommandSpec | undefined {
  return COMMAND_SPECS.filter(s =>
    s.path.split(' ').every((w, i) => node.words[i] === w),
  ).sort((a, b) => b.path.length - a.path.length)[0];
}
/** 将命令时长语法转换成毫秒并检查范围，不接受任意日期表达式。 */
export function durationMs(value: string): number {
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (!parts.length || parts.map(p => p[0]).join('') !== value) {
    throw new CommandSyntaxError('时长须带ms/s/m/h/d单位');
  }
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
  };
  const n = parts.reduce((sum, p) => sum + Number(p[1]) * units[p[2]!]!, 0);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new CommandSyntaxError('时长超出整数毫秒范围');
  }
  return n;
}
/** 解析明确的时间输入为UTC毫秒，拒绝无效或越界时刻。 */
export function instantMs(value: string): number {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new CommandSyntaxError('时间须为带时区的RFC3339格式');
  }
  return Date.parse(value);
}
/** 控制台补全候选及替换范围，不代表该候选在当前战局可执行。 */
export interface Completion {
  value: string;
  description: string;
  start: number;
  end: number;
}
const values: Record<string, Array<[string, string]>> = {
  'history-kind': [
    ['all', '职责内全部历史'],
    ['attack', '攻击与原判罚'],
    ['flight', '航次与配置退役'],
    ['homeworld', '母星历史'],
    ['resource', '资源变化'],
    ['elimination', '淘汰与撤销'],
    ['notice', '通知及处理履历'],
    ['command', '相关命令记录'],
    ['penalty', '处罚与赦免'],
    ['correction', '攻击及业务纠错'],
  ],
  target: [
    ['@a', '正式名单'],
    ['@alive', '存活文明'],
    ['@dead', '已淘汰文明'],
    ['@random[alive]', '随机一名存活文明'],
    ['@pool', '预注册账号池'],
    ['@s', '当前绑定文明'],
  ],
  resource: [
    ['tech-level', '科技等级0或1'],
    ['photons', '光粒库存0或1'],
    ['broadcasts', '广播剩余0至2'],
  ],
  score: [
    ['photons', '光粒库存'],
    ['broadcasts', '剩余广播'],
    ['wrong', '错误目击码次数'],
    ['kills', '已击毁的不同文明数'],
  ],
  color: ['BK', 'WH', 'GY', 'YL', 'OR', 'SB', 'PU'].map((v, i) => [
    v,
    ['黑色', '白色', '灰色', '黄色', '橙色', '天蓝色', '紫色'][i]!,
  ]),
  clock: [
    ['utc', '真实时间'],
    ['game', '有效比赛时间'],
  ],
  'notice-status': [
    ['copied', '已复制'],
    ['sent', '已发送'],
    ['failed', '发送失败'],
  ],
  duty: [
    ['communication', '通讯裁判'],
    ['events', '事件裁判'],
  ],
  'export-kind': [
    ['report', '战报'],
    ['audit', '审计'],
    ['checkpoint', '恢复检查点'],
  ],
  statistic: [
    ['alive-homeworlds', '尚存母星数'],
    ['unused-photoids', '剩余光粒数'],
    ['kills-last-10min', '近十分钟击毁数'],
  ],
  parameter: [
    'singer-percent',
    'wrong-first-lock',
    'wrong-second-lock',
    'wrong-second-out-percent',
    'respawn-window',
    'observer-wait',
    'sighting-min-interval',
    'sighting-per-minute',
  ].map((candidateValue, index) => [
    candidateValue,
    [
      '歌者概率',
      '首次禁止目击攻击秒数',
      '第二次禁止目击攻击秒数',
      '第二次淘汰概率',
      '重生期限秒数',
      '观战等待秒数',
      '目击间隔毫秒',
      '每分钟目击次数',
    ][index]!,
  ]),
  setting: [
    'activity-name',
    'activity-description',
    'qq-group-name',
    'qq-group-number',
    'judge-contact',
    'qq-material-name',
  ].map(v => [v, '活动设置项']),
};
/** 按当前输入和授权命令目录提供补全，不包含未授权秘密。 */
export function commandCompletions(
  input: string,
  caret = input.length,
  players: Array<{id: string; nickname?: string | null}> = [],
): Completion[] {
  if (!input.trim()) {
    return [];
  }
  const left = input.slice(0, caret);
  const boundary = Math.max(
    left.lastIndexOf(';'),
    left.lastIndexOf('\n'),
    left.lastIndexOf('run {'),
  );
  const fragment =
    boundary >= 0
      ? left.slice(
          boundary + (left.slice(boundary).startsWith('run {') ? 5 : 1),
        )
      : left;
  const match = /[^\s]*$/.exec(fragment)!;
  const prefix = match[0];
  const start = caret - prefix.length;
  const tail = /^[^\s;{}]*/.exec(input.slice(caret))![0].length;
  const prior = fragment
    .slice(0, fragment.length - prefix.length)
    .trim()
    .replace(/^\//, '')
    .split(/\s+/)
    .filter(Boolean);
  const options: Array<[string, string]> = [];
  const filter = /^(@(?:a|alive|dead|random|pool)\[)(.*)$/.exec(prefix);
  if (filter && !filter[2]!.includes(']')) {
    const comma = filter[2]!.lastIndexOf(',');
    const base = filter[1]! + filter[2]!.slice(0, comma + 1);
    const fragment = filter[2]!.slice(comma + 1);
    const filters: Array<[string, string]> = [
      ['status=active', '正在出航'],
      ['status=returning', '正在返航'],
      ['status=preparing', '准备重生'],
      ['status=issued', '已领待激活配置'],
      ['status=eliminated', '永久淘汰'],
      ['alive', '仅存活文明'],
      ['alive=false', '仅淘汰文明'],
      ['homeworld=alive', '母星尚存'],
      ['homeworld=destroyed', '母星已毁'],
      ['tech=0', '未升级'],
      ['tech=1', '已升级'],
      ['tag=', '包含标签'],
      ['tag=!', '排除标签'],
      ['limit=', '数量上限'],
      ['sort=id', '文明编号排序'],
      ['scores={photons=1}', '按资源筛选'],
    ];
    return filters
      .filter(([v]) => v.startsWith(fragment))
      .map(([value, description]) => ({
        value: base + value,
        description,
        start,
        end: caret + tail,
      }));
  }
  for (const spec of COMMAND_SPECS) {
    const path = spec.path.split(' ');
    if (!prior.every((w, i) => path[i] === w) || prior.length >= path.length) {
      continue;
    }
    options.push([
      (prior.length === 0 && boundary < 0 ? '/' : '') + path[prior.length]!,
      spec.description,
    ]);
  }
  if (!options.length) {
    const spec = COMMAND_SPECS.filter(s =>
      s.path.split(' ').every((w, i) => prior[i] === w),
    ).sort((a, b) => b.path.length - a.path.length)[0];
    if (spec) {
      const argIndex = prior.length - spec.path.split(' ').length;
      const slot = spec.args.replace(/[[\]]/g, '').split(/\s+/)[argIndex];
      const kind = /^<([^>]+)>$/.exec(slot ?? '')?.[1];
      if (kind) {
        options.push(
          ...(values[kind] ?? []),
          ...(kind === 'target'
            ? players.map(
                p => [p.id, p.nickname ?? '指定文明'] as [string, string],
              )
            : []),
        );
      } else if (slot) {
        options.push([slot, '参数关键字']);
      }
    }
  }
  if (prefix.startsWith('--')) {
    options.push(
      ...[...optionNames].map(k => ['--' + k, '指令选项'] as [string, string]),
    );
  }
  const seen = new Set<string>();
  return options
    .filter(([v]) => v.startsWith(prefix) && !seen.has(v) && !!seen.add(v))
    .map(([value, description]) => ({
      value,
      description,
      start,
      end: caret + tail,
    }));
}
