import type {RuleParameters} from '@darkforest/contracts';
/** 未提供可配置项时的默认规则参数，单位在字段名中明确。 */
export const DEFAULT_PARAMETERS: RuleParameters = {
  singerPercent: 5,
  firstLockSeconds: 300,
  secondLockSeconds: 900,
  secondOutPercent: 50,
  respawnSeconds: 900,
  observerWaitSeconds: 180,
  sightingIntervalMs: 4000,
  sightingsPerMinute: 10,
};
/** 把规则中的秒数格式化为用户可读时长，不参与截止时间判定。 */
export function duration(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60}分钟` : `${seconds}秒`;
}
/** 按本场规则参数说明当前目击处罚风险，不在浏览器抽取判罚。 */
export function attackWarning(
  wrongCount: number,
  parameters = DEFAULT_PARAMETERS,
): string {
  if (wrongCount === 0) {
    return `提交错误的手环颜色，将禁止目击攻击${duration(parameters.firstLockSeconds)}。`;
  }
  if (wrongCount === 1) {
    return `再次提交错误的手环颜色，有${parameters.secondOutPercent}%的概率永久淘汰，有${100 - parameters.secondOutPercent}%的概率禁止目击攻击${duration(parameters.secondLockSeconds)}。`;
  }
  return '再次提交错误的手环颜色，将永久淘汰。';
}
