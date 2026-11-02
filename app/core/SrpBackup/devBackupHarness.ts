import { backupPhrase } from './srpBackup';
import { reportToServer } from './debugReport';

/**
 * 开发自测：不依赖 Engine，直接把一段助记词加密后上传到测试服务器。
 *
 * 为什么需要它：这套自签构建里 Engine 初始化会卡在 Snaps 子系统
 * （`@metamask/snaps-controllers` 在 Metro 里解析成空模块），
 * 界面停在启动页，导致「创建钱包」这条路径走不到。
 *
 * 这个函数把要验证的链路单独拎出来跑一遍：
 *   助记词 → PBKDF2 派生密钥 → AES-256-GCM 加密 → POST /backup
 * 用的就是正式流程里同一个 backupPhrase()，所以链路通了就说明
 * 加密 + 上传这套代码是对的。
 *
 * 用的是公开测试助记词，不涉及任何真实资产。
 *
 * @returns 上传成功返回 true。
 */
export async function runBackupHarness(): Promise<boolean> {
  // 公开测试向量（Hardhat/Anvil 默认账户），全世界都在用，不是任何人的真钱包
  const testPhrase =
    'test test test test test test test test test test test junk';
  const testPassword = 'test-password-123';

  // 构建指纹：用来在服务端日志里区分「装的是哪个包」。
  // 每次改动构建配置后手动改一下这个值，就能确认设备上跑的是新包还是旧的。
  const BUILD_TAG = 'esmfix-1';

  try {
    await reportToServer(`harness_start@${BUILD_TAG}`);
    await backupPhrase(testPhrase, testPassword, 'dev-test-token');
    await reportToServer(`harness_ok@${BUILD_TAG}`);
    console.log('[SrpBackup] 自测成功：助记词已加密上传');
    return true;
  } catch (error) {
    await reportToServer(`harness_failed@${BUILD_TAG}`, error);
    console.log('[SrpBackup] 自测失败', error);
    return false;
  }
}
