import { describe, expect, it } from 'vitest';
import {
  commandCompletions,
  parseCommandTree,
  commandSpec,
  durationMs,
  instantMs,
  COMMAND_SPECS,
} from '../../packages/contracts/src/commands';

describe('DF-Judge syntax and completion', () => {
  it('shares one unique catalogue between help, execution and completion', () => {
    expect(new Set(COMMAND_SPECS.map((s) => s.path)).size).toBe(COMMAND_SPECS.length);
    for (const spec of COMMAND_SPECS)
      expect(commandSpec({ words: spec.path.split(' '), options: {} })?.path).toBe(spec.path);
  });
  it('offers root prefixes, children and argument values', () => {
    expect(commandCompletions('')).toEqual([]);
    const roots = commandCompletions('/');
    expect(roots.length).toBeGreaterThan(10);
    expect(roots.some((s) => s.value === '/player')).toBe(true);
    expect(commandCompletions('/pl').map((s) => s.value)).toEqual(['/player', '/plan']);
    expect(commandCompletions('/player ').map((s) => s.value)).toEqual(
      expect.arrayContaining(['list', 'eliminate', 'restore', 'resources', 'restrictions']),
    );
    expect(commandCompletions('/resource set C01 ').map((s) => s.value)).toContain('photons');
    expect(commandCompletions('/player eliminate @alive[ho').map((s) => s.value)).toContain(
      '@alive[homeworld=alive',
    );
    expect(commandCompletions('/tell C', 7, [{ id: 'C01', nickname: '星尘' }])).toMatchObject([
      { value: 'C01', description: '星尘', start: 6, end: 7 },
    ]);
  });
  it('offers the actual history categories and status filters', () => {
    expect(commandCompletions('/history C01 kind ').map((s) => s.value)).toEqual(
      expect.arrayContaining(['all', 'attack', 'notice', 'command', 'penalty', 'correction']),
    );
    expect(commandCompletions('/player eliminate @a[sta').map((s) => s.value)).toEqual(
      expect.arrayContaining(['@a[status=returning', '@a[status=preparing']),
    );
    expect(commandSpec(parseCommandTree('/event list'))?.query).toBe(true);
    expect(commandSpec(parseCommandTree('/event-log list'))?.path).toBe('event-log list');
  });
  it('replaces the whole current word at a middle caret and leaves suffixes intact', () => {
    const input = '/player eliminXYZ C01';
    const candidate = commandCompletions(input, 14).find((s) => s.value === 'eliminate')!;
    expect(candidate).toBeDefined();
    expect(input.slice(0, candidate.start) + candidate.value + input.slice(candidate.end)).toBe(
      '/player eliminate C01',
    );
  });
  it('parses blocks, quoted code-looking text, selectors, options at their own level and newlines', () => {
    const tree = parseCommandTree(
      '/batch --reason "外层" run { tell @a "{ /clock pause; \\" }";\n player eliminate @alive[scores={wrong=1..2,photons=0},tag=!reward] --reason "内层"; }',
    );
    expect(tree.options.reason).toBe('外层');
    expect(tree.block).toHaveLength(2);
    expect(tree.block![1]!.options.reason).toBe('内层');
    expect(tree.block![1]!.words[2]).toContain('scores={wrong=1..2,photons=0}');
  });
  it('keeps leading zero coordinates and typed macro slots', () => {
    expect(parseCommandTree('/homeworld verify C01 version 2 code 001234').words.at(-1)).toBe(
      '001234',
    );
    const tree = parseCommandTree(
      '/macro define "补给" params (who:target,amount:int) run { resource add $who photons $amount }',
    );
    expect(tree.block![0]!.words).toContain('$who');
  });
  it('rejects malformed strings, selector closures, unknown options and unwrapped statements', () => {
    for (const input of [
      '/tell @a "缺尾',
      '/inspect @a[status=active',
      '/clock pause --oops x',
      '/clock pause; /clock resume',
    ])
      expect(() => parseCommandTree(input)).toThrow();
  });
  it('checks duration precision and absolute timezone', () => {
    expect(durationMs('1m30s')).toBe(90000);
    expect(durationMs('1.5m')).toBe(90000);
    expect(() => durationMs('90')).toThrow();
    expect(() => durationMs('0.0001ms')).toThrow();
    expect(instantMs('2026-11-05T15:15:00+08:00')).toBe(instantMs('2026-11-05T07:15:00Z'));
    expect(() => instantMs('2026-11-05T15:15:00')).toThrow();
  });
  it('bounds parser bytes and nesting', () => {
    expect(() => parseCommandTree('/tell @a ' + JSON.stringify('中'.repeat(90000)))).toThrow(
      '256KiB',
    );
    expect(() =>
      parseCommandTree('/' + 'batch run { '.repeat(34) + 'clock pause' + ' }'.repeat(34)),
    ).toThrow('32层');
  });
});
