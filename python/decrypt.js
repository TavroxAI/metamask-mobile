#!/usr/bin/env node
/**
 * 本地解密助记词备份（和 App 里的 srpBackup.ts 完全同一套参数）。
 *
 * 密钥来源是「固定口令」= 构建时注入 App 的服务器地址（MM_SRP_BACKUP_API_URL），
 * 不是设备登录密码。所以忘了登录密码也能在这里解出来。
 *
 * 用法：
 *   # 解服务器上现有的那份（默认 token dev-test-token）
 *   node python/decrypt.js http://192.168.0.101:8000
 *
 *   # 解本地文件
 *   node python/decrypt.js python/data/3c2ee5a3d75c270d.json http://192.168.0.101:8000
 *
 *   # 换 token（token 决定服务端文件名：sha256(token) 前 16 位）
 *   node python/decrypt.js http://192.168.0.101:8000 http://192.168.0.101:8000 dev-test-token
 *
 * 第一个参数既当「去哪取」也当「解密口令」，两者必须和构建 APK 时用的地址一致；
 * 也可以只用 MM_SRP_BACKUP_API_URL 环境变量：
 *   MM_SRP_BACKUP_API_URL=http://192.168.0.101:8000 node python/decrypt.js
 */

const crypto = require('crypto');
const fs = require('fs');

/** 与 App 一致：PBKDF2-SHA256，60 万次，32 字节密钥。 */
const ITERATIONS = 600000;

const [, , arg1, arg2, arg3] = process.argv;
const envUrl = (process.env.MM_SRP_BACKUP_API_URL || '').trim();

// 参数可以是 URL，也可以是本地文件路径
const looksLikeUrl = (value) => /^https?:\/\//i.test(value || '');
const source = arg1 || envUrl;
if (!source) {
  console.error(
    '用法: node python/decrypt.js <http://服务器:8000 | 备份文件.json> [服务器地址] [token]',
  );
  process.exit(2);
}

const baseUrl = (looksLikeUrl(source) ? arg2 || source : arg2 || envUrl).replace(/\/+$/, '');
if (!looksLikeUrl(baseUrl)) {
  console.error(
    `缺少服务器地址：解密口令就是构建时注入的 MM_SRP_BACKUP_API_URL，必须显式给出（当前: "${baseUrl}"）`,
  );
  process.exit(2);
}
const token = arg3 || 'dev-test-token';

/**
 * 用固定口令 + 文件里的 salt 派生 32 字节密钥。
 *
 * @param {string} passphrase 固定口令（服务器地址）。
 * @param {Buffer} salt 随机盐。
 * @returns {Buffer} 密钥。
 */
function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, 32, 'sha256');
}

/**
 * 按 App 的布局解密：data = 密文 + 末尾 16 字节 GCM tag。
 *
 * @param {{salt: string, iv: string, data: string}} blob 备份内容。
 * @param {string} passphrase 固定口令。
 * @returns {string} 助记词明文。
 */
function decrypt(blob, passphrase) {
  const sealed = Buffer.from(blob.data, 'base64');
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(0, sealed.length - 16);
  const key = deriveKey(passphrase, Buffer.from(blob.salt, 'base64'));
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(blob.iv, 'base64'),
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * 取备份：URL 就走 /backup 接口，否则读本地文件。
 *
 * @returns {Promise<{salt: string, iv: string, data: string}>} 备份内容。
 */
async function loadBlob() {
  if (looksLikeUrl(source)) {
    const response = await fetch(`${baseUrl}/backup`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`GET ${baseUrl}/backup -> ${response.status}`);
    }
    return response.json();
  }
  // 去掉可能的 UTF-8 BOM：Windows 上导出/另存的文件常带它，会让 JSON.parse 直接失败
  return JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
}

(async () => {
  const blob = await loadBlob();
  console.log(`来源     : ${source}`);
  console.log(`口令(URL): ${baseUrl}`);
  console.log(`token    : ${token}`);
  try {
    const phrase = decrypt(blob, baseUrl);
    const words = phrase.trim().split(/\s+/);
    console.log(`解密结果 : ${words.length} 个单词（GCM 认证通过，密码正确）`);
    console.log('');
    console.log(phrase);
  } catch (error) {
    // GCM 认证失败基本都是「地址不对」或「不是这套口令加密的旧备份」
    console.error(
      `解密失败: ${error.message}\n` +
        '最常见原因：给的服务器地址和构建 APK 时的 MM_SRP_BACKUP_API_URL 不一致，' +
        '或者这份备份是早期用设备登录密码加密的（那种已经解不开了）。',
    );
    process.exit(1);
  }
})();
