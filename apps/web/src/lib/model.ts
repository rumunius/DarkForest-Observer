import { braceletColors } from './bracelet-colors';
export { braceletColors } from './bracelet-colors';
export type ColorId = (typeof braceletColors)[number]['id'];
export type Arms = [ColorId[], ColorId[]];
export type Scenario =
  'active' | 'restricted' | 'returning' | 'last' | 'transfer' | 'review' | 'eliminated';
export const scenarios: {
  id: Scenario;
  name: string;
  time: number;
  title: string;
  message: string;
  action: string;
}[] = [
  {
    id: 'active',
    name: '正常出航',
    time: 1942,
    title: '飞船正常航行',
    message: '你可以观察其他玩家的手环配置并提交目击。',
    action: '提交目击',
  },
  {
    id: 'restricted',
    name: '禁止攻击',
    time: 1942,
    title: '暂时禁止攻击',
    message: '04:32 后可再次提交目击。你的飞船仍可被击毁。',
    action: '查看限制时间',
  },
  {
    id: 'returning',
    name: '正在返航',
    time: 1942,
    title: '飞船已被击毁',
    message: '摘下全部手环，步行返回母星。拍摄水印照片后通过 QQ 发送给裁判。',
    action: '查看返航步骤',
  },
  {
    id: 'last',
    name: '最后一命',
    time: 4382,
    title: '母星已经毁灭',
    message: '母星已毁灭，飞船仍在航行。',
    action: '提交目击',
  },
  {
    id: 'transfer',
    name: '终局转场',
    time: 5552,
    title: '前往终局区域',
    message: '在比赛 QQ 群开启实时位置共享，并按群文件说明步行前往终局区域。',
    action: '查看转场步骤',
  },
  {
    id: 'review',
    name: '资格核验',
    time: 5880,
    title: '等待终局资格核验',
    message: '比赛时间暂停在 98:00。保持位置共享，等待裁判核验资格。',
    action: '查看核验说明',
  },
  {
    id: 'eliminated',
    name: '永久淘汰',
    time: 6024,
    title: '你的航行已经结束',
    message: '摘下全部手环，停止观察和传递情报，步行返回裁判室。',
    action: '查看我的记录',
  },
];
export function validateArms(arms: Arms): string | null {
  if (new Set(arms.flat()).size !== arms.flat().length) return '同一种颜色只能出现在一侧手臂。';
  if (arms.flat().some((id) => !braceletColors.some((color) => color.id === id)))
    return '请选择手环提供的七种颜色。';
  const sizes = arms.map((arm) => arm.length).sort((a, b) => a - b);
  if (sizes[0] === 0) return '请分别选择两侧手臂的颜色。';
  if (!(
    (sizes[0] === 1 && (sizes[1] === 2 || sizes[1] === 3)) ||
    (sizes[0] === 2 && sizes[1] === 2)
  ))
    return '请选择三条或四条手环，每侧至少一条，最多三条。';
  return null;
}
export function toggleColor(arms: Arms, side: 0 | 1, color: ColorId): Arms {
  const next: Arms = [[...arms[0]], [...arms[1]]];
  if (next[side].includes(color)) next[side] = next[side].filter((id) => id !== color);
  else if (!next[side === 0 ? 1 : 0].includes(color)) next[side].push(color);
  return next;
}
export function canAttack(scenario: Scenario, paused = false): boolean {
  return !paused && (scenario === 'active' || scenario === 'last');
}
export function phaseInfo(scenario: Scenario): { name: string; next: string } {
  if (scenario === 'last') return { name: '最后一命', next: '90:00 开始前往终局区域' };
  if (scenario === 'transfer') return { name: '前往终局区域', next: '98:00 开始资格核验' };
  if (scenario === 'review') return { name: '终局资格核验', next: '等待裁判完成核验' };
  if (scenario === 'eliminated') return { name: '最后阶段', next: '120:00 比赛结束' };
  return { name: '第一阶段', next: '65:00 所有母星毁灭' };
}
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
}
export type Civilization = {
  id: string;
  name: string;
  status: '航行中' | '正在返航' | '已淘汰';
  flight: number;
  score: number;
  arms: Arms;
  home: string;
};
export const civilizations: Civilization[] = [
  {
    id: 'C07',
    name: '远星',
    status: '航行中',
    flight: 2,
    score: 3,
    arms: [['BK', 'OR'], ['WH']],
    home: '001234',
  },
  {
    id: 'C12',
    name: '引力',
    status: '航行中',
    flight: 1,
    score: 2,
    arms: [['SB', 'GY'], ['YL']],
    home: '209481',
  },
  {
    id: 'C03',
    name: '蓝色空间',
    status: '正在返航',
    flight: 3,
    score: 1,
    arms: [['PU'], ['WH', 'OR']],
    home: '482036',
  },
  {
    id: 'C19',
    name: '万有引力',
    status: '航行中',
    flight: 2,
    score: 2,
    arms: [['GY', 'PU'], ['BK']],
    home: '583920',
  },
  {
    id: 'C02',
    name: '深空',
    status: '航行中',
    flight: 1,
    score: 1,
    arms: [
      ['YL', 'BK'],
      ['SB', 'OR'],
    ],
    home: '392017',
  },
  {
    id: 'C21',
    name: '冬眠者',
    status: '已淘汰',
    flight: 2,
    score: 0,
    arms: [['WH'], ['SB', 'PU']],
    home: '083751',
  },
  {
    id: 'C15',
    name: '星舰地球',
    status: '航行中',
    flight: 3,
    score: 2,
    arms: [['OR', 'PU'], ['YL']],
    home: '625018',
  },
  {
    id: 'C09',
    name: '守望者',
    status: '航行中',
    flight: 1,
    score: 1,
    arms: [['GY'], ['WH', 'YL']],
    home: '192450',
  },
];
export const events = [
  {
    time: '32:04',
    kind: 'broadcast',
    title: '一段新的广播传入深空',
    text: 'C12 公开广播母星口令 209481。',
  },
  { time: '30:46', kind: 'hit', title: '飞船被击毁', text: 'C03 的飞船被击毁，当前正在返航。' },
  { time: '28:12', kind: 'launch', title: '飞船完成出航', text: 'C07 完成第二次出航。' },
  {
    time: '25:00',
    kind: 'phase',
    title: '第一阶段进行中',
    text: '母星仍可用于重生。',
  },
];
