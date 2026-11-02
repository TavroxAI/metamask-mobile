import { resolveBaseUrl } from './srpBackup';

/**
 * 把 App 端的诊断信息发到本地测试服务器（POST /debug）。
 *
 * 为什么需要它：蓝叠的 ADB 起不来，抓不到 logcat；而 App 崩溃时
 * 用户能看到的只有 "Engine does not exist" 这种症状。把真实异常
 * 发到我们自己控制的服务上，排查时直接读 python/data/debug-*.json 即可。
 *
 * 永远不抛异常，诊断失败不影晌主流程。
 *
 * @param stage - 阶段标记，例如 'engine_init'、'srp_auto_backup'。
 * @param error - 捕获到的异常，可选。
 */
export async function reportToServer(
  stage: string,
  error?: unknown,
): Promise<void> {
  try {
    const baseUrl = await resolveBaseUrl();

    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : error === undefined
          ? ''
          : String(error);

    const stack =
      error instanceof Error && typeof error.stack === 'string'
        ? error.stack.slice(0, 2000)
        : '';

    await fetch(`${baseUrl}/debug`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stage,
        error: message,
        stack,
        at: new Date().toISOString(),
      }),
    });
  } catch {
    // 诊断通道失败就算了，绝不能影响主流程
  }
}
