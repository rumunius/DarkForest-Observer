import {base64, mac, secretKey, unbase64} from '../security/crypto';
import {requireThat} from '../storage/store';
import type {BackendEnv} from '../rpc/types';

/** 按用途和环境从根密钥派生秘密，隔离平台不同密码学用途。 */
export async function derive(
  env: BackendEnv,
  purpose: string,
): Promise<string> {
  return mac(
    await secretKey(env.CODE_HMAC_KEY, 'HMAC'),
    `darkforest|${env.APP_ENV}|v2|${purpose}`,
  );
}
/** 认证平台与比赛对象之间的控制消息；签名覆盖调用方提供的完整正文。 */
export async function controlSignature(
  env: BackendEnv,
  body: string,
): Promise<string> {
  return mac(
    await secretKey(await derive(env, 'internal-control'), 'HMAC'),
    body,
  );
}
/** 把随机密钥编码为第二因素应用可读取的Base32文本。 */
export function base32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}
/** 校验并解码第二因素Base32密钥；非法长度或字符会被拒绝。 */
export function decode32(value: string): Uint8Array<ArrayBuffer> {
  requireThat(
    /^[A-Z2-7]{32}$/.test(value),
    'BAD_TOTP',
    '第二因素密钥格式不正确。',
    400,
  );
  let bits = 0;
  let carry = 0;
  const out = [];
  for (const c of value) {
    carry = (carry << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((carry >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
/** 使用持久秘密和指定时间步生成一次性验证码，不自行决定验证码是否可重放。 */
export async function totp(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    decode32(secret),
    {name: 'HMAC', hash: 'SHA-1'},
    false,
    ['sign'],
  );
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = bytes[19]! & 15;
  const value = new DataView(bytes.buffer).getUint32(offset) & 0x7fffffff;
  return String(value % 1000000).padStart(6, '0');
}
/** 验证允许窗口内且晚于已消费时间步的验证码，失败返回负值。 */
export async function verifyTotp(
  secret: string,
  code: string,
  after: number,
  now = Date.now(),
): Promise<number> {
  for (const delta of [-1, 0, 1]) {
    const step = Math.floor(now / 30000) + delta;
    if (step > after && (await totp(secret, step)) === code) {
      return step;
    }
  }
  return -1;
}
/** 按UTF-8计算JSON传输大小，供响应与备份容量限制使用。 */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
// A versioned per-purpose AES key is never sent to the browser.
/** 派生平台数据加密密钥；轮换任一根密钥都需要显式重新加密。 */
export async function platformKey(env: BackendEnv): Promise<CryptoKey> {
  const root = await secretKey(env.CODE_ENCRYPTION_KEY, 'AES-GCM');
  void root;
  // Include both roots: rotating either requires the explicit re-encryption workflow.
  return secretKey(
    await derive(env, `platform-encryption|${env.CODE_ENCRYPTION_KEY}`),
    'AES-GCM',
  );
}
/** 将UTF-8正文编码成Base64，用于运维材料的可逆传输。 */
export function utf8Base64(value: string): string {
  return base64(new TextEncoder().encode(value));
}
/** 从Base64还原UTF-8正文；不承担材料签名或真实性校验。 */
export function fromUtf8Base64(value: string): string {
  return new TextDecoder().decode(unbase64(value));
}
