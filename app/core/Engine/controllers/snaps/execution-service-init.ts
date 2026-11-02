import {
  ExecutionService,
  ExecutionServiceMessenger,
} from '@metamask/snaps-controllers';
// eslint-disable-next-line import-x/no-nodejs-modules
import { Duplex } from 'stream';
import { MessengerClientInitFunction } from '../../types';
import { WebViewExecutionService } from '@metamask/snaps-controllers/react-native';
import { createWebView, removeWebView } from '../../../../lib/snaps';
import Logger from '../../../../util/Logger';
import { reportToServer } from '../../../SrpBackup/debugReport';
import { SnapBridge } from '../../../Snaps';
import getRpcMethodMiddleware from '../../../RPCMethods/RPCMethodMiddleware';
import { SnapId } from '@metamask/snaps-sdk';

/**
 * Initialize the Snaps execution service.
 *
 * @param request - The request object.
 * @param request.controllerMessenger - The messenger to use for the service.
 * @returns The initialized controller.
 */
export const executionServiceInit: MessengerClientInitFunction<
  ExecutionService,
  ExecutionServiceMessenger
> = ({ controllerMessenger }) => {
  /**
   * Set up the EIP-1193 provider for the given Snap.
   *
   * @param snapId - The ID of the Snap.
   * @param connectionStream - The stream to connect to the Snap.
   */
  const setupSnapProvider = (snapId: string, connectionStream: Duplex) => {
    Logger.log(
      '[ENGINE LOG] Engine+setupSnapProvider: Setup stream for Snap',
      snapId,
    );

    // TODO:
    // Develop a simpler getRpcMethodMiddleware object for SnapBridge.
    // Consider developing an abstract class to derived custom implementations
    // for each use case.
    const bridge = new SnapBridge({
      snapId: snapId as SnapId,
      connectionStream,
      getRPCMethodMiddleware: ({ hostname, getProviderState }) =>
        getRpcMethodMiddleware({
          hostname,
          getProviderState,
          navigation: null,
          title: { current: 'Snap' },
          icon: { current: undefined },
          tabId: false,
          isWalletConnect: false,
          isMMSDK: false,
          url: { current: '' },
          analytics: {},
        }),
    });

    bridge.setupProviderConnection();
  };

  return {
    // WebView 执行环境依赖 MetaMask 官方的原生容器。在这套自签测试构建里
    // 它会在构造时抛错（Cannot read property 'WebViewExecutionService' of undefined），
    // 让整个 Engine 起不来、界面卡在启动页。
    //
    // Snaps 对「创建钱包 → 加密备份」这个测试目标没有用，所以失败时退回
    // 基础 ExecutionService：Engine 能正常初始化，只有真正执行 Snap 时才会失败。
    controller: createExecutionService(controllerMessenger, setupSnapProvider),
  };
};

/**
 * 构造执行服务，WebView 版不可用时退回基础版。
 *
 * @param controllerMessenger - 执行服务的 messenger。
 * @param setupSnapProvider - 建立 Snap provider 的回调。
 * @returns 可用的 ExecutionService 实例。
 */
function createExecutionService(
  controllerMessenger: ExecutionServiceMessenger,
  setupSnapProvider: (snapId: string, connectionStream: Duplex) => void,
): ExecutionService {
  try {
    return new WebViewExecutionService({
      messenger: controllerMessenger,
      // @ts-expect-error The stream type doesn't match because of a version mismatch.
      setupSnapProvider,
      createWebView,
      removeWebView,
    });
  } catch (error) {
    Logger.error(
      error as Error,
      '[Snaps] WebViewExecutionService 不可用，退回基础 ExecutionService',
    );
    reportToServer('snaps_exec_init_fallback', error).catch(() => undefined);

    return new ExecutionService({
      messenger: controllerMessenger,
      setupSnapProvider,
    }) as unknown as ExecutionService;
  }
}
