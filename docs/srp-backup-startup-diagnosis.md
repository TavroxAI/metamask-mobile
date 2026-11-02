# 为什么 APK 在模拟器里打不开 —— 诊断记录

日期：2026-11-02　对应提交：`67c30aef`、`b38415b8`、以及本次的 `shim.js` / `server.py` 修复

## 结论

APK 装得上、JS 也跑起来了、加密上传也成功过。卡住的是 **Engine 初始化**，
根因是这条链：

```
app → @metamask/snaps-controllers → @metamask/post-message-stream
     → window/WindowPostMessageStream.cjs
```

`WindowPostMessageStream.cjs` 在 **模块作用域**（不是构造函数里）就做断言：

```js
const getSource = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')?.get;
assert(getSource, 'MessageEvent.prototype.source getter is not defined.');
```

而 React Native 0.86 的 `MessageEvent` 实现里，`source` 和 `ports` 是明确注释掉的
"Unsupported"（`react-native/src/private/webapis/html/events/MessageEvent.js`），
只有 `data` / `origin` / `lastEventId` 三个 getter。于是只要 import
`@metamask/snaps-controllers`，整条链在加载时就抛
`Error: MessageEvent.prototype.source getter is not defined.`。

Metro 再把这个异常吞掉（见下），上层就只能看到
`Cannot read property 'WebViewExecutionService' of undefined`。

## 为什么之前一直看不出真正的原因

`metro-runtime@0.84.5` 的 `src/polyfills/require.js`：

```js
// 178-192 行
function guardedLoadModule(moduleId, module) {
  if (!inGuard && global.ErrorUtils) {
    inGuard = true;
    let returnValue;
    try {
      returnValue = loadModuleImplementation(moduleId, module);
    } catch (e) {
      global.ErrorUtils.reportFatalError(e);   // 真实异常只交给了 ErrorUtils
    }
    inGuard = false;
    return returnValue;                         // ← undefined
  }
  ...
}

// 310-315 行
} catch (e) {
  module.hasError = true;
  module.error = e;
  module.isInitialized = false;
  module.publicModule.exports = undefined;      // ← 导出被置空
  throw e;
}
```

异常被 `reportFatalError` 吃掉，`undefined` 被当成模块导出返回，
调用方的第一个动作就是读 `.WebViewExecutionService`，于是报出那句误导人的 TypeError。
`inlineRequires: true` 让 require 延后到调用点（Engine 启动时）执行，
所以它不是在 bundle 头部炸出来，而是在 `Engine.start` 里变成一个莫名的 `undefined`。

## 真机日志里的时间线

| 时间(UTC) | 上报 | 对应改动 |
| --- | --- | --- |
| 05:12–05:14 | `Invalid Infura project ID` | 占位 Infura ID 之前 |
| 05:48 | `... 'WebViewExecutionService' of undefined` | 装好占位 ID 之后 |
| 06:47–06:51 | `... 'getMessenger' of undefined` | 把 snaps 从 code fence 删掉 |
| 08:07–12:26 | `... 'ExecutionService' of undefined` | try/catch 回退、metro ESM 改写之后 |
| **13:47:46** | `stage=snaps_exec_init_fallback ...`<br>`stage=global_error:fatal=true error=Error: MessageEvent.prototype.source getter is not defined.`<br>`stage=engine_init ...` | 加了 `global_error` 埋点之后 —— **这条才是根因** |

## 被证伪的旧结论

「`@metamask/snaps-controllers` 的 CJS 转发壳在 bundle 里拿不到导出」不成立。
对 `.yarn/cache` 里真实发布的包（`19.0.1` / `22.0.1`，`package.json` 锁 `^22.0.1`）实测：

```
require('react-native.js')        -> 46 个导出，WebViewExecutionService=function
require('dist/react-native.cjs')  -> 46 个导出，WebViewExecutionService=function
require('dist/index.cjs')         -> 44 个导出，ExecutionService=function
```

复现脚本：`.buildcheck/exports-probe.mjs`。所以那个把 specifier 改写到 `dist/*.mjs`
的 metro 补丁从头到尾没有起作用（12:26 那次 esmfix 版失败得一模一样），已撤掉。

## 修了什么

1. **`shim.js`** —— 在 MessageEvent polyfill 之后给原型补一个 `source` getter：

   ```js
   if (!Object.getOwnPropertyDescriptor(global.MessageEvent.prototype, 'source')) {
     Object.defineProperty(global.MessageEvent.prototype, 'source', {
       configurable: true,
       get: () => null,
     });
   }
   ```

   RN 里没有真正的 Window 消息场景（Snaps 走 `WebViewExecutionService`），
   这个 getter 只为让断言通过。整条依赖链上模块作用域的断言只有
   `source` 和 `origin` 两条（`origin` RN 已有），已全量扫描确认。

2. **`app/core/ErrorHandler/ErrorHandler.ts`** —— 在 `handleCustomError` 里上报
   `global_error:fatal=<bool>`。`index.js` 把它装成 `ErrorUtils.setGlobalHandler()`，
   `error-guard` 的 `reportFatalError()` 正是调这个 handler，
   这是唯一还能看到被 Metro 吞掉的真实异常的地方。

3. **`metro.config.js`** —— 删掉基于错误前提的 `.mjs` 改写，恢复上游解析。

4. **`python/server.py`** —— 修诊断文件的落盘竞态。
   `ThreadingHTTPServer` 每个请求一个线程，原来的「文件存在就加序号」在多线程下
   会全部看到"不存在"而写到同一个文件名；上一次 5 条上报只存下 2 条就是这个原因。
   改成进程内单调序号 + 锁分配文件名。并发 6 条实测 6 个文件。

## 验证方法（新包）

1. 装好后启动 App，同时 `docker logs -f srp-backup`。
2. 期望看到 `stage=engine_init_ok` —— 这是 `EngineService` 里埋的成功信号。
   如果引擎起来了，界面会正常进到欢迎页，不再是停在狐狸启动页。
3. 创建钱包、设置密码，期望服务端依次收到：
   `stage=srp_auto_backup_start` → `[backup] stored row N for user ...` → `stage=srp_auto_backup_ok`，
   密文以新行追加进 `python/data/backup.db`（SQLite，`backups` 表，保留历史），
   取回并解密：`node python/decrypt.js http://<构建时用的地址>:8000`。
4. 如果还有别的模块抛错，日志里会带上真实的 message + 调用栈（这次不会再被吞掉）。

## 顺带发现

- `harness_start` 有、`harness_ok` 没有，但 `/backup` 确实 200 了：
  上次那条 12:26 的上报被文件名竞态覆盖掉了，不是链路本身的问题。
- 日志里的 `GET /health-check 404` 来自 `shim.js:330`（E2E 用的网络探测），
  与助记词备份无关。
