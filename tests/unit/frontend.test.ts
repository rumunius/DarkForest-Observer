import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  braceletColors,
  validateArms,
  toggleColor,
  canAttack,
  clock,
  type Arms,
  type Scenario,
} from '../../apps/web/src/lib/model';
import { PresentationClock } from '../../apps/web/src/lib/presentation-clock';
import {
  home,
  player,
  display,
  sighting,
  rosterRows,
  type ViewState,
} from '../../apps/web/src/pages/views';

function state(overrides: Partial<ViewState> = {}): ViewState {
  return {
    playerScore: 3,
    scenario: 'active',
    paused: false,
    arms: [[], []],
    requestState: 'idle',
    selected: 'C07',
    filter: '全部文明',
    search: '',
    eventFilter: '全部事件',
    reviewed: new Set(),
    sent: new Set(),
    ...overrides,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('bracelet selection', () => {
  it.each<Arms>([
    [['BK', 'OR'], ['WH']],
    [['WH'], ['BK', 'OR']],
    [
      ['BK', 'OR'],
      ['WH', 'YL'],
    ],
    [['BK', 'OR', 'PU'], ['WH']],
    [['WH'], ['PU', 'BK', 'OR']],
  ])('accepts a legal grouping %j', (a, b) => expect(validateArms([a, b])).toBeNull());
  it.each<Arms>([
    [[], []],
    [['BK'], ['WH']],
    [
      ['BK', 'WH', 'YL'],
      ['PU', 'GY'],
    ],
    [['BK', 'WH', 'YL', 'GY'], []],
    [['BK', 'OR'], ['BK']],
    [['WH', 'WH'], ['BK']],
  ])('rejects an invalid grouping %j', (a, b) => expect(validateArms([a, b])).not.toBeNull());
  it('prevents duplicate colors across arms and preserves the original draft', () => {
    const original: Arms = [['BK'], ['WH']];
    expect(toggleColor(original, 1, 'BK')).toEqual(original);
    const removed = toggleColor(original, 0, 'BK');
    expect(removed).toEqual([[], ['WH']]);
    expect(toggleColor(removed, 1, 'BK')).toEqual([[], ['WH', 'BK']]);
    expect(original).toEqual([['BK'], ['WH']]);
  });
  it('keeps all seven stable IDs with configurable hex values', () => {
    expect(braceletColors.map((c) => c.id)).toEqual(['BK', 'WH', 'GY', 'YL', 'OR', 'SB', 'PU']);
    expect(braceletColors.every((c) => /^#[0-9a-f]{6}$/i.test(c.hex))).toBe(true);
  });
});
describe('action eligibility', () => {
  it.each<Scenario>(['restricted', 'returning', 'transfer', 'review', 'eliminated'])(
    'blocks attacks in %s',
    (scene) => expect(canAttack(scene)).toBe(false),
  );
  it('permits attacks during flight and blocks a global pause', () => {
    expect(canAttack('active')).toBe(true);
    expect(canAttack('last')).toBe(true);
    expect(canAttack('last', true)).toBe(false);
  });
});
describe('presentation clock', () => {
  it('freezes during pause and resumes without including the waiting period', () => {
    let now = 0;
    const timer = new PresentationClock(() => now);
    now = 5000;
    expect(timer.seconds).toBe(1947);
    timer.setPaused(true);
    now = 20000;
    expect(timer.seconds).toBe(1947);
    timer.setPaused(false);
    now = 23000;
    expect(timer.seconds).toBe(1950);
  });
  it('holds the qualification review at 98 minutes', () => {
    let now = 0;
    const timer = new PresentationClock(() => now);
    timer.reset(5880, true);
    now = 900000;
    expect(clock(timer.seconds)).toBe('98:00');
  });
  it('does not create a new phase from elapsed browser time', () => {
    let now = 0;
    const timer = new PresentationClock(() => now);
    timer.reset(3898);
    now = 10000;
    expect(timer.seconds).toBe(3899);
  });
});
describe('view boundaries and copy', () => {
  it('keeps other civilizations’ private configurations out of the player page', () => {
    vi.stubGlobal('location', { hash: '#/play' });
    const html = player(state());
    expect(html).toContain('当前手环配置');
    expect(html).not.toContain('583920');
    expect(html).not.toContain('审核通过');
  });
  it('keeps write controls out of the display', () => {
    const html = display(state());
    for (const action of ['execute-pause', 'submit-sighting', 'approve-review', 'sent-notice'])
      expect(html).not.toContain(`data-action="${action}"`);
    expect(html).not.toContain('063918');
  });
  it('renders colors themselves, with accessible names', () => {
    vi.stubGlobal('location', { hash: '#/play/sighting' });
    const html = sighting(state());
    for (const color of braceletColors) {
      expect(html).toContain(`fill="${color.hex}"`);
      expect(html).toContain(`aria-label="${color.name}"`);
    }
    expect(html).not.toMatch(/>黑色</);
  });
  it('searches civilizations and distinguishes empty search results', () => {
    expect(rosterRows(state({ search: 'c07' }))).toContain('远星');
    expect(rosterRows(state({ search: 'c07' }))).not.toContain('万有引力');
    expect(rosterRows(state({ search: '不存在' }))).toContain('没有找到匹配的文明');
  });
  it('offers result lookup while a request is unresolved', () => {
    const html = sighting(state({ requestState: 'unknown' }));
    expect(html).toContain('查询目击结果');
    expect(html).toContain('data-action="clear" disabled');
  });
  it('uses direct Chinese copy without disclaimers or invented abbreviations', () => {
    vi.stubGlobal('location', { hash: '#/play' });
    const html = home() + player(state()) + sighting(state()) + display(state());
    expect(html).not.toMatch(/禁攻|离巢|模拟数据|不代表真实|去重|·/);
    expect(html).not.toMatch(/\s\/\s/);
  });
});
