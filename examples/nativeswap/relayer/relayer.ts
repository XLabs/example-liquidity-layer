import {
  CHAIN_ID_AVAX,
  CHAIN_ID_ETH,
  coalesceChainName,
  CHAIN_ID_BSC,
  CHAIN_ID_MOONBEAM,
  ChainId,
  getSignedVAAWithRetry,
  getEmitterAddressEth,
  tryUint8ArrayToNative,
  uint8ArrayToHex,
  parseVaa,
} from "@certusone/wormhole-sdk";
import { TypedEvent } from "./src/types/common";
import { INativeSwap__factory, ICircleIntegration__factory } from "./src/types";
import {
  Implementation__factory,
  ITokenBridge__factory,
} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";
import { ethers, Wallet } from "ethers";
import { WebSocketProvider } from "./websocket";
import { NodeHttpTransport } from "@improbable-eng/grpc-web-node-http-transport";
import * as fs from "fs";

import { AxiosResponse } from "axios";
const axios = require("axios"); // import breaks

const strip0x = (str: string) =>
  str.startsWith("0x") ? str.substring(2) : str;

// Shared EVM private key.
const ETH_KEY = process.env.ETH_KEY;
if (!ETH_KEY) {
  console.error("ETH_KEY is required!");
  process.exit(1);
}
const PK = new Uint8Array(Buffer.from(strip0x(ETH_KEY), "hex"));

function getRpc(rpcEvnVariable: any): WebSocketProvider {
  const rpc = rpcEvnVariable;
  if (!rpc || !rpc.startsWith("ws")) {
    console.error("RPC is required and must be a websocket!");
    process.exit(1);
  }
  const websocket = new WebSocketProvider(rpc);
  return websocket;
}

// Supported chains.
const SUPPORTED_CHAINS = [
  CHAIN_ID_ETH,
  CHAIN_ID_AVAX,
  CHAIN_ID_BSC,
  CHAIN_ID_MOONBEAM,
];
type SupportedChainId = (typeof SUPPORTED_CHAINS)[number];

// Signers.
const SIGNERS = {
  [CHAIN_ID_ETH]: new Wallet(PK, getRpc(process.env.ETH_RPC)),
  [CHAIN_ID_AVAX]: new Wallet(PK, getRpc(process.env.AVAX_RPC)),
  [CHAIN_ID_BSC]: new Wallet(PK, getRpc(process.env.BSC_RPC)),
  [CHAIN_ID_MOONBEAM]: new Wallet(PK, getRpc(process.env.MOONBEAM_RPC)),
};

// Testnet guardian host.
const TESTNET_GUARDIAN_RPC: string[] = [
  "https://wormhole-v2-testnet-api.certus.one",
];

// Read in config.
const configPath = `${__dirname}/cfg/relayer.json`;
const CONFIG = JSON.parse(fs.readFileSync(configPath, "utf8"));
const ROUTES = CONFIG.executionRoutes!;
const MATCHING_ENGINE_CHAIN: number = Number(CONFIG.matchingEngineChain!);
const MATCHING_ENGINE_ADDRESS = CONFIG.matchingEngineAddress!;

// Message response types.
const TYPE_FILL = 16;
const TYPE_REVERT = 32;

const CIRCLE_BURN_MESSAGE_TOPIC =
  "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036";

const CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN: { [key in number]: SupportedChainId } = {
  0: CHAIN_ID_ETH,
  1: CHAIN_ID_AVAX,
};

const CIRCLE_EMITTER_ADDRESSES = {
  [CHAIN_ID_ETH]: "0x26413e8157CD32011E726065a5462e97dD4d03D9",
  [CHAIN_ID_AVAX]: "0xa9fB1b3009DCb79E2fe346c16a604B8Fa8aE0a79",
};

const CIRCLE_INTEGRATION_PAYLOAD_LEN = 147;
const TOKEN_BRIDGE_PAYLOAD_LEN = 133;

