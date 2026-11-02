import { RpcEndpointType } from '@metamask/network-controller';
import type { UpdateNetworkFields } from '@metamask/network-controller';
import { Hex } from '@metamask/utils';
import Engine from '../../core/Engine';
import Logger from '../Logger';

/**
 * 自用配置：以太坊主网用公共 RPC 替代 Infura。
 *
 * 项目的内置网络里，主网默认端点是 `https://mainnet.infura.io/v3/{infuraProjectId}`。
 * 个人 fork 拿不到 MetaMask 的 Infura key，占位 key 一律 401，表现就是首页
 * 那条「无法连接到 Ethereum」。这里在 Engine 起好之后把默认端点换成公共节点。
 *
 * 为什么放在运行时，而不是直接改内置网络常量：内置配置是
 * `@metamask/network-controller` 里的常量，App 侧唯一支持的入口是
 * `NetworkController.updateNetwork`；改完会写进控制器状态并被持久化，
 * 所以只会真正执行一次，之后启动检测到已不是 Infura 端点就直接跳过。
 */

/** 公共 Ethereum 主网 RPC（无需 API key）。 */
export const PUBLIC_ETHEREUM_MAINNET_RPC_URL =
  'https://ethereum-rpc.publicnode.com';

/** 以太坊主网 chainId。 */
const ETHEREUM_MAINNET_CHAIN_ID = '0x1' as Hex;

/** Infura 端点特征：命中说明还是内置默认值（不管有没有配 key）。 */
const INFURA_RPC_URL_PATTERN = /\.infura\.io\/v3\//u;

/**
 * 把以太坊主网的默认 RPC 端点换成 {@link PUBLIC_ETHEREUM_MAINNET_RPC_URL}。
 *
 * 两种情况不做任何改动，避免覆盖用户自己的选择：
 *   1. 当前默认端点不是 Infura（用户已经手动配过 RPC）
 *   2. 列表里已经有这个公共节点
 *
 * @returns 是否真的做了替换。
 */
export async function usePublicEthereumMainnetRpc(): Promise<boolean> {
  const { NetworkController } = Engine.context;
  const { networkConfigurationsByChainId } = NetworkController.state;
  const network = networkConfigurationsByChainId[ETHEREUM_MAINNET_CHAIN_ID];

  if (!network) {
    return false;
  }

  const currentEndpoint =
    network.rpcEndpoints[network.defaultRpcEndpointIndex ?? 0];

  if (!currentEndpoint || !INFURA_RPC_URL_PATTERN.test(currentEndpoint.url)) {
    return false;
  }

  const alreadyAdded = network.rpcEndpoints.some(
    ({ url }) => url.replace(/\/+$/u, '') === PUBLIC_ETHEREUM_MAINNET_RPC_URL,
  );

  if (alreadyAdded) {
    return false;
  }

  const rpcEndpoints = [
    ...network.rpcEndpoints,
    {
      url: PUBLIC_ETHEREUM_MAINNET_RPC_URL,
      name: 'Public RPC',
      type: RpcEndpointType.Custom,
      failoverUrls: [],
    },
  ];
  const defaultRpcEndpointIndex = rpcEndpoints.length - 1;

  await NetworkController.updateNetwork(
    network.chainId,
    {
      ...network,
      rpcEndpoints,
      defaultRpcEndpointIndex,
    } as unknown as UpdateNetworkFields,
    { replacementSelectedRpcEndpointIndex: defaultRpcEndpointIndex },
  );

  Logger.log(
    '[publicRpc] 以太坊主网默认 RPC 已切换为',
    PUBLIC_ETHEREUM_MAINNET_RPC_URL,
  );

  return true;
}
