import type { RuleParameters } from '@darkforest/contracts';
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
export function duration(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60}分钟` : `${seconds}秒`;
}
export function attackWarning(wrongCount: number, parameters = DEFAULT_PARAMETERS): string {
  if (wrongCount === 0)
    return `提交错误的目击码，将禁止目击攻击${duration(parameters.firstLockSeconds)}。`;
  if (wrongCount === 1)
    return `再次提交错误的目击码，有${parameters.secondOutPercent}%的概率永久淘汰，有${100 - parameters.secondOutPercent}%的概率禁止目击攻击${duration(parameters.secondLockSeconds)}。`;
  return '再次提交错误的目击码，将永久淘汰。';
}