function parseMessageType(payload: Buffer, isCCTP: boolean): number {
  if (isCCTP) {
    return payload.readUint8(CIRCLE_INTEGRATION_PAYLOAD_LEN);
  } else {
    return payload.readUint8(TOKEN_BRIDGE_PAYLOAD_LEN);
  }
}

function nativeSwapContract(chainId: SupportedChainId): ethers.Contract {
  return INativeSwap__factory.connect(
    ethers.utils.getAddress(ROUTES[chainId.toString()].nativeSwap),
    SIGNERS[chainId]
  );
}

function circleIntegrationContract(chainId: SupportedChainId): ethers.Contract {
  return ICircleIntegration__factory.connect(
    ethers.utils.getAddress(ROUTES[chainId.toString()].cctp),
    SIGNERS[chainId]
  );
}

function tokenBridgeContract(chainId: SupportedChainId): ethers.Contract {
  return ITokenBridge__factory.connect(
    ethers.utils.getAddress(ROUTES[chainId.toString()].bridge),
    SIGNERS[chainId]
  );
}

function wormholeContract(
  address: string,
  signer: ethers.Signer
): ethers.Contract {
  return Implementation__factory.connect(address, signer);
}

function isValidSender(
  fromChain: SupportedChainId,
  fromAddress: string
): boolean {
  // Check that the fromAddress is a valid order router.
  const validFromAddress = ethers.utils.getAddress(fromAddress);
  if (
    fromChain === MATCHING_ENGINE_CHAIN &&
    validFromAddress == ethers.utils.getAddress(MATCHING_ENGINE_ADDRESS)
  ) {
    return true;
  } else if (
    validFromAddress ==
    ethers.utils.getAddress(ROUTES[fromChain.toString()].router)
  ) {
    return true;
  } else {
    return false;
  }
}

function getBridgeChainId(sender: string): ChainId | null {
  let senderChainId: ChainId | null = null;
  const config = CONFIG.executionRoutes;
  for (const chainIdString of Object.keys(config)) {
    const bridgeAddress = ethers.utils.getAddress(sender);
    const configBridgeAddress = ethers.utils.getAddress(
      config[chainIdString].bridge
    );

    if (configBridgeAddress == bridgeAddress) {
      senderChainId = Number(chainIdString) as ChainId;
    }
  }

  return senderChainId;
}

function findCircleMessageInLogs(
  logs: ethers.providers.Log[],
  circleEmitterAddress: string
): string | null {
  if (logs.length === 0) {
    throw new Error("No logs found");
  }

  for (const log of logs) {
    if (
      log.address === circleEmitterAddress &&
      log.topics[0] === CIRCLE_BURN_MESSAGE_TOPIC
    ) {
      const messageSentIface = new ethers.utils.Interface([
        "event MessageSent(bytes message)",
      ]);
      return messageSentIface.parseLog(log).args.message as string;
    }
  }

  return null;
}

async function sleep(timeout: number) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

async function getCircleAttestation(
  messageHash: ethers.BytesLike,
  timeout: number = 2000
) {
  while (true) {
    // get the post
    const response = await axios
      .get(`https://iris-api-sandbox.circle.com/attestations/${messageHash}`)
      .catch(() => {
        return null;
      })
      .then(async (response: AxiosResponse | null) => {
        if (
          response !== null &&
          response.status === 200 &&
          response.data.status === "complete"
        ) {
          return response.data.attestation as string;
        }

        return null;
      });

    if (response !== null) {
      return response;
    }

    await sleep(timeout);
  }
}

async function handleCircleMessageInLogs(
  logs: ethers.providers.Log[],
  circleEmitterAddress: string
): Promise<[string | null, string | null]> {
  const circleMessage = findCircleMessageInLogs(logs, circleEmitterAddress);
  if (circleMessage === null) {
    return [null, null];
  }

  const circleMessageHash = ethers.utils.keccak256(circleMessage);
  const signature = await getCircleAttestation(circleMessageHash);

  return [circleMessage, signature];
}

