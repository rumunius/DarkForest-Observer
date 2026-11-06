const encoder = new TextEncoder();
/** 生成不可预测的随机登录或操作秘密，调用方只持久化需要的摘要或密文。 */
export function token(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
/** 编码字节序列，支持大备份而不依赖展开巨型参数列表。 */
export function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)),
    );
  }
  return btoa(chunks.join(''));
}
/** 解码Base64字节；真实性由上层认证加密或消息认证负责。 */
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
/** 计算输入正文的安全摘要，供凭据、幂等和材料回读校验使用。 */
export async function digest(value: string): Promise<string> {
  return base64(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  );
}
/** 从配置秘密构造指定算法的CryptoKey，密钥材料只留在服务端。 */
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
/** 使用给定密钥认证正文，不把码本可枚举性误当作保密保证。 */
export async function mac(key: CryptoKey, value: string): Promise<string> {
  return base64(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, encoder.encode(value)),
    ),
  );
}
/** 用认证加密封装正文，并把用途及场次等上下文绑定到附加认证数据。 */
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
/** 验证密文及附加认证数据后还原正文，篡改或上下文不匹配将失败。 */
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
