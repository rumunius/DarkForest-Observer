import { describe, expect, it } from 'vitest';
import { validArms, validCode, type Arms } from '@darkforest/contracts';
import { canAct } from '../../apps/web/src/permissions';
import { MockSource } from '../../apps/web/src/dev/mock-source';
import { ApiError } from '../../apps/web/src/data/http';

describe('frontend input and authorized disclosure', () => {
  it.each<Arms>([
    [['BK', 'OR'], ['WH']],
    [
      ['BK', 'OR'],
      ['WH', 'GY'],
    ],
    [['BK', 'OR', 'SB'], ['GY']],
  ])('accepts legal groups without arm ordering', (a, b) => {
    expect(validArms([a, b])).toBe(true);
    expect(validArms([b, [...a].reverse()])).toBe(true);
  });
  it('rejects duplicate colors and incomplete drafts without submitting', () => {
    expect(validArms([['BK', 'WH'], ['BK']])).toBe(false);
    expect(validArms([['BK'], ['WH']])).toBe(false);
    expect(
      validArms([
        ['BK', 'WH', 'GY'],
        ['YL', 'OR'],
      ]),
    ).toBe(false);
  });
  it('preserves leading zeroes in six digit strings', () => {
    expect(validCode('001234')).toBe(true);
    expect(validCode('1234')).toBe(false);
    expect(validCode('12e345')).toBe(false);
  });
  it('does not send other civilizations or photon actors to an active player projection', async () => {
    const data = await new MockSource().read('/player');
    expect(data.civilizations).toEqual([]);
    expect(data.judge).toBeNull();
    expect(data.events.filter((e) => e.kind === 'photon').every((e) => e.actor === undefined)).toBe(
      true,
    );
  });
  it('removes combat inputs while returning even with photon inventory', async () => {
    const source = new MockSource();
    source.reset('player', 'returning');
    const data = await source.read('/player/actions/photon');
    expect(data.player?.photons).toBe(1);
    expect(canAct(data, 'sighting')).toBe(false);
    expect(canAct(data, 'photon')).toBe(false);
    await expect(
      source.submit({
        path: '/action/photon',
        payload: { code: '001234' },
        requestId: 'forbidden',
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
  it('keeps broadcast and photon available during an individual sighting restriction', async () => {
    const source = new MockSource();
    source.reset('player', 'locked');
    const data = await source.read('/player/actions');
    expect(canAct(data, 'sighting')).toBe(false);
    expect(canAct(data, 'broadcast')).toBe(true);
    expect(canAct(data, 'photon')).toBe(true);
  });
  it('gates observer secrets and opens postmatch review without waiting', async () => {
    const source = new MockSource();
    source.reset('player', 'eliminated');
    expect((await source.read('/observer')).civilizations).toHaveLength(0);
    source.reset('observer', 'observer');
    expect((await source.read('/observer')).civilizations).toHaveLength(24);
    source.reset('player', 'no-champion');
    const ended = await source.read('/results');
    expect(ended.results?.champions).toEqual([]);
    expect(ended.results?.standings.every((c) => c.flight === 'eliminated')).toBe(true);
  });
  it('does not charge a duplicate request twice', async () => {
    const source = new MockSource();
    const op = { path: '/action/broadcast', payload: { code: '000019' }, requestId: 'stable-id' };
    expect(await source.submit(op)).toEqual(await source.submit(op));
    expect((await source.read('/player')).player?.broadcasts).toBe(1);
  });
  it('recovers an uncertain operation using its original request identifier', async () => {
    const source = new MockSource();
    source.setFault('unknown');
    const op = { path: '/action/broadcast', payload: { code: '000029' }, requestId: 'unknown-id' };
    expect((await source.submit(op)).status).toBe('pending');
    expect((await source.result(op.requestId)).status).toBe('complete');
    expect((await source.result(op.requestId)).status).toBe('complete');
    expect((await source.read('/player')).player?.broadcasts).toBe(1);
  });
  it('retains a saved homeworld as a string and advances only the current step', async () => {
    const source = new MockSource();
    source.reset('player', 'registration');
    await source.submit({
      path: '/action/homeworld-submit',
      payload: { code: '000001' },
      requestId: 'homeworld',
    });
    const data = await source.read('/player/homeworld');
    expect(data.player?.homeworld).toBe('000001');
    expect(data.player?.flight).toBe('pending');
    expect(data.player?.actions).not.toContain('preflight-issue-code');
  });
});
