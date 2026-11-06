import {COLORS, validArms, type Arms} from '@darkforest/contracts';
import {ContractError} from '../../../../packages/contracts/src/backend';

/** 有效比赛时钟上的阶段边界；暂停期间这些时间点不向前推进。 */
export const TIMES = {
  apocalypse: 3_900_000,
  transfer: 5_400_000,
  cutoff: 5_880_000,
  end: 7_200_000,
  respawn: 900_000,
};
/** 校验合法手环分组并归一化两臂顺序；同臂排列不影响码身份。 */
export function normalizeArms(leftArm: unknown, rightArm: unknown): string {
  if (
    !Array.isArray(leftArm) ||
    !Array.isArray(rightArm) ||
    !validArms([leftArm, rightArm] as Arms)
  ) {
    throw new ContractError('手环分组不合法。');
  }
  const masks = [leftArm, rightArm]
    .map(arm =>
      arm.reduce(
        (mask: number, color: unknown) =>
          mask | (1 << COLORS.findIndex(c => c.id === color)),
        0,
      ),
    )
    .sort((x, y) => x - y);
  return masks.join(':');
}
/** 将服务器规范码还原为七色分组，保留两臂交换等价的表示。 */
export function decodeArms(key: string): Arms {
  return key
    .split(':')
    .map(n =>
      COLORS.filter((_, i) => Number(n) & (1 << i)).map(c => c.id),
    ) as Arms;
}
/** 枚举本场可发行的完整合法码本，发行历史仍由持久化存储保证不复用。 */
export function enumerateCodes(): string[] {
  const result: string[] = [];
  for (let a = 1; a < 128; a++) {
    for (let b = a + 1; b < 128; b++) {
      const arms = decodeArms(`${a}:${b}`);
      if (validArms(arms)) {
        result.push(`${a}:${b}`);
      }
    }
  }
  if (result.length !== 350) {
    throw new Error('Invalid codebook');
  }
  return result;
}
/** 使用加密随机源和拒绝采样，在给定上界内均匀取整数。 */
export function uniformInt(max: number): number {
  if (!Number.isSafeInteger(max) || max < 1 || max > 2 ** 32) {
    throw new Error('Invalid random bound');
  }
  const limit = 2 ** 32 - (2 ** 32 % max);
  const sample = new Uint32Array(1);
  do {
    crypto.getRandomValues(sample);
  } while (sample[0]! >= limit);
  return sample[0]! % max;
}
/** 计算首次歌者到达的有效时间；事件持久化后不得因重试重新抽取。 */
export function firstSongDue(
  at: number,
  random = uniformInt,
  probability = 5,
): number | null {
  for (let due = at + 60_000; due < TIMES.apocalypse; due += 60_000) {
    if (random(100) < probability) {
      return due;
    }
  }
  return null;
}
/** 生成技术爆炸计划；调用方负责在开赛锁定事务中保存既定抽签。 */
export function techSchedule(
  playerCount: number,
  random = uniformInt,
): number[] {
  const count = Math.min(
    Math.max(1, Math.round(playerCount / 3)),
    Math.floor((playerCount - 1) / 2),
  );
  // Stratified windows guarantee spread, with a four-minute gap whenever capacity permits.
  const start = 8 * 60_000;
  const end = 55 * 60_000;
  const gap =
    count > 1 ? Math.min(240_000, Math.floor((end - start) / (count - 1))) : 0;
  const free = end - start - Math.max(0, count - 1) * gap;
  const jitter = Array.from({length: count}, () => random(free + 1)).sort(
    (a, b) => a - b,
  );
  return jitter.map((v, i) => start + v + i * gap);
}
/** 计算有效时间所需的UTC节点与累计暂停信息，不代表客户端计时授权。 */
export interface Clock {
  started_at: number | null;
  paused_at: number | null;
  paused_total: number;
  ended_game: number | null;
}
/** 从UTC和暂停记录计算有效比赛时长，暂停时冻结结果。 */
export function gameTime(clock: Clock, utc: number): number {
  if (clock.ended_game !== null) {
    return clock.ended_game;
  }
  if (clock.started_at === null) {
    return 0;
  }
  return Math.max(
    0,
    (clock.paused_at ?? utc) - clock.started_at - clock.paused_total,
  );
}
