import { ErrorHandlerCallback } from 'react-native';
import { reportToServer } from '../SrpBackup/debugReport';

let reactNativeDefaultHandler: ErrorHandlerCallback;

/**
 * Set the default error handler from react-native
 * @param handler
 */
export const setReactNativeDefaultHandler = (handler: ErrorHandlerCallback) => {
  reactNativeDefaultHandler = handler;
};

export const handleCustomError = (error: Error, isFatal: boolean) => {
  // 诊断：Metro 的 guardedLoadModule 在加载模块失败时会先调
  // global.ErrorUtils.reportFatalError(真实异常)，然后把 undefined 当作
  // 模块导出返回（见 metro-runtime/src/polyfills/require.js:178-192）。
  // 结果是上层看到的只是 "Cannot read property 'X' of undefined"，
  // 真正的原因被吃掉。这个 handler 是唯一还能拿到真实异常的地方，
  // 所以在这里上报一次。
  reportToServer(`global_error:fatal=${String(isFatal)}`, error).catch(
    () => undefined,
  );

  // Check whether the error is from the Ledger native bluetooth errors.
  if (
    error.name === 'EthAppPleaseEnableContractData' ||
    error.name === 'TransportStatusError' ||
    error.name === 'DisconnectedDevice'
  ) {
    // dont pass the error to react native error handler to prevent app crash
    console.error('Ledger error: ', error.message);
    // check error message contain "KeystoneError#Tx_canceled"
  } else if (
    error.name === 'Error' &&
    error.message?.includes('KeystoneError#Tx_canceled')
  ) {
    console.error('Keystone error: ', error.message);
  } else {
    // Pass the error to react native error handler
    reactNativeDefaultHandler(error, isFatal);
  }
};

export const getReactNativeDefaultHandler = () => reactNativeDefaultHandler;
