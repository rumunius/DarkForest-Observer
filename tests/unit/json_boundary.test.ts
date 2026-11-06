import {describe, expect, it} from 'vitest';
import type {PlatformSession} from '@darkforest/contracts';
import {
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonObjects,
  jsonString,
  parseJson,
  platformSession,
} from '../helpers/json';

const session: PlatformSession = {
  account: {
    id: 'staff-1',
    kind: 'staff',
    name: '裁判',
    status: 'active',
    version: 1,
    auth_epoch: 2,
    tags: '',
  },
  roles: ['owner', 'archivist'],
  csrfToken: 'csrf-1',
  secondFactor: false,
};

describe('test response boundaries', () => {
  it('decodes object, array and scalar values without coercing their types', () => {
    const decoded = parseJson('{"items":[{"id":"C01"}],"version":3}');
    const record = jsonObject(decoded);
    expect(jsonObjects(record.items).map(item => jsonString(item.id))).toEqual([
      'C01',
    ]);
    expect(jsonNumber(record.version)).toBe(3);
    expect(jsonArray(parseJson('[1,null,"2"]'))).toEqual([1, null, '2']);
    expect(() => parseJson('{')).toThrow(SyntaxError);
  });

  it('rejects malformed records, arrays and numeric strings at their use boundary', () => {
    for (const value of [null, undefined, [], 'record', 1]) {
      expect(() => jsonObject(value)).toThrow(TypeError);
    }
    expect(() => jsonArray({length: 2})).toThrow(TypeError);
    expect(() => jsonObjects([{}, null])).toThrow(TypeError);
    expect(() => jsonString(123)).toThrow(TypeError);
    for (const value of ['3', Infinity, NaN]) {
      expect(() => jsonNumber(value)).toThrow(TypeError);
    }
  });

  it('validates the login contract and preserves an absent second factor preference', () => {
    expect(platformSession(session)).toEqual(session);
    expect('secondFactorEnabled' in platformSession(session)).toBe(false);
    expect(
      platformSession({...session, secondFactorEnabled: true})
        .secondFactorEnabled,
    ).toBe(true);
  });

  it('rejects malformed login roles, account fields and second factor states', () => {
    for (const value of [
      {...session, roles: ['judge']},
      {...session, account: {...session.account, kind: 'owner'}},
      {...session, account: {...session.account, status: 'deleted'}},
      {...session, account: {...session.account, version: '1'}},
      {...session, secondFactor: 'false'},
      {...session, secondFactorEnabled: 0},
      {...session, csrfToken: null},
    ]) {
      expect(() => platformSession(value)).toThrow(TypeError);
    }
  });
});
