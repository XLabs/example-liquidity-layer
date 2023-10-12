import { parse as envParse } from "envfile";
import * as fs from "fs";

export type LiquidityLayerEnv = {
  chainId: number;
  tokenAddress: string;
  tokenBridgeAddress: string;
  wormholeCctpAddress: string;
  canonicalTokenChain: number;
  canonicalTokenAddress: string;
  ownerAssistantAddress: string;
  orderRouterAddress: string;
  matchingEngineChain: number;
  matchingEngineEndpoint: string;
  curvePoolAddress?: string;
};

export function parseLiquidityLayerEnvFile(envPath: string): LiquidityLayerEnv {
  if (!fs.existsSync(envPath)) {
    throw new Error(`${envPath} non-existent`);
  }

  const raw = fs.readFileSync(envPath, "utf8");
  const contents = envParse(raw.replace(/export RELEASE_/g, ""));

  const keys = [
    "CHAIN_ID",
    "TOKEN_ADDRESS",
    "TOKEN_BRIDGE_ADDRESS",
    "WORMHOLE_CCTP_ADDRESS",
    "CANONICAL_TOKEN_CHAIN",
    "CANONICAL_TOKEN_ADDRESS",
    "OWNER_ASSISTANT_ADDRESS",
    "ORDER_ROUTER_ADDRESS",
    "MATCHING_ENGINE_CHAIN",
    "MATCHING_ENGINE_ENDPOINT",
  ];
  for (const key of keys) {
    if (!contents[key]) {
      throw new Error(`no ${key}`);
    }
  }

  return {
    chainId: parseInt(contents.CHAIN_ID),
    tokenAddress: contents.TOKEN_ADDRESS,
    tokenBridgeAddress: contents.TOKEN_BRIDGE_ADDRESS,
    wormholeCctpAddress: contents.WORMHOLE_CCTP_ADDRESS,
    canonicalTokenChain: parseInt(contents.CANONICAL_TOKEN_CHAIN),
    canonicalTokenAddress: contents.CANONICAL_TOKEN_ADDRESS,
    ownerAssistantAddress: contents.OWNER_ASSISTANT_ADDRESS,
    orderRouterAddress: contents.ORDER_ROUTER_ADDRESS,
    matchingEngineChain: parseInt(contents.MATCHING_ENGINE_CHAIN),
    matchingEngineEndpoint: contents.MATCHING_ENGINE_ENDPOINT,
    curvePoolAddress: contents.CURVE_POOL_ADDRESS,
  };
}
