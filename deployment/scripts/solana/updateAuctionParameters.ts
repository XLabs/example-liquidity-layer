import {
  AccountInfo,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
} from "@solana/web3.js";
import "dotenv/config";
import { uint64ToBN } from "@wormhole-foundation/example-liquidity-layer-solana/common";
import { AuctionParameters, MatchingEngineProgram } from "@wormhole-foundation/example-liquidity-layer-solana/matchingEngine";
import { solana, LoggerFn, getChainConfig, getContractAddress, getLocalDependencyAddress, getMatchingEngineAuctionParameters as getAuctionEngineParameters, env, getMatchingEngineAuctionParameters } from "../../helpers";
import { MatchingEngineConfiguration } from "../../config/config-types";
import { ProgramId } from "@wormhole-foundation/example-liquidity-layer-solana/matchingEngine";
import { SolanaLedgerSigner } from "@xlabs-xyz/ledger-signer-solana";
import { circle } from "@wormhole-foundation/sdk-base";

solana.runOnSolana("update-auction-parameters", async (chain, signer, log) => {
  const config = await getChainConfig<MatchingEngineConfiguration>("matching-engine", chain.chainId);
  const matchingEngineId = getLocalDependencyAddress("matchingEngineProxy", chain) as ProgramId;

  const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  const canonicalEnv = capitalize(env);

  if (canonicalEnv !== "Mainnet" && canonicalEnv !== "Testnet") {
    throw new Error(`Unsupported environment: ${env}  must be Mainnet or Testnet`);
  }

  const usdcMint = new PublicKey(circle.usdcContract(canonicalEnv, "Solana"));
  const connection = new Connection(chain.rpc, solana.connectionCommitmentLevel);
  const matchingEngine = new MatchingEngineProgram(connection, matchingEngineId, usdcMint);

  log('Matching Engine Program ID:', matchingEngineId.toString());
  log('Current Matching Engine Auction parameters:', await matchingEngine.fetchAuctionParameters());
  log('\nTo-be-updated Matching Engine Auction parameters:', getMatchingEngineAuctionParameters(chain));

  log('Proposing new Matching Engine Auction parameters...')

  const priorityFee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: solana.priorityMicrolamports });
  const ownerOrAssistant = new PublicKey(await signer.getAddress());
  const custodian = matchingEngine.custodianAddress();

  const exists = await connection.getAccountInfo(custodian).then((acct: null | AccountInfo<Buffer>) => acct != null);
  if (exists) {
    log("Notice: proposal account already initialized");
  }
  else {

    const proposeInstructions = [];
    const proposeIx = await matchingEngine.proposeAuctionParametersIx({
      ownerOrAssistant,
    }, getMatchingEngineAuctionParameters(chain));

    proposeInstructions.push(proposeIx, priorityFee);
    const proposeTxSig = await solana.ledgerSignAndSend(connection, proposeInstructions, []);

    console.log(`Propose Transaction ID: ${proposeTxSig}, wait for confirmation...`);

    await connection.confirmTransaction(proposeTxSig, 'confirmed');
  }

  const updateInstructions = [];
  const updateIx = await matchingEngine.updateAuctionParametersIx({
    owner: ownerOrAssistant,
  });
  updateInstructions.push(updateIx, priorityFee);
  const updateTxSig = await solana.ledgerSignAndSend(connection, updateInstructions, []);

  await connection.confirmTransaction(updateTxSig, 'confirmed');

  console.log(`Update Transaction ID: ${updateTxSig}, wait for confirmation...`);
});

function toIntegerNumber(text: string, name: string): number {
  const res = Number(text);
  if (!Number.isSafeInteger(res)) {
    throw new Error(`${name} is not a safe integer. Received ${text}`)
  }
  return res;
}