import {describe, expect, it} from 'vitest';
import {
  enumerateCodes,
  normalizeArms,
  decodeArms,
  techSchedule,
  firstSongDue,
  gameTime,
} from '../../apps/match-worker/src/domain/rules';
import {
  nickname,
  strict,
  coordinate,
  stableJson,
} from '../../packages/contracts/src/backend';

describe('backend contracts and rules', () => {
  it('rejects malformed mask pairs instead of silently coercing them to colors', () => {
    for (const key of [
      '',
      '1',
      '1:2:4',
      ':2',
      '1:',
      'NaN:2',
      'Infinity:2',
      '-1:2',
      '1.5:2',
      '128:2',
      '9007199254740992:2',
      `${'9'.repeat(400)}:2`,
      '1:0x02',
      '1:2x',
    ]) {
      expect(() => decodeArms(key), key).toThrow();
    }
    // Enumeration also decodes masks outside legal wearable group sizes.
    expect(decodeArms('0:127')).toEqual([
      [],
      ['BK', 'WH', 'GY', 'YL', 'OR', 'SB', 'PU'],
    ]);
  });

  it('enumerates exactly 350 disjoint codes with the required distribution', () => {
    const codes = enumerateCodes();
    expect(new Set(codes).size).toBe(350);
    const shapes: Record<string, number> = {};
    for (const key of codes) {
      const [a, b] = decodeArms(key);
      const shape = [a.length, b.length].sort().join('+');
      shapes[shape] = (shapes[shape] ?? 0) + 1;
      expect(normalizeArms([...b].reverse(), [...a].reverse())).toBe(key);
    }
    expect(shapes).toEqual({'1+2': 105, '2+2': 105, '1+3': 140});
  });
  it.each([
    [[], ['BK']],
    [['BK'], ['BK', 'WH']],
    [
      ['BK', 'WH', 'GY'],
      ['YL', 'OR'],
    ],
    [['unknown'], ['GY', 'YL']],
  ])('rejects invalid arms %j %j', (a, b) => {
    expect(() => normalizeArms(a, b)).toThrow();
  });
  it.each([
    [2, 0],
    [3, 1],
    [5, 2],
    [12, 4],
    [24, 8],
    [36, 12],
    [350, 117],
  ])('schedules N=%d with M=%d', (n, m) => {
    const schedule = techSchedule(n);
    expect(schedule).toHaveLength(m);
    expect(new Set(schedule).size).toBe(m);
    expect(schedule.every(t => t >= 480000 && t <= 3300000)).toBe(true);
    if (m <= 12) {
      expect(
        schedule.every((t, i) => !i || t - schedule[i - 1]! >= 240000),
      ).toBe(true);
    }
  });
  it('uses complete singer windows and configurable probabilities', () => {
    expect(firstSongDue(1000, () => 4)).toBe(61000);
    expect(firstSongDue(1000, () => 5)).toBeNull();
    expect(firstSongDue(1000, () => 9, 10)).toBe(61000);
    expect(firstSongDue(3840000, () => 0, 100)).toBeNull();
    expect(firstSongDue(0, () => 0, 0)).toBeNull();
  });
  it('freezes game time during pauses while preserving UTC inputs', () => {
    expect(
      gameTime(
        {
          started_at: 1000,
          paused_at: 4000,
          paused_total: 1000,
          ended_game: null,
        },
        10000,
      ),
    ).toBe(2000);
    expect(
      gameTime(
        {
          started_at: 1000,
          paused_at: null,
          paused_total: 1000,
          ended_game: null,
        },
        10000,
      ),
    ).toBe(8000);
    expect(
      gameTime(
        {
          started_at: 1000,
          paused_at: null,
          paused_total: 1000,
          ended_game: 3000,
        },
        10000,
      ),
    ).toBe(3000);
  });
  it('normalizes visible names without folding letter case and retains leading zeros', () => {
    expect(nickname('  Ａlpha  ')).toBe('Alpha');
    expect(nickname('alpha')).toBe('alpha');
    expect(coordinate('001234')).toBe('001234');
    expect(() => coordinate(1234)).toThrow();
    expect(() =>
      strict({request_id: 'x', player_id: 'C01'}, ['request_id']),
    ).toThrow();
    expect(stableJson({b: 2, a: [1, 3]})).toBe(stableJson({a: [1, 3], b: 2}));
  });
});
