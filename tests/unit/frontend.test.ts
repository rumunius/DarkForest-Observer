import {describe, expect, it} from 'vitest';
import {validArms, validCode, type Arms} from '@darkforest/contracts';
import {canAct} from '../../apps/web/src/permissions';
import {MockSource} from '../../apps/web/src/dev/mock_source';
import {ApiError} from '../../apps/web/src/data/http';
import {moveBracelet} from '../../apps/web/src/bracelets';

describe('bracelet overflow', () => {
  it.each([0, 1])('spills into the other arm when arm %i is full', target => {
    const arms: Arms =
      target === 0 ? [['BK', 'WH', 'GY'], []] : [[], ['BK', 'WH', 'GY']];
    const result = moveBracelet(arms, 'YL', target);
    expect(result).toEqual({
      arms:
        target === 0
          ? [['BK', 'WH', 'GY'], ['YL']]
          : [['YL'], ['BK', 'WH', 'GY']],
      target: target === 0 ? 1 : 0,
      overflow: true,
    });
    expect(arms.flat()).toEqual(['BK', 'WH', 'GY']);
  });
  it('rejects a fifth bracelet without losing the existing draft', () => {
    const arms: Arms = [['BK', 'WH', 'GY'], ['YL']];
    expect(moveBracelet(arms, 'OR', 0)).toEqual({error: '最多选择4条手环。'});
    expect(arms).toEqual([['BK', 'WH', 'GY'], ['YL']]);
  });
  it('moves across arms atomically and removes a bracelet to the palette', () => {
    expect(moveBracelet([['BK', 'WH', 'GY'], ['YL']], 'YL', 0)).toEqual({
      arms: [['BK', 'WH', 'GY'], ['YL']],
      target: 1,
      overflow: true,
    });
    expect(
      moveBracelet(
        [
          ['BK', 'WH'],
          ['GY', 'YL'],
        ],
        'GY',
        0,
      ),
    ).toEqual({
      arms: [['BK', 'WH', 'GY'], ['YL']],
      target: 0,
      overflow: false,
    });
    expect(moveBracelet([['BK', 'WH'], ['GY']], 'BK', null)).toEqual({
      arms: [['WH'], ['GY']],
      target: null,
      overflow: false,
    });
  });
});

describe('frontend input and authorized disclosure', () => {
  it('rejects malformed preview arm inputs before accepting or recording an attack', async () => {
    const source = new MockSource();
    const before = await source.read('/player');
    for (const payload of [
      {arm_a: 'BK', arm_b: ['WH']},
      {arm_a: null, arm_b: ['WH']},
      {arm_a: ['BK', 'invalid'], arm_b: ['WH']},
      {arm_a: ['BK', 'WH'], arm_b: {length: 1}},
    ]) {
      await expect(
        source.submit({
          path: '/action/sighting',
          requestId: 'invalid-arms',
          payload,
        }),
      ).rejects.toMatchObject({status: 422, message: '手环颜色组合不完整。'});
    }
    const after = await source.read('/player');
    expect(after.match!.revision).toBe(before.match!.revision);
    expect(after.player).toEqual(before.player);
    expect((await source.result('invalid-arms')).status).toBe('pending');
  });

  it('validates every preview elimination row before changing any civilization', async () => {
    const source = new MockSource();
    source.reset('chief', 'verification');
    const before = await source.read('/judge');
    const living = before.civilizations.find(
      civilization => civilization.flight === 'active',
    )!;
    await expect(
      source.submit({
        path: '/judge/hunt-finalize',
        requestId: 'invalid-eliminations',
        payload: {
          eliminations: [{id: living.id, reason: 'outside_at_cutoff'}, null],
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);
    const after = await source.read('/judge');
    expect(after.civilizations).toEqual(before.civilizations);
    expect(after.match!.verification).toBe(true);
    expect(after.match!.revision).toBe(before.match!.revision);
  });

  it('rejects malformed preview site settings without replacing the valid configuration', async () => {
    const source = new MockSource();
    source.reset('chief', 'registration');
    const before = await source.read('/judge');
    await expect(
      source.submit({
        path: '/judge/site-config',
        requestId: 'invalid-site',
        payload: {site: {...before.site, colors: {BK: 42}}},
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect((await source.read('/judge')).site).toEqual(before.site);
  });

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
  it('rejects malformed unknown bracelet groups without throwing', () => {
    const sparseArm = ['BK', 'WH'];
    Reflect.deleteProperty(sparseArm, 1);
    const malformed: unknown[] = [
      null,
      undefined,
      false,
      7,
      'BK',
      {left: ['BK'], right: ['WH', 'GY']},
      [],
      [['BK']],
      [['BK'], ['WH', 'GY'], []],
      [['BK'], null],
      ['BK', ['WH', 'GY']],
      [['BK'], ['WH', 7]],
      [['BK'], ['WH', ['GY']]],
      [sparseArm, ['GY']],
    ];
    for (const value of malformed) {
      expect(validArms(value)).toBe(false);
    }
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
    expect(
      data.events
        .filter(e => e.kind === 'photon')
        .every(e => e.actor === undefined),
    ).toBe(true);
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
        payload: {code: '001234'},
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
    expect(ended.results?.standings.every(c => c.flight === 'eliminated')).toBe(
      true,
    );
  });
  it('does not charge a duplicate request twice', async () => {
    const source = new MockSource();
    const op = {
      path: '/action/broadcast',
      payload: {code: '000019'},
      requestId: 'stable-id',
    };
    expect(await source.submit(op)).toEqual(await source.submit(op));
    expect((await source.read('/player')).player?.broadcasts).toBe(1);
  });
  it('recovers an uncertain operation using its original request identifier', async () => {
    const source = new MockSource();
    source.setFault('unknown');
    const op = {
      path: '/action/broadcast',
      payload: {code: '000029'},
      requestId: 'unknown-id',
    };
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
      payload: {code: '000001'},
      requestId: 'homeworld',
    });
    const data = await source.read('/player/homeworld');
    expect(data.player?.homeworld).toBe('000001');
    expect(data.player?.flight).toBe('pending');
    expect(data.player?.actions).not.toContain('preflight-issue-code');
  });
});