async function getRedeemParameters(
  receipt: ethers.ContractReceipt,
  circleEmitterAddress: string,
  vaa: Uint8Array
) {
  const [circleBridgeMessage, circleAttestation] =
    await handleCircleMessageInLogs(receipt.logs!, circleEmitterAddress);

  // Verify params.
  if (circleBridgeMessage === null || circleAttestation === null) {
    throw new Error(
      `Error parsing receipt, txhash: ${receipt.transactionHash}`
    );
  }

  // redeem parameters for target function call
  return {
    encodedWormholeMessage: `0x${uint8ArrayToHex(vaa)}`,
    circleBridgeMessage: circleBridgeMessage,
    circleAttestation: circleAttestation,
  };
}

interface OrderResponse {
  encodedWormholeMessage: string;
  circleBridgeMessage: string;
  circleAttestation: string;
}

async function getOrderResponseFromVaa(
  vaa: Uint8Array,
  fromChain: number,
  isCCTP: boolean,
  receipt: ethers.ContractReceipt
): Promise<OrderResponse> {
  let response: OrderResponse = {} as any;

  // Execute the order on the matching engine.
  if (isCCTP) {
    const redeemParams = await getRedeemParameters(
      receipt,
      CIRCLE_EMITTER_ADDRESSES[fromChain],
      vaa
    );
    response = {
      circleAttestation: redeemParams.circleAttestation,
      circleBridgeMessage: redeemParams.circleBridgeMessage,
      encodedWormholeMessage: redeemParams.encodedWormholeMessage,
    };
  } else {
    response = {
      circleAttestation: "0x",
      circleBridgeMessage: "0x",
      encodedWormholeMessage: `0x${uint8ArrayToHex(vaa)}`,
    };
  }

  return response;
}

async function isTransferRedeemed(
  chainId: SupportedChainId,
  isCCTP: boolean,
  vaaHash: string
): Promise<boolean> {
  if (isCCTP) {
    return await circleIntegrationContract(chainId).isMessageConsumed(vaaHash);
  } else {
    return await tokenBridgeContract(chainId).isTransferCompleted(vaaHash);
  }
}

async function handleOrderResponse(
  response: OrderResponse,
  toChain: SupportedChainId,
  responseType: number
) {
  try {
    console.log(`Posting order response to chain: ${toChain}`);
    const nativeSwap = nativeSwapContract(toChain);

    let redeemReceipt: ethers.ContractReceipt;
    if (responseType == TYPE_FILL) {
      const tx: ethers.ContractTransaction =
        await nativeSwap.recvAndSwapExactNativeIn(response);
      redeemReceipt = await tx.wait();
    } else if (responseType == TYPE_REVERT) {
      const tx: ethers.ContractTransaction = await nativeSwap.handleOrderRevert(
        response
      );
      redeemReceipt = await tx.wait();
    } else {
      return;
    }

    console.log(
      `Posted order response in txhash: ${redeemReceipt.transactionHash}`
    );
  } catch (e) {
    throw new Error(`Error executing order: ${e}`);
  }
}

