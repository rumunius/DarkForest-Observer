import {COLORS, validArms, type Arms} from '@darkforest/contracts';
import {ContractError} from '../../../../packages/contracts/src/backend';

export const TIMES = {
  apocalypse: 3_900_000,
  transfer: 5_400_000,
  cutoff: 5_880_000,
  end: 7_200_000,
  respawn: 900_000,
};
export function normalizeArms(a: unknown, b: unknown): string {
  if (!Array.isArray(a) || !Array.isArray(b) || !validArms([a, b] as Arms)) {
    throw new ContractError('手环分组不合法。');
  }
  const masks = [a, b]
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
export function decodeArms(key: string): Arms {
  return key
    .split(':')
    .map(n =>
      COLORS.filter((_, i) => Number(n) & (1 << i)).map(c => c.id),
    ) as Arms;
}
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
export function techSchedule(n: number, random = uniformInt): number[] {
  const count = Math.min(
    Math.max(1, Math.round(n / 3)),
    Math.floor((n - 1) / 2),
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
export interface Clock {
  started_at: number | null;
  paused_at: number | null;
  paused_total: number;
  ended_game: number | null;
}
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
