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
} from "@certusone/wormhole-sdk";
import { TypedEvent } from "../src/types/common";
import { Implementation__factory } from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";
import { IMatchingEngine__factory } from "../src/types";
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
const MATCHING_ENGINE_CHAIN = Number(CONFIG.matchingEngineChain!);
const MATCHING_ENGINE = IMatchingEngine__factory.connect(
  CONFIG.matchingEngineAddress!,
  SIGNERS[MATCHING_ENGINE_CHAIN as ChainId]
);

const CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN: { [key in number]: SupportedChainId } = {
  0: CHAIN_ID_ETH,
  1: CHAIN_ID_AVAX,
};

const CIRCLE_EMITTER_ADDRESSES = {
  [CHAIN_ID_ETH]: "0x26413e8157CD32011E726065a5462e97dD4d03D9",
  [CHAIN_ID_AVAX]: "0xa9fB1b3009DCb79E2fe346c16a604B8Fa8aE0a79",
};

// This might not be the case on mainnet, but it's true on testnet.
const WORMHOLE_FEE = 0;

function wormholeContract(
  address: string,
  signer: ethers.Signer
): ethers.Contract {
  return Implementation__factory.connect(address, signer);
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
  for (const log of logs) {
    console.log(log.address, circleEmitterAddress);
    if (log.address === circleEmitterAddress) {
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

async function executeCCTPOrder(
  receipt: ethers.ContractReceipt,
  circleEmitterAddress: string,
  vaa: Uint8Array
) {
  try {
    const [circleBridgeMessage, circleAttestation] =
      await handleCircleMessageInLogs(receipt.logs!, circleEmitterAddress);

    // Verify params.
    if (circleBridgeMessage === null || circleAttestation === null) {
      throw new Error(
        `Error parsing receipt, txhash: ${receipt.transactionHash}`
      );
    }

    // redeem parameters for target function call
    const redeemParameters = {
      encodedWormholeMessage: `0x${uint8ArrayToHex(vaa)}`,
      circleBridgeMessage: circleBridgeMessage,
      circleAttestation: circleAttestation,
    };
    console.log("All redeem parameters have been located");

    const tx: ethers.ContractTransaction = await MATCHING_ENGINE[
      "executeOrder((bytes,bytes,bytes))"
    ](redeemParameters, {
      value: WORMHOLE_FEE,
    });
    const redeedReceipt: ethers.ContractReceipt = await tx.wait();

    console.log(
      `Redeemed transfer in txhash: ${redeedReceipt.transactionHash}`
    );
  } catch (e) {
    throw Error(`Failed to execute CCTP order: ${e}`);
  }
}

async function executeTokenBridgeOrder(vaa: Uint8Array) {
  try {
    const tx: ethers.ContractTransaction = await MATCHING_ENGINE[
      "executeOrder(bytes)"
    ](`0x${uint8ArrayToHex(vaa)}`, {
      value: WORMHOLE_FEE,
    });
    const redeedReceipt: ethers.ContractReceipt = await tx.wait();

    console.log(
      `Redeemed transfer in txhash: ${redeedReceipt.transactionHash}`
    );
  } catch (e) {
    throw Error(`Failed to execute token bridge order: ${e}`);
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

      // confirm that it's a payload3
      const payloadType = payloadArray.readUint8(0);

      // Parse the fromChain.
      let fromChain;
      let fromAddress;
      let isCCTP = false;

      if (payloadType == 1) {
        const fromDomain = payloadArray.readUInt32BE(65);
        if (!(fromDomain in CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN)) {
          console.warn(`Unknown fromDomain: ${fromDomain}`);
          return;
        }
        fromChain = CIRCLE_DOMAIN_TO_WORMHOLE_CHAIN[fromDomain];
        fromAddress = tryUint8ArrayToNative(
          payloadArray.subarray(81, 113),
          fromChain as ChainId
        );
        isCCTP = true;
      } else if (payloadType == 3) {
        fromChain = getBridgeChainId(_sender)!;
        fromAddress = tryUint8ArrayToNative(
          payloadArray.subarray(101, 133),
          fromChain as ChainId
        );
        if (fromChain === null) {
          console.warn(
            `Unable to fetch chainId from sender address: ${_sender}`
          );
          return;
        }
      } else {
        return;
      }

      console.log(`Relaying transaction: ${typedEvent.transactionHash}`);

      // Check that the fromAddress is a valid order router.
      if (
        ethers.utils.getAddress(fromAddress) !=
        ethers.utils.getAddress(ROUTES[fromChain.toString()].router)
      ) {
        console.warn("Not a registered order router.");
        return;
      }

      // Fetch the vaa.
      console.log(
        `Fetching Wormhole message from: ${_sender}, chainId: ${fromChain}`
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

      // Execute the order on the matching engine.
      if (isCCTP) {
        const receipt = await typedEvent.getTransactionReceipt();
        await executeCCTPOrder(
          receipt,
          CIRCLE_EMITTER_ADDRESSES[fromChain],
          vaaBytes
        );
      } else {
        await executeTokenBridgeOrder(vaaBytes);
      }
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