function handleRelayerEvent(
  _sender: string,
  sequence: ethers.BigNumber,
  _nonce: number,
  payload: string,
  _consistencyLevel: number,
  typedEvent: TypedEvent<
    [string, ethers.BigNumber, number, string, number] & {
      sender: string;
      sequence: ethers.BigNumber;
      nonce: number;
      payload: string;
      consistencyLevel: number;
    }
  >
) {
  (async () => {
    try {
      // create payload buffer
      const payloadArray = Buffer.from(ethers.utils.arrayify(payload));
      const payloadType = payloadArray.readUint8(0);

      // Parse the fromChain.
      let fromChain: SupportedChainId;
      let toChain: SupportedChainId;
      let fromAddress;
      let isCCTP = false;

      // Only parse necessary fields for now to avoid unnecessary RPC calls.
      if (payloadType == 1) {
        const fromDomain = payloadArray.readUInt32BE(65);
        if (!(fromDomain in CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN)) {
          console.warn(`Unknown fromDomain: ${fromDomain}`);
          return;
        }

        const toDomain = payloadArray.readUInt32BE(69);
        if (!(toDomain in CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN)) {
          console.warn(`Unknown toDomain: ${toDomain}`);
          return;
        }

        fromChain = CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN[fromDomain];
        toChain = CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN[toDomain];
        fromAddress = tryUint8ArrayToNative(
          payloadArray.subarray(81, 113),
          fromChain as ChainId
        );
        isCCTP = true;
      } else if (payloadType == 3) {
        fromChain = getBridgeChainId(_sender)! as SupportedChainId;
        toChain = payloadArray.readUInt16BE(99) as SupportedChainId;
        fromAddress = tryUint8ArrayToNative(
          payloadArray.subarray(101, 133),
          fromChain as ChainId
        );
        if (fromChain === null || toChain === null) {
          console.warn(
            `Unable to fetch chainId from sender address: ${_sender}`
          );
          return;
        }
      } else {
        return;
      }

      // Check if valid sender.
      if (!isValidSender(fromChain, fromAddress)) {
        return;
      }

      // Ignore market orders.
      const responseType = parseMessageType(payloadArray, isCCTP);
      if (responseType != TYPE_FILL && responseType != TYPE_REVERT) {
        return;
      }

      // Fetch the vaa.
      console.log(
        `Relaying transaction: ${typedEvent.transactionHash}, from: ${_sender}, chainId: ${fromChain}`
      );
      const { vaaBytes } = await getSignedVAAWithRetry(
        TESTNET_GUARDIAN_RPC,
        fromChain as ChainId,
        getEmitterAddressEth(_sender),
        sequence.toString(),
        {
          transport: NodeHttpTransport(),
        }
      );

      // Check if the order is already executed.
      const isRedeemed = await isTransferRedeemed(
        toChain,
        isCCTP,
        "0x" + parseVaa(vaaBytes).hash.toString("hex")
      );
      if (isRedeemed) {
        console.log(
          `Order already executed, txhash: ${typedEvent.transactionHash}`
        );
        return;
      }

      // Fetch OrderResponse parameters.
      const receipt = await typedEvent.getTransactionReceipt();
      const orderResponse = await getOrderResponseFromVaa(
        vaaBytes,
        fromChain,
        isCCTP,
        receipt
      );

      // Execute the order on the target nativeswap contract.
      await handleOrderResponse(orderResponse, toChain, responseType);
    } catch (e) {
      console.error(e);
    }
  })();
}

function subscribeToEvents(
  wormhole: ethers.Contract,
  chainId: SupportedChainId
) {
  const chainName = coalesceChainName(chainId);
  const bridgeSender = ROUTES[chainId.toString()].bridge;
  const cctpSender = ROUTES[chainId.toString()].cctp;
  if (!wormhole.address) {
    console.error("No known core contract for chain", chainName);
    process.exit(1);
  }

  // unsubscribe and resubscribe to reset websocket connection
  wormhole.on(
    wormhole.filters.LogMessagePublished(ethers.utils.getAddress(bridgeSender)),
    handleRelayerEvent
  );
  console.log(
    `Subscribed to: ${chainName}, core contract: ${wormhole.address}, sender: ${bridgeSender}`
  );

  // subscribe to cctp events if a contract is specified
  if (cctpSender.length == 42) {
    wormhole.on(
      wormhole.filters.LogMessagePublished(ethers.utils.getAddress(cctpSender)),
      handleRelayerEvent
    );
    console.log(
      `Subscribed to: ${chainName}, core contract: ${wormhole.address}, sender: ${cctpSender}`
    );
  }
}

async function main() {
  // resubscribe to contract events every 5 minutes
  for (const chainId of SUPPORTED_CHAINS) {
    try {
      subscribeToEvents(
        wormholeContract(ROUTES[chainId.toString()].wormhole, SIGNERS[chainId]),
        chainId
      );
    } catch (e: any) {
      console.log(e);
    }
  }
}

// start the process
main();
