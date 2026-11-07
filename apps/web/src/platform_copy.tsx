import {object, parseJson} from '../../../packages/contracts/src/backend';
import type {ReactNode} from 'react';

/** 权威比赛阶段的中文显示名称，未知阶段不能据此获得权限。 */
export const PHASE_NAMES: Record<string, string> = {
  setup: '赛前准备',
  armed: '等待统一发码',
  outfitting: '等待穿戴完成',
  start_countdown: '等待统一开赛',
  forest: '黑暗森林',
  apocalypse: '宇宙末日',
  transfer: '前往终局区域',
  hunt: '最后狩猎',
  ended: '比赛已结束',
};
const LABELS: Record<string, string> = {
  name: '名称',
  match: '比赛',
  current: '当前情况',
  warning: '操作影响',
  message: '处理说明',
  account: '账号',
  accountId: '账号编号',
  matchId: '比赛编号',
  id: '编号',
  target: '处理对象',
  status: '当前状态',
  error: '未完成原因',
  reason: '原因',
  roles: '平台任职',
  audit: '操作记录',
  holds: '申诉保留',
  ledger: '清理记录',
  scope: '清理范围',
  generation: '清理记录版本',
  execute_after: '预计执行时间',
  created_utc: '创建时间',
  utc_ms: '操作时间',
  review_utc: '复核时间',
  expires: '保留截止时间',
  rows: '导入结果',
  line: '文件行号',
  valid: '有效行数',
  errors: '错误行数',
  kind: '类别',
  version: '版本',
  phase: '比赛阶段',
  players: '正式参赛人数',
  members: '本场人员',
  assignments: '裁判任职',
  seat_id: '裁判岗位',
  local_id: '本场身份',
  releasedLocalId: '已释放的本场身份',
  removed: '已移除成员',
  started_utc: '开始任职时间',
  ended_utc: '结束任职时间',
  receipts: '各比赛处理结果',
  receipt: '处理结果',
  result: '执行结果',
  report: '正式战报',
  standings: '正式排名',
  champions: '优胜文明',
  rank: '名次',
  nickname: '昵称',
  kills: '已击毁的不同文明数',
  eliminatedAt: '淘汰时间',
  eliminationReason: '淘汰原因',
  correctionReason: '更正依据',
  events: '已发生事件',
  title: '事件名称',
  body: '事件说明',
  homeworld: '母星口令',
  homeworldCode: '母星口令',
  tied: '并列',
  revision: '比赛记录版本',
  reportVersion: '战报版本',
  verified: '已完成校验',
  fenced: '本场已完成访问限制',
  allFenced: '所有比赛已完成访问限制',
  online: '网站清理结果',
  authEpoch: '账号授权版本',
  erasureGeneration: '清理记录版本',
  retention_days: '完整复盘保留天数',
  audit_days: '战报与审计保留天数',
  epoch: '岗位版本',
  state: '当前情况',
};
const VALUES: Record<string, string> = {
  official: '正式比赛',
  trial: '试玩',
  player: '玩家',
  staff: '工作人员',
  owner: '平台所有者',
  admin: '平台管理员',
  archivist: '资料管理员',
  draft: '草稿',
  provisioning: '正在创建',
  available: '可进入比赛',
  archiving: '正在归档',
  archived: '已归档',
  purge_pending: '待清理',
  purged: '已清理',
  imported_archive: '导入档案',
  pending: '等待处理',
  active: '已激活',
  disabled: '已停用',
  invited: '等待本人接受',
  accepted: '已接受邀请',
  bound: '已确认本场身份',
  revoked: '已结束任职',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '需要处理',
  cancelled: '已取消',
  ready: '已校验',
  report: '正式战报',
  replay: '完整复盘',
  backup: '加密恢复备份',
  audit: '受限审计',
  'nonessential-secrets': '非必要秘密信息',
  ...PHASE_NAMES,
};
/** 平台持久操作的中文显示名称，原状态和收据仍用于成功判定。 */
export const OPERATION_NAMES: Record<string, string> = {
  create: '新建比赛',
  fence: '更新各比赛访问限制',
  archive: '生成固定档案',
  purge: '清理到期的赛后资料',
  roles: '调整平台权限',
  recommend: '调整推荐比赛',
  retry: '继续未完成任务',
  hold: '调整申诉保留',
  'account-create': '创建长期账号',
  'account-import': '导入长期账号',
  'archive-import': '导入只读档案',
  'credential-invite': '交付账号邀请',
  'cancel-purge': '取消到期清理',
  'control:invite': '邀请参加比赛',
  'control:remove-member': '移除本场成员',
  'control:accept': '接受本场邀请',
  'control:bind': '确认本场文明',
  'control:assign': '交接裁判岗位',
  'control:publish': '发布准备入口',
};
/** 把未知结构的管理结果投影成允许展示的字段，隐藏未注册的内部字段。 */
export function HumanData({
  value,
  field = '',
}: {
  value: unknown;
  field?: string;
}): ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span>暂无</span>;
  }
  if (typeof value === 'boolean') {
    return <span>{value ? '是' : '否'}</span>;
  }
  if (typeof value === 'number') {
    return (
      <span>
        {/_utc$|_after$|utc_ms$|expires$/.test(field) && value > 1000000000000
          ? new Date(value).toLocaleString('zh-CN')
          : value}
      </span>
    );
  }
  if (typeof value === 'string') {
    if (field === 'manifest') {
      return null;
    }
    if (
      ['result', 'receipt', 'report'].includes(field) &&
      (value.startsWith('{') || value.startsWith('['))
    ) {
      try {
        return <HumanData value={parseJson(value)} field={field} />;
      } catch {
        return <span>暂时无法读取处理结果。</span>;
      }
    }
    if (field === 'action') {
      return <span>{OPERATION_NAMES[value] ?? '平台管理操作'}</span>;
    }
    return <span>{VALUES[value] ?? value}</span>;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return (
      <ul className="platform-readable-list">
        {items.map((v, i) => (
          <li key={i}>
            <HumanData value={v} field={field} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'object') {
    return (
      <dl className="platform-readable-details">
        {Object.entries(object(value))
          .filter(([key]) => LABELS[key])
          .map(([key, v]) => (
            <div key={key}>
              <dt>{LABELS[key]}</dt>
              <dd>
                <HumanData value={v} field={key} />
              </dd>
            </div>
          ))}
      </dl>
    );
  }
  return null;
}
