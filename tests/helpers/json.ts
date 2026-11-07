import type {PlatformSession} from '@darkforest/contracts';

/** Decode without trusting JSON.parse's any; each use must validate its shape. */
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** Require a JSON object before reading response or persisted audit fields. */
export function jsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

/** Require a JSON array, leaving its elements unknown until individually checked. */
export function jsonArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Expected a JSON array');
  }
  return value;
}

/** Validate record arrays once so predicates can use named fields directly. */
export function jsonObjects(value: unknown): Array<Record<string, unknown>> {
  return jsonArray(value).map(jsonObject);
}

/** Require a string rather than coercing malformed response or SQL values. */
export function jsonString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Expected a JSON string');
  }
  return value;
}

/** Require a number before using response data in numeric API arguments. */
export function jsonNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Expected a finite JSON number');
  }
  return value;
}

/** Validate the public login contract used to authorize subsequent test requests. */
export function platformSession(value: unknown): PlatformSession {
  const session = jsonObject(value);
  const account = jsonObject(session.account);
  const {kind, status} = account;
  if (kind !== 'player' && kind !== 'staff') {
    throw new TypeError('Invalid account kind');
  }
  if (status !== 'pending' && status !== 'active' && status !== 'disabled') {
    throw new TypeError('Invalid account status');
  }
  const roles = jsonArray(session.roles).map(role => {
    if (role !== 'owner' && role !== 'admin' && role !== 'archivist') {
      throw new TypeError('Invalid platform role');
    }
    return role;
  });
  if (typeof session.secondFactor !== 'boolean') {
    throw new TypeError('Invalid second factor state');
  }
  if (
    session.secondFactorEnabled !== undefined &&
    typeof session.secondFactorEnabled !== 'boolean'
  ) {
    throw new TypeError('Invalid second factor preference');
  }
  return {
    account: {
      id: jsonString(account.id),
      kind,
      name: jsonString(account.name),
      status,
      version: jsonNumber(account.version),
      auth_epoch: jsonNumber(account.auth_epoch),
      tags: jsonString(account.tags),
    },
    roles,
    csrfToken: jsonString(session.csrfToken),
    secondFactor: session.secondFactor,
    ...(session.secondFactorEnabled === undefined
      ? {}
      : {secondFactorEnabled: session.secondFactorEnabled}),
  };
}
