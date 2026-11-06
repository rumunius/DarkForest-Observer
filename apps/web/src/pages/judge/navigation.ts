/** 裁判导航的职责与路径目录；可见性不替代服务端API授权。 */
export const JUDGE_NAV = [
  {
    group: '赛事工作',
    items: [
      ['overview', '工作台', '/judge'],
      ['homeworlds', '母星审核', '/judge/homeworlds'],
      ['preflight', '开赛准备', '/judge/preflight'],
      ['notices', '通知待办', '/judge/notices'],
      ['endgame', '终局执裁', '/judge/endgame'],
    ],
  },
  {
    group: '状态与记录',
    items: [
      ['players', '文明管理', '/judge/players'],
      ['events', '赛事事件', '/judge/events'],
      ['attacks', '攻击复核', '/judge/attacks'],
      ['results', '比赛结果', '/judge/results'],
    ],
  },
  {
    group: '比赛管理',
    items: [
      ['clock', '比赛时间', '/judge/clock'],
      ['equipment', '手环处理', '/judge/equipment'],
      ['effects', '临时效果', '/judge/effects'],
      ['overview', '指令控制台', '/judge/commands'],
    ],
  },
  {
    group: '系统管理',
    items: [
      ['system', '系统状态', '/judge/system'],
      ['audit', '操作记录', '/judge/audit'],
      ['settings', '活动设置', '/judge/settings'],
      ['account', '裁判账号', '/judge/account'],
    ],
  },
];
