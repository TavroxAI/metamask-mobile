import QuickCrypto from 'react-native-quick-crypto';
import { Buffer } from '@craftzdog/react-native-buffer';

/**
 * 助记词加密备份（测试阶段最简版）
 *
 * 两个函数：
 *   backupPhrase(助记词, 密码, token)  → 加密后 POST 到服务器
 *   restorePhrase(密码, token)         → 从服务器取回来、解密
 *
 * 加密方式：密码用 PBKDF2 派生一把 256 位密钥，再用 AES-256-GCM 加密助记词。
 * 服务器只会收到密文，没有密码解不开。
 *
 * 上线前 TODO（现在故意不做，先跑通链路）：
 *   1. 换成 scrypt（抗 GPU 爆破，仓库里 profile-sync 有现成实现）
 *   2. 解密前校验 KDF 参数下限（防服务端偷改参数降级爆破）
 *   3. 把 userId 绑进加密（防服务端拿别人的备份喂给你）
 */

/** PBKDF2 迭代次数（OWASP 2023 对 SHA-256 的最低要求）。 */
const ITERATIONS = 600_000;

/**
 * 候选服务器地址。
 *
 * 模拟器、模拟器回环、真机局域网 IP 各不相同，运行时逐个探测 `/health`，
 * 用第一个通的，这样换环境不用重新构建 APK。
 *
 *   Android 模拟器 → 宿主机：10.0.2.2（模拟器里的 127.0.0.1 指它自己）
 *   iOS 模拟器：  127.0.0.1
 *   真机：        电脑的局域网 IP
 */
const CANDIDATE_BASE_URLS: string[] = [
  process.env.MM_SRP_BACKUP_API_URL ?? '',
  'http://10.0.2.2:8000',
  'http://127.0.0.1:8000',
  'http://192.168.0.101:8000',
].filter((url) => url.length > 0);

let resolvedBaseUrl: string | undefined;

// react-native-quick-crypto 的 subtle 类型声明比实际用法严格，这里放宽一次。
type Subtle = {
  importKey: (...args: unknown[]) => Promise<unknown>;
  deriveBits: (...args: unknown[]) => Promise<ArrayBuffer>;
  encrypt: (...args: unknown[]) => Promise<ArrayBuffer>;
  decrypt: (...args: unknown[]) => Promise<ArrayBuffer>;
};
const subtle = QuickCrypto.subtle as unknown as Subtle;

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64');

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(Buffer.from(text, 'base64'));

/**
 * 探测哪个候选地址可用，并缓存结果。
 *
 * @returns 可用的服务器地址。全都不通时返回第一个候选（让请求自己失败）。
 */
async function resolveBaseUrl(): Promise<string> {
  if (resolvedBaseUrl) {
    return resolvedBaseUrl;
  }

  for (const candidate of CANDIDATE_BASE_URLS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const response = await fetch(`${candidate}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok) {
        resolvedBaseUrl = candidate;
        return candidate;
      }
    } catch {
      // 这个地址不通，试下一个
    }
  }

  return CANDIDATE_BASE_URLS[0];
}

/**
 * 用密码派生 32 字节密钥。
 *
 * @param password - 用户的解锁密码。
 * @param salt - 随机盐，每条备份独立生成。
 * @returns 32 字节密钥。
 */
async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    baseKey,
    256,
  );

  return new Uint8Array(bits);
}

/**
 * 加密助记词并上传。
 *
 * 助记词只在这个函数里出现一次，函数返回时只剩下密文在网络上。
 *
 * @param phrase - 助记词明文。
 * @param password - 用户的解锁密码。
 * @param token - 后端 bearer token（测试阶段用固定值即可）。
 */
export async function backupPhrase(
  phrase: string,
  password: string,
  token: string,
): Promise<void> {
  const baseUrl = await resolveBaseUrl();

  const salt = QuickCrypto.getRandomValues(new Uint8Array(16));
  const iv = QuickCrypto.getRandomValues(new Uint8Array(12));

  const key = await deriveKey(password, salt);
  const cryptoKey = await subtle.importKey('raw', key, 'AES-GCM', false, [
    'encrypt',
  ]);

  // GCM 的输出 = 密文 + 16 字节认证标签，所以不用单独存 tag。
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      new TextEncoder().encode(phrase),
    ),
  );

  key.fill(0); // 密钥用完清零

  const response = await fetch(`${baseUrl}/backup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      salt: toBase64(salt),
      iv: toBase64(iv),
      data: toBase64(sealed),
    }),
  });

  if (!response.ok) {
    throw new Error(`备份上传失败: ${response.status} (${baseUrl})`);
  }
}

/**
 * 取回备份并解密。
 *
 * @param password - 用户的解锁密码。错了这里会抛异常。
 * @param token - 后端 bearer token。
 * @returns 助记词明文。
 */
export async function restorePhrase(
  password: string,
  token: string,
): Promise<string> {
  const baseUrl = await resolveBaseUrl();

  const response = await fetch(`${baseUrl}/backup`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`备份读取失败: ${response.status} (${baseUrl})`);
  }

  const { salt, iv, data } = (await response.json()) as {
    salt: string;
    iv: string;
    data: string;
  };

  const key = await deriveKey(password, fromBase64(salt));
  const cryptoKey = await subtle.importKey('raw', key, 'AES-GCM', false, [
    'decrypt',
  ]);
  key.fill(0);

  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    cryptoKey,
    fromBase64(data),
  );

  return new TextDecoder().decode(plain);
}
