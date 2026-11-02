import QuickCrypto from 'react-native-quick-crypto';
import { Buffer } from '@craftzdog/react-native-buffer';
import { validateMnemonic } from '@metamask/scure-bip39';
import { wordlist } from '@metamask/scure-bip39/dist/wordlists/english';
import { uint8ArrayToMnemonic } from '../../util/mnemonic';

/**
 * 助记词加密备份（自用本地部署版）
 *
 * 两个函数：
 *   backupPhrase(助记词, token)  → 加密后 POST 到服务器
 *   restorePhrase(token)         → 从服务器取回来、解密
 *
 * 加密方式：一个「固定口令」用 PBKDF2 派生 256 位密钥，再用 AES-256-GCM 加密助记词。
 *
 * 固定口令 = 构建时注入的服务器地址（MM_SRP_BACKUP_API_URL）。
 * 故意不用设备登录密码：那样一旦忘了密码，自己的备份就永远解不开了。
 * 用这个地址当口令，忘了登录密码也照样能解，而且口令本身就在构建配置里，
 * 不存在"记不住"的问题。代价是它不算真正的秘密（能拿到 URL 就能解），
 * 加密的作用是保证传输/落盘过程中即使被看到也只有密文。
 *
 * 只往这一个地址 POST，不做多地址回退：密文也只能发到你自己配置的那台服务器。
 *
 * 上线前 TODO：
 *   1. 换成 scrypt（抗 GPU 爆破，仓库里 profile-sync 有现成实现）
 *   2. 解密前校验 KDF 参数下限（防服务端偷改参数降级爆破）
 *   3. 把 userId 绑进加密（防服务端拿别人的备份喂给你）
 */

/** PBKDF2 迭代次数（OWASP 2023 对 SHA-256 的最低要求）。 */
const ITERATIONS = 600_000;

/**
 * 构建时注入的服务器地址（babel 会把 process.env 内联成字面量）。
 *
 * 它同时是「备份终点」和「加密口令」的来源，所以必须是构建期常量：
 * 如果改用运行时探测出来的地址当口令，模拟器和真机会派生出不同密钥，
 * 备份就解不开了。
 */
const CONFIGURED_BASE_URL = (process.env.MM_SRP_BACKUP_API_URL ?? '').trim();

/**
 * 诊断上报用的候选地址（只给 reportToServer 用，不参与加密，也不收助记词）。
 *
 * 模拟器、模拟器回环、真机局域网 IP 各不相同，运行时逐个探测 `/health`，
 * 用第一个通的，这样换环境不用重新构建 APK。
 *
 *   Android 模拟器 → 宿主机：10.0.2.2（模拟器里的 127.0.0.1 指它自己）
 *   iOS 模拟器：  127.0.0.1
 *   真机：        电脑的局域网 IP
 */
const CANDIDATE_BASE_URLS: string[] = [
  CONFIGURED_BASE_URL,
  'http://10.0.2.2:8000',
  'http://127.0.0.1:8000',
  'http://192.168.0.101:8000',
].filter((url) => url.length > 0);

/**
 * 备份专用地址：只有它，没有回退。
 *
 * 助记词只会发到这里，避免"配置的服务器没起来时顺手发到别的地址"。
 *
 * @returns 去掉结尾斜杠的服务器地址。
 */
function backupEndpoint(): string {
  if (!CONFIGURED_BASE_URL) {
    throw new Error(
      'MM_SRP_BACKUP_API_URL 未配置：既不知道往哪台服务器备份，也无法派生备份口令',
    );
  }
  return CONFIGURED_BASE_URL.replace(/\/+$/, '');
}

/**
 * 加密口令：固定为构建时注入的服务器地址。
 *
 * 不是设备密码，所以忘了登录密码也能解密。
 *
 * @returns 用作 PBKDF2 输入的字符串。
 */
function backupPassphrase(): string {
  return backupEndpoint();
}

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
 * 导出是为了让 debugReport 复用同一套地址解析。
 *
 * @returns 可用的服务器地址。全都不通时返回第一个候选（让请求自己失败）。
 */
export async function resolveBaseUrl(): Promise<string> {
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
 * 用固定口令派生 32 字节密钥。
 *
 * @param passphrase - 固定口令（构建时注入的服务器地址）。
 * @param salt - 随机盐，每条备份独立生成。
 * @returns 32 字节密钥。
 */
async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const baseKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
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
 * 把助记词统一成词串。
 *
 * `KeyringController.exportSeedPhrase()` 返回的是 `Uint8Array`（每 2 字节一个小端
 * 单词索引），不是字符串。之前直接把它传给加密函数，`TextEncoder` 会对数组做
 * `toString()`，存进去就变成 `"145,2,112,..."` 这种索引串，恢复时没法用。
 *
 * 所以这里同时接受两种形态，并且做一次 BIP-39 校验：校验不过直接报错，
 * 绝不把解析不出来的东西加密上传。
 *
 * @param phrase - 词串，或者 exportSeedPhrase 返回的索引数组。
 * @returns 标准的 12/15/18/21/24 词助记词。
 */
function normalizeSeedPhrase(phrase: string | Uint8Array): string {
  const mnemonic =
    typeof phrase === 'string'
      ? phrase.trim()
      : uint8ArrayToMnemonic(phrase, wordlist);

  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error(
      `备份内容不是合法的 BIP-39 助记词（${mnemonic.split(' ').length} 个词）`,
    );
  }

  return mnemonic;
}

/**
 * 加密助记词并上传。
 *
 * 助记词只在这个函数里出现一次，函数返回时只剩下密文在网络上。
 * 只发往构建时配置的那一个地址。
 *
 * @param phrase - 助记词词串，或 `exportSeedPhrase()` 返回的索引数组。
 * @param token - 后端 bearer token（测试阶段用固定值即可）。
 */
export async function backupPhrase(
  phrase: string | Uint8Array,
  token: string,
): Promise<void> {
  const mnemonic = normalizeSeedPhrase(phrase);
  const baseUrl = backupEndpoint();

  const salt = QuickCrypto.getRandomValues(new Uint8Array(16));
  const iv = QuickCrypto.getRandomValues(new Uint8Array(12));

  const key = await deriveKey(backupPassphrase(), salt);
  const cryptoKey = await subtle.importKey('raw', key, 'AES-GCM', false, [
    'encrypt',
  ]);

  // GCM 的输出 = 密文 + 16 字节认证标签，所以不用单独存 tag。
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      new TextEncoder().encode(mnemonic),
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
 * 不需要用户密码：密钥由固定口令（构建时注入的服务器地址）派生，
 * 所以忘了登录密码也能把助记词取回来。
 *
 * @param token - 后端 bearer token。
 * @returns 助记词明文。
 */
export async function restorePhrase(token: string): Promise<string> {
  const baseUrl = backupEndpoint();

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

  const key = await deriveKey(backupPassphrase(), fromBase64(salt));
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
