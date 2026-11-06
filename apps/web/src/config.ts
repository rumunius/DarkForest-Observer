import type {SiteConfig} from '@darkforest/contracts';

export const DEFAULT_SITE: SiteConfig = {
  version: 1,
  title: '黑暗森林：观察者效应',
  description:
    '以文明为名，参加一场现场观察与信息博弈。使用长期口令登录并选择比赛，所有现场移动请正常步行。',
  timezone: 'Asia/Shanghai',
  qqGroup: '',
  judgeContact: '',
  endgameFile: '终局圈图片',
  colors: {
    BK: '#1A1A1A',
    WH: '#F5F5F5',
    GY: '#858585',
    YL: '#F4D12B',
    OR: '#F0802B',
    SB: '#56B7E6',
    PU: '#884CB5',
  },
};
