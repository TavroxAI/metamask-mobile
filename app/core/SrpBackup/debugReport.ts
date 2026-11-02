import { resolveBaseUrl } from './srpBackup';

/**
 * 把 RN 的 stack 转成可读文本。
 *
 * 某些运行时（JSC）的 `error.stack` 是 CallSite 对象数组，
 * 直接 String() 会得到一串 "[object CallSite]"，排查时毫无用处。
 * 这里按帧读取函数名/文件/行号。
 *
 * @param error - 捕获到的异常。
 * @returns 可读的调用栈，最多 4000 字符。
 */
function formatStack(error: unknown): string {
  if (!(error instanceof Error)) {
    return '';
  }

  const raw = (error as { stack?: unknown }).stack;

  if (typeof raw === 'string') {
    return raw.slice(0, 4000);
  }

  if (Array.isArray(raw)) {
    const lines = raw.map((frame) => {
      const callSite = frame as {
        getFunctionName?: () => string | null;
        getFileName?: () => string | null;
        getLineNumber?: () => number | null;
        getColumnNumber?: () => number | null;
      };

      const fn = callSite.getFunctionName?.() ?? '<anonymous>';
      const file = callSite.getFileName?.() ?? '?';
      const line = callSite.getLineNumber?.() ?? 0;
      const column = callSite.getColumnNumber?.() ?? 0;

      return `${fn} (${file}:${line}:${column})`;
    });

    return lines.join('\n').slice(0, 4000);
  }

  return String(raw).slice(0, 4000);
}

/**
 * 把 App 端的诊断信息发到本地测试服务器（POST /debug）。
 *
 * 为什么需要它：蓝叠的 ADB 起不来，抓不到 logcat；而 App 崩溃时
 * 用户能看到的只有 "Engine does not exist" 这种症状。把真实异常
 * 发到我们自己控制的服务上，排查时直接读 python/data/debug-*.json 即可。
 *
 * 永远不抛异常，诊断失败不影响主流程。
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

    await fetch(`${baseUrl}/debug`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stage,
        error: message,
        stack: formatStack(error),
        at: new Date().toISOString(),
      }),
    });
  } catch {
    // 诊断通道失败就算了，绝不能影响主流程
  }
}
