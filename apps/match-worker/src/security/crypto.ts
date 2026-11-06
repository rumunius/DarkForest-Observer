const encoder = new TextEncoder();
export function token(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)),
    );
  }
  return btoa(chunks.join(''));
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
export async function digest(value: string): Promise<string> {
  return base64(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  );
}
export async function secretKey(
  raw: string | undefined,
  algorithm: 'HMAC' | 'AES-GCM',
): Promise<CryptoKey> {
  if (!raw) {
    throw new Error('SERVER_KEYS_MISSING');
  }
  const bytes = unbase64(raw);
  if (bytes.length !== 32) {
    throw new Error('SERVER_KEYS_INVALID');
  }
  return crypto.subtle.importKey(
    'raw',
    bytes,
    algorithm === 'HMAC' ? {name: 'HMAC', hash: 'SHA-256'} : 'AES-GCM',
    false,
    algorithm === 'HMAC' ? ['sign'] : ['encrypt', 'decrypt'],
  );
}
export async function mac(key: CryptoKey, value: string): Promise<string> {
  return base64(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, encoder.encode(value)),
    ),
  );
}
export async function encrypt(
  key: CryptoKey,
  value: string,
  aad: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv, additionalData: encoder.encode(aad)},
    key,
    encoder.encode(value),
  );
  return `${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function decrypt(
  key: CryptoKey,
  value: string,
  aad: string,
): Promise<string> {
  const [iv, data] = value.split('.');
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: unbase64(iv!), additionalData: encoder.encode(aad)},
      key,
      unbase64(data!),
    ),
  );
}
