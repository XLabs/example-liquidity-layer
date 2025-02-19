export * from "./state";

import { BN, Program, utils } from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import {
    ConfirmOptions,
    Connection,
    Finality,
    ParsedTransactionWithMeta,
    PublicKey,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_EPOCH_SCHEDULE_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    Signer,
    SlotInfo,
    SystemProgram,
    TransactionInstruction,
} from "@solana/web3.js";
import { ChainId, isChainId, toChainId } from "@wormhole-foundation/sdk-base";
import { PreparedTransaction, PreparedTransactionOptions } from "..";
import { MessageTransmitterProgram, TokenMessengerMinterProgram } from "../cctp";
import {
    LiquidityLayerMessage,
    Uint64,
    VaaHash,
    cctpMessageAddress,
    coreMessageAddress,
    reclaimCctpMessageIx,
    uint64ToBN,
    uint64ToBigInt,
    writeUint64BE,
} from "../common";
import IDL from "../idl/json/matching_engine.json";
import { MatchingEngine } from "../idl/ts/matching_engine";
import { UpgradeManagerProgram } from "../upgradeManager";
import { ArrayQueue, BPF_LOADER_UPGRADEABLE_PROGRAM_ID, programDataAddress } from "../utils";
import { VaaAccount } from "../wormhole";
import {
    Auction,
    AuctionConfig,
    AuctionEntry,
    AuctionHistory,
    AuctionHistoryHeader,
    AuctionInfo,
    AuctionParameters,
    Custodian,
    EndpointInfo,
    FastFill,
    FastFillInfo,
    FastFillSeeds,
    FastFillSequencer,
    MessageProtocol,
    PreparedOrderResponse,
    Proposal,
    ProposalAction,
    ReservedFastFillSequence,
    RouterEndpoint,
} from "./state";

export const PROGRAM_IDS = [
    "MatchingEngine11111111111111111111111111111",
    "mPydpGUWxzERTNpyvTKdvS7v8kvw5sgwfiP8WQFrXVS",
    "HtkeCDdYY4i9ncAxXKjYTx8Uu3WM8JbtiLRYjtHwaVXb",
] as const;

export const FEE_PRECISION_MAX = 1_000_000n;

export const CPI_EVENT_IX_SELECTOR = Uint8Array.from([228, 69, 165, 46, 81, 203, 154, 29]);

export type ProgramId = (typeof PROGRAM_IDS)[number];

export type AddCctpRouterEndpointArgs = {
    chain: ChainId;
    cctpDomain: number;
    address: Array<number>;
    mintRecipient: Array<number> | null;
};

export type WormholeCoreBridgeAccounts = {
    coreBridgeConfig: PublicKey;
    coreEmitterSequence: PublicKey;
    coreFeeCollector: PublicKey;
    coreBridgeProgram: PublicKey;
};

export type PublishMessageAccounts = WormholeCoreBridgeAccounts & {
    custodian: PublicKey;
    coreMessage: PublicKey;
};

export type MatchingEngineCommonAccounts = WormholeCoreBridgeAccounts & {
    matchingEngineProgram: PublicKey;
    systemProgram: PublicKey;
    rent: PublicKey;
    clock: PublicKey;
    custodian: PublicKey;
    cctpMintRecipient: PublicKey;
    tokenMessenger: PublicKey;
    tokenMinter: PublicKey;
    tokenMessengerMinterSenderAuthority: PublicKey;
    tokenMessengerMinterProgram: PublicKey;
    messageTransmitterAuthority: PublicKey;
    messageTransmitterConfig: PublicKey;
    messageTransmitterProgram: PublicKey;
    tokenProgram: PublicKey;
    mint: PublicKey;
    localToken: PublicKey;
    tokenMessengerMinterCustodyToken: PublicKey;
};

export type BurnAndPublishAccounts = {
    custodian: PublicKey;
    routerEndpoint: PublicKey;
    coreMessage: PublicKey;
    cctpMessage: PublicKey;
    coreBridgeConfig: PublicKey;
    coreEmitterSequence: PublicKey;
    coreFeeCollector: PublicKey;
    coreBridgeProgram: PublicKey;
    tokenMessengerMinterSenderAuthority: PublicKey;
    messageTransmitterConfig: PublicKey;
    tokenMessenger: PublicKey;
    remoteTokenMessenger: PublicKey;
    tokenMinter: PublicKey;
    localToken: PublicKey;
    tokenMessengerMinterEventAuthority: PublicKey;
    messageTransmitterProgram: PublicKey;
    tokenMessengerMinterProgram: PublicKey;
};

export type RedeemFastFillAccounts = {
    custodian: PublicKey;
    fromRouterEndpoint: PublicKey;
    toRouterEndpoint: PublicKey;
    localCustodyToken: PublicKey;
    eventAuthority: PublicKey;
    matchingEngineProgram: PublicKey;
};

export type CctpMessageArgs = {
    encodedCctpMessage: Buffer;
    cctpAttestation: Buffer;
};

export type SettledTokenAccountInfo = {
    key: PublicKey;
    balanceAfter: BN;
};

export type AuctionSettled = {
    fastVaaHash: Array<number>;
    bestOfferToken: SettledTokenAccountInfo | null;
    baseFeeToken: SettledTokenAccountInfo | null;
    withExecute: MessageProtocol | null;
};

export type AuctionUpdated = {
    configId: number;
    fastVaaHash: Array<number>;
    vaa: PublicKey | null;
    sourceChain: number;
    targetProtocol: MessageProtocol;
    redeemerMessageLen: number;
    endSlot: BN;
    bestOfferToken: PublicKey;
    tokenBalanceBefore: BN;
    amountIn: BN;
    totalDeposit: BN;
    maxOfferPriceAllowed: BN | null;
};

export type OrderExecuted = {
    fastVaaHash: Array<number>;
    vaa: PublicKey;
    targetProtocol: MessageProtocol;
};

export type Proposed = {
    action: ProposalAction;
};

export type Enacted = {
    action: ProposalAction;
};

export type LocalFastOrderFilled = {
    seeds: FastFillSeeds;
    info: FastFillInfo;
    auction: PublicKey | null;
};

export type FastFillSequenceReserved = {
    fastVaaHash: Array<number>;
    fastFill: FastFillSeeds;
};

export type FastFillRedeemed = {
    preparedBy: PublicKey;
    fastFill: FastFillSeeds;
};

export type AuctionClosed = {
    auction: Auction;
};

export type MatchingEngineEvent = {
    auctionSettled?: AuctionSettled;
    auctionUpdated?: AuctionUpdated;
    orderExecuted?: OrderExecuted;
    proposed?: Proposed;
    enacted?: Enacted;
    localFastOrderFilled?: LocalFastOrderFilled;
    fastFillSequenceReserved?: FastFillSequenceReserved;
    fastFillRedeemed?: FastFillRedeemed;
    auctionClosed?: AuctionClosed;
};

export type FastOrderPathComposite = {
    fastVaa: {
        vaa: PublicKey;
    };
    path: {
        fromEndpoint: {
            endpoint: PublicKey;
        };
        toEndpoint: { endpoint: PublicKey };
    };
};

export type ReserveFastFillSequenceCompositeOpts = {
    fastVaaHash?: VaaHash;
    sourceChain?: ChainId;
    orderSender?: Array<number>;
    targetChain?: ChainId;
};

export class MatchingEngineProgram {
    private _programId: ProgramId;
    private _mint: PublicKey;

    program: Program<MatchingEngine>;

    constructor(connection: Connection, programId: ProgramId, mint: PublicKey) {
        this._programId = programId;
        this._mint = mint;
        this.program = new Program(
            { ...(IDL as any), address: this._programId },
            {
                connection,
            },
        );
    }

    get ID(): PublicKey {
        return this.program.programId;
    }

    get mint(): PublicKey {
        return this._mint;
    }

    /// NOTE: This listener can be unreliable because it depends on parsing program logs. For a more
    /// reliable method, use `onEventCpi` and filter for the "auctionUpdated" event.
    onAuctionUpdated(callback: (event: AuctionUpdated, slot: number, signature: string) => void) {
        return this.program.addEventListener("auctionUpdated", callback);
    }

    /// NOTE: This function is not optimized to minimize RPC calls.
    onEventCpi(
        callback: (
            event: MatchingEngineEvent,
            eventSlot: number,
            signature: string,
            currentSlotInfo?: SlotInfo,
            parsedTransaction?: ParsedTransactionWithMeta,
        ) => void,
        commitment: Finality = "confirmed",
    ): number {
        const program = this.program;
        const connection = program.provider.connection;

        const unprocessedTxs = new ArrayQueue<{ signature: string; eventSlot: number }>();
        const observedTxs = new Map<number, Set<string>>();

        connection.onSlotChange(async (slotInfo) => {
            // TODO: Make this more efficient by fetching multiple parsed transactions.
            while (!unprocessedTxs.isEmpty()) {
                const head = unprocessedTxs.head();

                // This check is superfluous. But we do it anyway to make sure the unprocessed
                // transaction queue is actually empty.
                //
                // Once the ArrayQueue has been thoroughly tested, we can remove this check.
                if (head === null) {
                    break;
                }

                const { signature, eventSlot } = head;

                const parsedTx = await connection.getParsedTransaction(signature, {
                    commitment,
                    maxSupportedTransactionVersion: 0,
                });

                if (parsedTx === null) {
                    break;
                }

                unprocessedTxs.dequeue();

                // Find the event.
                for (const innerIx of parsedTx.meta?.innerInstructions!) {
                    for (const ix of innerIx.instructions) {
                        if (!ix.programId.equals(this.ID) || !("data" in ix)) {
                            continue;
                        }

                        const data = utils.bytes.bs58.decode(ix.data);
                        if (!data.subarray(0, 8).equals(CPI_EVENT_IX_SELECTOR)) {
                            continue;
                        }

                        const decoded = program.coder.events.decode(
                            utils.bytes.base64.encode(data.subarray(8)),
                        );

                        if (decoded !== null) {
                            callback(
                                {
                                    [decoded.name]: decoded.data,
                                },
                                eventSlot,
                                signature,
                                slotInfo,
                                parsedTx,
                            );
                        }
                    }
                }
            }

            // Clean up consumed.
            for (const [slot] of observedTxs) {
                if (slot < slotInfo.slot - 64) {
                    observedTxs.delete(slot);
                }
            }
        });

        return connection.onLogs(program.programId, (logs, ctx) => {
            const signature = logs.signature;
            const eventSlot = ctx.slot;

            if (!observedTxs.has(eventSlot)) {
                observedTxs.set(eventSlot, new Set());
            }

            const observed = observedTxs.get(eventSlot)!;
            if (observed.has(signature)) {
                return;
            }

            unprocessedTxs.enqueue({ signature, eventSlot });
            observed.add(signature);
        });
    }

    eventAuthorityAddress(): PublicKey {
        return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], this.ID)[0];
    }

    custodianAddress(): PublicKey {
        return Custodian.address(this.ID);
    }

    async fetchCustodian(input?: { address: PublicKey }): Promise<Custodian> {
        const addr = input === undefined ? this.custodianAddress() : input.address;
        return this.program.account.custodian.fetch(addr);
    }

    auctionConfigAddress(id: number): PublicKey {
        return AuctionConfig.address(this.ID, id);
    }

    async fetchAuctionConfig(input: number | { address: PublicKey }): Promise<AuctionConfig> {
        const addr = typeof input === "number" ? this.auctionConfigAddress(input) : input.address;
        return this.program.account.auctionConfig.fetch(addr);
    }

    async fetchAuctionParameters(id?: number): Promise<AuctionParameters> {
        if (id === undefined) {
            const { auctionConfigId } = await this.fetchCustodian();
            id = auctionConfigId;
        }
        return this.fetchAuctionConfig(id).then((config) => config.parameters);
    }

    cctpMintRecipientAddress(): PublicKey {
        return splToken.getAssociatedTokenAddressSync(this.mint, this.custodianAddress(), true);
    }

    routerEndpointAddress(chain: ChainId): PublicKey {
        return RouterEndpoint.address(this.ID, chain);
    }

    async fetchRouterEndpoint(input: ChainId | { address: PublicKey }): Promise<RouterEndpoint> {
        const addr =
            typeof input == "object" && "address" in input
                ? input.address
                : this.routerEndpointAddress(input);
        return this.program.account.routerEndpoint.fetch(addr);
    }

    async fetchRouterEndpointInfo(input: ChainId | { address: PublicKey }): Promise<EndpointInfo> {
        const { info } = await this.fetchRouterEndpoint(input);
        return info;
    }

    auctionAddress(vaaHash: VaaHash): PublicKey {
        return Auction.address(this.ID, vaaHash);
    }

    async fetchAuction(input: VaaHash | { address: PublicKey }): Promise<Auction> {
        const addr = "address" in input ? input.address : this.auctionAddress(input);
        // @ts-ignore This is BS. This is correct.
        return this.program.account.auction.fetch(addr);
    }

    async proposalAddress(proposalId?: Uint64): Promise<PublicKey> {
        if (proposalId === undefined) {
            const { nextProposalId } = await this.fetchCustodian();
            proposalId = nextProposalId;
        }

        return Proposal.address(this.ID, proposalId);
    }

    async fetchProposal(input?: { address: PublicKey }): Promise<Proposal> {
        const addr = input === undefined ? await this.proposalAddress() : input.address;
        // @ts-ignore This is BS. This is correct.
        return this.program.account.proposal.fetch(addr);
    }

    coreMessageAddress(auction: PublicKey): PublicKey {
        return coreMessageAddress(this.ID, auction);
    }

    cctpMessageAddress(auction: PublicKey): PublicKey {
        return cctpMessageAddress(this.ID, auction);
    }

    async reclaimCctpMessageIx(
        accounts: {
            payer: PublicKey;
            cctpMessage: PublicKey;
        },
        cctpAttestation: Buffer,
    ): Promise<TransactionInstruction> {
        return reclaimCctpMessageIx(this.messageTransmitterProgram(), accounts, cctpAttestation);
    }

    preparedOrderResponseAddress(fastVaaHash: VaaHash): PublicKey {
        return PreparedOrderResponse.address(this.ID, fastVaaHash);
    }

    async fetchPreparedOrderResponse(
        input: VaaHash | { address: PublicKey },
    ): Promise<PreparedOrderResponse> {
        const addr = "address" in input ? input.address : this.preparedOrderResponseAddress(input);
        return this.program.account.preparedOrderResponse.fetch(addr);
    }

    preparedCustodyTokenAddress(preparedOrderResponse: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("prepared-custody"), preparedOrderResponse.toBuffer()],
            this.ID,
        )[0];
    }

    auctionCustodyTokenAddress(auction: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("auction-custody"), auction.toBuffer()],
            this.ID,
        )[0];
    }

    async fetchAuctionCustodyTokenBalance(auction: PublicKey): Promise<bigint> {
        return splToken
            .getAccount(this.program.provider.connection, this.auctionCustodyTokenAddress(auction))
            .then((token) => token.amount)
            .catch((_) => 0n);
    }

    localCustodyTokenAddress(sourceChain: ChainId): PublicKey {
        const encodedSourceChain = Buffer.alloc(2);
        encodedSourceChain.writeUInt16BE(sourceChain);

        return PublicKey.findProgramAddressSync(
            [Buffer.from("local-custody"), encodedSourceChain],
            this.ID,
        )[0];
    }

    async fetchLocalCustodyTokenBalance(sourceChain: ChainId): Promise<bigint> {
        return splToken
            .getAccount(
                this.program.provider.connection,
                this.localCustodyTokenAddress(sourceChain),
            )
            .then((token) => token.amount)
            .catch((_) => 0n);
    }

    fastFillAddress(sourceChain: ChainId, orderSender: Array<number>, sequence: Uint64): PublicKey {
        return FastFill.address(this.ID, sourceChain, orderSender, sequence);
    }

    fetchFastFill(
        input: [ChainId, Array<number>, Uint64] | { address: PublicKey },
    ): Promise<FastFill> {
        const addr = "address" in input ? input.address : this.fastFillAddress(...input);
        return this.program.account.fastFill.fetch(addr);
    }

    fastFillSequencerAddress(sourceChain: ChainId, sender: Array<number>): PublicKey {
        return FastFillSequencer.address(this.ID, sourceChain, sender);
    }

    fetchFastFillSequencer(
        input: [ChainId, Array<number>] | { address: PublicKey },
    ): Promise<FastFillSequencer> {
        const addr = "address" in input ? input.address : this.fastFillSequencerAddress(...input);
        return this.program.account.fastFillSequencer.fetch(addr);
    }

    reservedFastFillSequenceAddress(fastVaaHash: VaaHash): PublicKey {
        return ReservedFastFillSequence.address(this.ID, fastVaaHash);
    }

    fetchReservedFastFillSequence(
        input: VaaHash | { address: PublicKey },
    ): Promise<ReservedFastFillSequence> {
        const addr =
            "address" in input ? input.address : this.reservedFastFillSequenceAddress(input);
        return this.program.account.reservedFastFillSequence.fetch(addr);
    }

    transferAuthorityAddress(auction: PublicKey, offerPrice: Uint64): PublicKey {
        const encodedOfferPrice = Buffer.alloc(8);
        writeUint64BE(encodedOfferPrice, offerPrice);
        return PublicKey.findProgramAddressSync(
            [Buffer.from("transfer-authority"), auction.toBuffer(), encodedOfferPrice],
            this.ID,
        )[0];
    }

    auctionHistoryAddress(id: Uint64): PublicKey {
        return AuctionHistory.address(this.ID, id);
    }

    // Anchor is having trouble deserializing the account data here. Manually deserializing
    // the auction history is a workaround, and necessary after changing the redeemer message
    // length from a u32 to a u16.
    async fetchAuctionHistory(input: Uint64 | { address: PublicKey }): Promise<AuctionHistory> {
        const addr =
            typeof input === "bigint" || typeof input === "number" || input instanceof BN
                ? this.auctionHistoryAddress(input)
                : input.address;

        const accInfo = await this.program.provider.connection.getAccountInfo(addr);
        if (accInfo === null) {
            throw new Error("Auction history not found");
        }

        const { data } = accInfo;

        let offset = 0;
        const disc = data.subarray(offset, (offset += 8));
        if (!disc.equals(Uint8Array.from([149, 208, 45, 154, 47, 248, 102, 245]))) {
            throw new Error("Invalid account history discriminator");
        }

        const id = uint64ToBN(data.readBigUInt64LE(offset));
        offset += 8;
        const minTimestamp = data[offset++] === 1 ? data.readUInt32LE(offset) : null;
        offset += 4;
        const maxTimestamp = data[offset++] === 1 ? data.readUInt32LE(offset) : null;
        offset += 4;
        const numEntries = data.readUInt32LE(offset);
        offset += 4;

        const entries = [] as AuctionEntry[];
        for (let i = 0; i < numEntries; ++i) {
            const vaaHash = Array.from(data.subarray(offset, (offset += 32)));
            const vaaTimestamp = data.readUInt32LE(offset);
            offset += 4;

            const configId = data.readUInt32LE(offset);
            offset += 4;
            const custodyTokenBump = data.readUInt8(offset);
            offset += 1;
            const vaaSequence = uint64ToBN(data.readBigUInt64LE(offset));
            offset += 8;
            const sourceChain = data.readUInt16LE(offset);
            offset += 2;
            const bestOfferToken = new PublicKey(data.subarray(offset, (offset += 32)));
            const initialOfferToken = new PublicKey(data.subarray(offset, (offset += 32)));
            const startSlot = uint64ToBN(data.readBigUInt64LE(offset));
            offset += 8;
            const amountIn = uint64ToBN(data.readBigUInt64LE(offset));
            offset += 8;
            const securityDeposit = uint64ToBN(data.readBigUInt64LE(offset));
            offset += 8;
            const offerPrice = uint64ToBN(data.readBigUInt64LE(offset));
            offset += 8;
            const redeemerMessageLen = data.readUInt16LE(offset);
            offset += 2;
            const destinationAssetInfo =
                data[offset++] === 1
                    ? {
                          custodyTokenBump: data.readUInt8(offset),
                          amountOut: uint64ToBN(data.readBigUInt64LE(offset)),
                      }
                    : null;

            const entry = {
                vaaHash,
                vaaTimestamp,
                info: {
                    configId,
                    custodyTokenBump,
                    vaaSequence,
                    sourceChain,
                    bestOfferToken,
                    initialOfferToken,
                    startSlot,
                    amountIn,
                    securityDeposit,
                    offerPrice,
                    redeemerMessageLen,
                    destinationAssetInfo,
                },
            } as AuctionEntry;
            entries.push(entry);
        }

        return {
            header: { id, minTimestamp, maxTimestamp },
            data: entries,
        };
    }

    async fetchAuctionHistoryHeader(
        input: Uint64 | { address: PublicKey },
    ): Promise<[AuctionHistoryHeader, number]> {
        const addr =
            typeof input === "bigint" || typeof input === "number" || input instanceof BN
                ? this.auctionHistoryAddress(input)
                : input.address;
        const accInfo = await this.program.provider.connection.getAccountInfo(addr, {
            dataSlice: { offset: 0, length: 30 },
        });
        if (accInfo === null) {
            throw new Error("Auction history not found");
        }

        const { data } = accInfo;

        // Validate discriminator.
        let offset = 0;
        const disc = data.subarray(offset, (offset += 8));
        if (!disc.equals(Uint8Array.from([149, 208, 45, 154, 47, 248, 102, 245]))) {
            throw new Error("Invalid account history discriminator");
        }

        const id = uint64ToBN(data.readBigUInt64LE(offset));
        offset += 8;
        const hasMinTimestamp = data[offset++] === 1;
        const minTimestamp = hasMinTimestamp ? data.readUInt32LE(offset) : null;
        offset += 4;
        const hasMaxTimestamp = data[offset++] === 1;
        const maxTimestamp = hasMaxTimestamp ? data.readUInt32LE(offset) : null;
        offset += 4;
        const numEntries = data.readUInt32LE(offset);
        return [{ id, minTimestamp, maxTimestamp }, numEntries];
    }

    async approveTransferAuthorityIx(
        accounts: {
            auction: PublicKey;
            owner: PublicKey;
        },
        amounts: {
            offerPrice: Uint64;
            totalDeposit: Uint64;
        },
    ): Promise<{ transferAuthority: PublicKey; ix: TransactionInstruction }> {
        const { auction, owner } = accounts;
        const { offerPrice, totalDeposit } = amounts;

        const transferAuthority = this.transferAuthorityAddress(auction, offerPrice);

        return {
            transferAuthority,
            ix: splToken.createApproveInstruction(
                splToken.getAssociatedTokenAddressSync(this.mint, owner),
                transferAuthority,
                owner,
                uint64ToBigInt(totalDeposit),
            ),
        };
    }

    async commonAccounts(): Promise<MatchingEngineCommonAccounts> {
        const custodian = this.custodianAddress();
        const { coreBridgeConfig, coreEmitterSequence, coreFeeCollector, coreBridgeProgram } =
            await this.publishMessageAccounts(PublicKey.default);

        const tokenMessengerMinterProgram = this.tokenMessengerMinterProgram();
        const messageTransmitterProgram = this.messageTransmitterProgram();

        const cctpMintRecipient = this.cctpMintRecipientAddress();
        const mint = this.mint;

        return {
            matchingEngineProgram: this.ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
            clock: SYSVAR_CLOCK_PUBKEY,
            custodian,
            cctpMintRecipient,
            coreBridgeConfig,
            coreEmitterSequence,
            coreFeeCollector,
            coreBridgeProgram,
            tokenMessenger: tokenMessengerMinterProgram.tokenMessengerAddress(),
            tokenMinter: tokenMessengerMinterProgram.tokenMinterAddress(),
            tokenMessengerMinterSenderAuthority:
                tokenMessengerMinterProgram.senderAuthorityAddress(),
            tokenMessengerMinterProgram: tokenMessengerMinterProgram.ID,
            messageTransmitterAuthority: messageTransmitterProgram.authorityAddress(
                tokenMessengerMinterProgram.ID,
            ),
            messageTransmitterConfig: messageTransmitterProgram.messageTransmitterConfigAddress(),
            messageTransmitterProgram: messageTransmitterProgram.ID,
            tokenProgram: splToken.TOKEN_PROGRAM_ID,
            mint,
            localToken: tokenMessengerMinterProgram.localTokenAddress(mint),
            tokenMessengerMinterCustodyToken: tokenMessengerMinterProgram.custodyTokenAddress(mint),
        };
    }

    checkedCustodianComposite(addr?: PublicKey): { custodian: PublicKey } {
        return { custodian: addr ?? this.custodianAddress() };
    }

    adminComposite(
        ownerOrAssistant: PublicKey,
        custodian?: PublicKey,
    ): { ownerOrAssistant: PublicKey; custodian: { custodian: PublicKey } } {
        return { ownerOrAssistant, custodian: this.checkedCustodianComposite(custodian) };
    }

    adminMutComposite(
        ownerOrAssistant: PublicKey,
        custodian?: PublicKey,
    ): { ownerOrAssistant: PublicKey; custodian: PublicKey } {
        return { ownerOrAssistant, custodian: custodian ?? this.custodianAddress() };
    }

    ownerOnlyComposite(
        owner: PublicKey,
        custodian?: PublicKey,
    ): { owner: PublicKey; custodian: { custodian: PublicKey } } {
        return { owner, custodian: this.checkedCustodianComposite(custodian) };
    }

    ownerOnlyMutComposite(
        owner: PublicKey,
        custodian?: PublicKey,
    ): { owner: PublicKey; custodian: PublicKey } {
        return { owner, custodian: custodian ?? this.custodianAddress() };
    }

    routerEndpointComposite(addr: PublicKey): { endpoint: PublicKey } {
        return {
            endpoint: addr,
        };
    }

    liquidityLayerVaaComposite(vaa: PublicKey): { vaa: PublicKey } {
        return {
            vaa,
        };
    }

    usdcComposite(mint?: PublicKey): { mint: PublicKey } {
        return {
            mint: mint ?? this.mint,
        };
    }

    localTokenRouterComposite(tokenRouterProgram: PublicKey): {
        tokenRouterProgram: PublicKey;
        tokenRouterEmitter: PublicKey;
        tokenRouterMintRecipient: PublicKey;
    } {
        const [tokenRouterEmitter] = PublicKey.findProgramAddressSync(
            [Buffer.from("emitter")],
            tokenRouterProgram,
        );
        return {
            tokenRouterProgram,
            tokenRouterEmitter,
            tokenRouterMintRecipient: splToken.getAssociatedTokenAddressSync(
                this.mint,
                tokenRouterEmitter,
                true,
            ),
        };
    }

    async activeAuctionComposite(
        accounts: {
            auction: PublicKey;
            config?: PublicKey;
            bestOfferToken?: PublicKey;
        },
        cached: {
            auctionInfo?: AuctionInfo;
        } = {},
    ) {
        const { auction } = accounts;

        let { config, bestOfferToken } = accounts;
        let { auctionInfo } = cached;

        if (config === undefined || bestOfferToken === undefined) {
            if (auctionInfo === undefined) {
                const { info } = await this.fetchAuction({ address: auction });
                if (info === null) {
                    throw new Error("Auction info not found");
                }
                auctionInfo = info;
            }

            config ??= this.auctionConfigAddress(auctionInfo.configId);
            bestOfferToken ??= auctionInfo.bestOfferToken;
        }

        return {
            custodyToken: this.auctionCustodyTokenAddress(auction),
            auction,
            config,
            bestOfferToken,
        };
    }

    closePreparedOrderResponseComposite(accounts: { by: PublicKey; orderResponse: PublicKey }): {
        by: PublicKey;
        orderResponse: PublicKey;
        custodyToken: PublicKey;
    } {
        const { by, orderResponse } = accounts;
        return {
            by,
            orderResponse,
            custodyToken: this.preparedCustodyTokenAddress(orderResponse),
        };
    }

    liveRouterPathComposite(accounts: { fromEndpoint: PublicKey; toEndpoint: PublicKey }): {
        fromEndpoint: { endpoint: PublicKey };
        toEndpoint: { endpoint: PublicKey };
    } {
        const { fromEndpoint, toEndpoint } = accounts;
        return {
            fromEndpoint: { endpoint: fromEndpoint },
            toEndpoint: { endpoint: toEndpoint },
        };
    }

    fastOrderPathComposite(accounts: {
        fastVaa: PublicKey;
        fromEndpoint: PublicKey;
        toEndpoint: PublicKey;
    }): FastOrderPathComposite {
        const { fastVaa, fromEndpoint, toEndpoint } = accounts;
        return {
            fastVaa: { vaa: fastVaa },
            path: this.liveRouterPathComposite({ fromEndpoint, toEndpoint }),
        };
    }

    cctpMintRecipientComposite(): { mintRecipient: PublicKey } {
        return {
            mintRecipient: this.cctpMintRecipientAddress(),
        };
    }

    requiredSysvarsComposite(): {
        rent: PublicKey;
        clock: PublicKey;
    } {
        return {
            rent: SYSVAR_RENT_PUBKEY,
            clock: SYSVAR_CLOCK_PUBKEY,
        };
    }

    async initializeIx(
        accounts: {
            owner: PublicKey;
            ownerAssistant: PublicKey;
            feeRecipient: PublicKey;
            mint?: PublicKey;
        },
        auctionParams: AuctionParameters,
    ): Promise<TransactionInstruction> {
        const { owner, ownerAssistant, feeRecipient, mint } = accounts;

        const upgradeManager = this.upgradeManagerProgram();
        return this.program.methods
            .initialize({ auctionParams })
            .accounts({
                owner,
                custodian: this.custodianAddress(),
                auctionConfig: this.auctionConfigAddress(0),
                ownerAssistant,
                feeRecipient,
                feeRecipientToken: splToken.getAssociatedTokenAddressSync(this.mint, feeRecipient),
                cctpMintRecipient: this.cctpMintRecipientAddress(),
                usdc: this.usdcComposite(mint),
                programData: programDataAddress(this.ID),
                upgradeManagerAuthority: upgradeManager.upgradeAuthorityAddress(),
                upgradeManagerProgram: upgradeManager.ID,
                bpfLoaderUpgradeableProgram: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
                associatedTokenProgram: splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .instruction();
    }

    async setPauseIx(
        accounts: {
            ownerOrAssistant: PublicKey;
            custodian?: PublicKey;
        },
        paused: boolean,
    ): Promise<TransactionInstruction> {
        const { ownerOrAssistant, custodian } = accounts;
        return this.program.methods
            .setPause(paused)
            .accounts({
                admin: this.adminMutComposite(ownerOrAssistant, custodian),
            })
            .instruction();
    }

    async submitOwnershipTransferIx(accounts: {
        owner: PublicKey;
        newOwner: PublicKey;
        custodian?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { owner, newOwner, custodian } = accounts;
        return this.program.methods
            .submitOwnershipTransferRequest()
            .accounts({
                admin: this.ownerOnlyMutComposite(owner, custodian),
                newOwner,
            })
            .instruction();
    }

    async confirmOwnershipTransferIx(accounts: {
        pendingOwner: PublicKey;
        custodian?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { pendingOwner } = accounts;
        let { custodian } = accounts;
        custodian ??= this.custodianAddress();
        return this.program.methods
            .confirmOwnershipTransferRequest()
            .accounts({ pendingOwner, custodian })
            .instruction();
    }

    async cancelOwnershipTransferIx(accounts: {
        owner: PublicKey;
        custodian?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { owner, custodian } = accounts;
        return this.program.methods
            .cancelOwnershipTransferRequest()
            .accounts({
                admin: this.ownerOnlyMutComposite(owner, custodian),
            })
            .instruction();
    }

    async updateOwnerAssistantIx(accounts: {
        owner: PublicKey;
        newOwnerAssistant: PublicKey;
        custodian?: PublicKey;
    }) {
        const { owner, newOwnerAssistant, custodian } = accounts;
        return this.program.methods
            .updateOwnerAssistant()
            .accounts({
                admin: this.ownerOnlyMutComposite(owner, custodian),
                newOwnerAssistant,
            })
            .instruction();
    }

    async addCctpRouterEndpointIx(
        accounts: {
            ownerOrAssistant: PublicKey;
            payer?: PublicKey;
            custodian?: PublicKey;
            routerEndpoint?: PublicKey;
            remoteTokenMessenger?: PublicKey;
        },
        args: AddCctpRouterEndpointArgs,
    ): Promise<TransactionInstruction> {
        const { ownerOrAssistant, custodian } = accounts;
        const { chain, cctpDomain } = args;

        let { payer, routerEndpoint, remoteTokenMessenger } = accounts;
        payer ??= ownerOrAssistant;
        routerEndpoint ??= this.routerEndpointAddress(chain);
        remoteTokenMessenger ??=
            this.tokenMessengerMinterProgram().remoteTokenMessengerAddress(cctpDomain);

        return this.program.methods
            .addCctpRouterEndpoint(args)
            .accounts({
                payer,
                admin: this.adminComposite(ownerOrAssistant, custodian),
                routerEndpoint,
                localCustodyToken: this.localCustodyTokenAddress(chain),
                remoteTokenMessenger,
                usdc: this.usdcComposite(),
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .instruction();
    }

    async updateCctpRouterEndpointIx(
        accounts: {
            owner: PublicKey;
            custodian?: PublicKey;
            routerEndpoint?: PublicKey;
            remoteTokenMessenger?: PublicKey;
        },
        args: AddCctpRouterEndpointArgs,
    ): Promise<TransactionInstruction> {
        const { owner, custodian } = accounts;
        const { chain, cctpDomain } = args;

        let { routerEndpoint, remoteTokenMessenger } = accounts;
        routerEndpoint ??= this.routerEndpointAddress(chain);
        remoteTokenMessenger ??=
            this.tokenMessengerMinterProgram().remoteTokenMessengerAddress(cctpDomain);

        return this.program.methods
            .updateCctpRouterEndpoint(args)
            .accounts({
                admin: this.ownerOnlyComposite(owner, custodian),
                routerEndpoint: this.routerEndpointComposite(routerEndpoint),
                remoteTokenMessenger,
            })
            .instruction();
    }

    async proposeAuctionParametersIx(
        accounts: {
            ownerOrAssistant: PublicKey;
            payer?: PublicKey;
            custodian?: PublicKey;
            proposal?: PublicKey;
        },
        parameters: AuctionParameters,
        opts: {
            proposalId?: Uint64;
        } = {},
    ): Promise<TransactionInstruction> {
        const { ownerOrAssistant, custodian } = accounts;

        let { payer, proposal } = accounts;
        payer ??= ownerOrAssistant;
        proposal ??= await this.proposalAddress(opts.proposalId);

        return this.program.methods
            .proposeAuctionParameters(parameters)
            .accounts({
                payer,
                admin: {
                    ownerOrAssistant,
                    custodian: this.checkedCustodianComposite(custodian),
                },
                proposal,
                epochSchedule: SYSVAR_EPOCH_SCHEDULE_PUBKEY,
                systemProgram: SystemProgram.programId,
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
            })
            .instruction();
    }

    async closeProposalIx(
        accounts: {
            ownerOrAssistant: PublicKey;
            proposal?: PublicKey;
        },
        opts: {
            proposalId?: Uint64;
        } = {},
    ): Promise<TransactionInstruction> {
        const { ownerOrAssistant } = accounts;

        let { proposal } = accounts;
        proposal ??= await this.proposalAddress(opts.proposalId);

        const { by: proposedBy } = await this.fetchProposal({ address: proposal });

        return this.program.methods
            .closeProposal()
            .accounts({
                admin: this.adminComposite(ownerOrAssistant),
                proposedBy,
                proposal,
            })
            .instruction();
    }

    async updateAuctionParametersIx(
        accounts: {
            owner: PublicKey;
            payer?: PublicKey;
            custodian?: PublicKey;
            proposal?: PublicKey;
            auctionConfig?: PublicKey;
        },
        opts: {
            proposalId?: Uint64;
        } = {},
    ): Promise<TransactionInstruction> {
        const { owner, custodian } = accounts;

        let { payer, proposal, auctionConfig } = accounts;
        payer ??= owner;
        proposal ??= await this.proposalAddress(opts.proposalId);

        if (auctionConfig === undefined) {
            const { auctionConfigId } = await this.fetchCustodian();
            // Add 1 to the current auction config ID to get the next one.
            auctionConfig = this.auctionConfigAddress(auctionConfigId + 1);
        }

        return this.program.methods
            .updateAuctionParameters()
            .accounts({
                payer,
                admin: this.ownerOnlyMutComposite(owner, custodian),
                proposal,
                auctionConfig,
                systemProgram: SystemProgram.programId,
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
            })
            .instruction();
    }

    async addLocalRouterEndpointIx(accounts: {
        ownerOrAssistant: PublicKey;
        tokenRouterProgram: PublicKey;
        payer?: PublicKey;
        custodian?: PublicKey;
        routerEndpoint?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { ownerOrAssistant, tokenRouterProgram, custodian } = accounts;

        let { payer, routerEndpoint } = accounts;
        payer ??= ownerOrAssistant;
        routerEndpoint ??= this.routerEndpointAddress(toChainId("Solana"));

        return this.program.methods
            .addLocalRouterEndpoint()
            .accounts({
                payer,
                admin: this.adminComposite(ownerOrAssistant, custodian),
                routerEndpoint,
                local: this.localTokenRouterComposite(tokenRouterProgram),
                systemProgram: SystemProgram.programId,
            })
            .instruction();
    }

    async updateLocalRouterEndpointIx(accounts: {
        owner: PublicKey;
        tokenRouterProgram: PublicKey;
        custodian?: PublicKey;
        routerEndpoint?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { owner, tokenRouterProgram, custodian } = accounts;

        let { routerEndpoint } = accounts;
        routerEndpoint ??= this.routerEndpointAddress(toChainId("Solana"));

        return this.program.methods
            .updateLocalRouterEndpoint()
            .accounts({
                admin: this.ownerOnlyComposite(owner, custodian),
                routerEndpoint: this.routerEndpointComposite(routerEndpoint),
                local: this.localTokenRouterComposite(tokenRouterProgram),
            })
            .instruction();
    }

    async disableRouterEndpointIx(
        accounts: {
            owner: PublicKey;
            custodian?: PublicKey;
            routerEndpoint?: PublicKey;
        },
        chain: ChainId,
    ): Promise<TransactionInstruction> {
        const { owner, custodian } = accounts;

        let { routerEndpoint } = accounts;
        routerEndpoint ??= this.routerEndpointAddress(chain);

        return this.program.methods
            .disableRouterEndpoint()
            .accounts({
                admin: this.ownerOnlyComposite(owner, custodian),
                routerEndpoint: this.routerEndpointComposite(routerEndpoint),
            })
            .instruction();
    }

    async updateFeeRecipientIx(accounts: {
        ownerOrAssistant: PublicKey;
        newFeeRecipient: PublicKey;
        custodian?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { ownerOrAssistant, newFeeRecipient, custodian } = accounts;

        return this.program.methods
            .updateFeeRecipient()
            .accounts({
                admin: this.adminMutComposite(ownerOrAssistant, custodian),
                newFeeRecipient,
                newFeeRecipientToken: splToken.getAssociatedTokenAddressSync(
                    this.mint,
                    newFeeRecipient,
                ),
            })
            .instruction();
    }

    async fetchCctpMintRecipient(): Promise<splToken.Account> {
        return splToken.getAccount(
            this.program.provider.connection,
            this.cctpMintRecipientAddress(),
        );
    }

    async placeInitialOfferTx(
        accounts: {
            payer: PublicKey;
            fastVaa: PublicKey;
            fromRouterEndpoint: PublicKey;
            toRouterEndpoint: PublicKey;
            auction: PublicKey;
        },
        args: {
            offerPrice: Uint64;
            totalDeposit: Uint64;
        },
        signers: Signer[],
        opts: PreparedTransactionOptions,
        confirmOptions?: ConfirmOptions,
    ): Promise<PreparedTransaction> {
        const { payer, fastVaa, auction, fromRouterEndpoint, toRouterEndpoint } = accounts;
        const ixs = await this.placeInitialOfferCctpIx(
            {
                payer,
                feePayer: signers[0]?.publicKey,
                fastVaa,
                auction,
                fromRouterEndpoint,
                toRouterEndpoint,
            },
            args,
        );

        return {
            ixs,
            signers,
            computeUnits: opts.computeUnits!,
            feeMicroLamports: opts.feeMicroLamports,
            nonceAccount: opts.nonceAccount,
            addressLookupTableAccounts: opts.addressLookupTableAccounts,
            txName: "placeInitialOffer",
            confirmOptions,
        };
    }

    async placeInitialOfferCctpIx(
        accounts: {
            payer: PublicKey;
            feePayer?: PublicKey;
            fastVaa: PublicKey;
            offerToken?: PublicKey;
            auction?: PublicKey;
            auctionConfig?: PublicKey;
            fromRouterEndpoint?: PublicKey;
            toRouterEndpoint?: PublicKey;
        },
        args: {
            offerPrice: Uint64;
            totalDeposit?: Uint64;
        },
    ): Promise<
        [approveIx: TransactionInstruction, placeInitialOfferCctpIx: TransactionInstruction]
    > {
        const { payer, feePayer, fastVaa } = accounts;

        const { offerPrice } = args;

        let { auction, auctionConfig, offerToken, fromRouterEndpoint, toRouterEndpoint } = accounts;
        let { totalDeposit } = args;

        offerToken ??= await splToken.getAssociatedTokenAddress(this.mint, payer);
        let fetchedConfigId: Uint64 | null = null;
        if (
            auction === undefined ||
            fromRouterEndpoint === undefined ||
            toRouterEndpoint === undefined ||
            totalDeposit === undefined
        ) {
            const vaaAccount = await VaaAccount.fetch(this.program.provider.connection, fastVaa);
            auction ??= this.auctionAddress(vaaAccount.digest());
            fromRouterEndpoint ??= this.routerEndpointAddress(vaaAccount.emitterInfo().chain);
            const { fastMarketOrder } = LiquidityLayerMessage.decode(vaaAccount.payload());
            if (fastMarketOrder === undefined) {
                throw new Error("Message not FastMarketOrder");
            }
            toRouterEndpoint ??= this.routerEndpointAddress(toChainId(fastMarketOrder.targetChain));

            const custodianData = await this.fetchCustodian();
            fetchedConfigId = custodianData.auctionConfigId;

            const notionalDeposit = await this.computeNotionalSecurityDeposit(
                fastMarketOrder.amountIn,
                fetchedConfigId,
            );

            totalDeposit ??= fastMarketOrder.amountIn + fastMarketOrder.maxFee + notionalDeposit;
        }

        if (auctionConfig === undefined) {
            if (fetchedConfigId === null) {
                const custodianData = await this.fetchCustodian();
                fetchedConfigId = custodianData.auctionConfigId;
            }
            auctionConfig = this.auctionConfigAddress(fetchedConfigId);
        }

        const auctionCustodyToken = this.auctionCustodyTokenAddress(auction);
        const { transferAuthority, ix: approveIx } = await this.approveTransferAuthorityIx(
            { auction, owner: payer },
            {
                totalDeposit,
                offerPrice,
            },
        );
        const placeInitialOfferCctpIx = await this.program.methods
            .placeInitialOfferCctp(uint64ToBN(offerPrice))
            .accounts({
                payer: feePayer ?? payer,
                transferAuthority,
                custodian: this.checkedCustodianComposite(),
                auctionConfig,
                auction,
                fastOrderPath: this.fastOrderPathComposite({
                    fastVaa,
                    fromEndpoint: fromRouterEndpoint,
                    toEndpoint: toRouterEndpoint,
                }),
                offerToken,
                auctionCustodyToken,
                usdc: this.usdcComposite(),
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
            })
            .instruction();

        return [approveIx, placeInitialOfferCctpIx];
    }

    async improveOfferTx(
        accounts: {
            participant: PublicKey;
            auction: PublicKey;
            auctionConfig: PublicKey;
            bestOfferToken: PublicKey;
        },
        args: {
            offerPrice: Uint64;
            totalDeposit: Uint64;
        },
        signers: Signer[],
        opts: PreparedTransactionOptions,
        confirmOptions?: ConfirmOptions,
    ): Promise<PreparedTransaction> {
        const { participant, auction, auctionConfig, bestOfferToken } = accounts;

        const ixs = await this.improveOfferIx(
            {
                participant,
                auction,
                auctionConfig,
                bestOfferToken,
            },
            args,
        );

        return {
            ixs,
            signers,
            computeUnits: opts.computeUnits,
            feeMicroLamports: opts.feeMicroLamports,
            nonceAccount: opts.nonceAccount,
            addressLookupTableAccounts: opts.addressLookupTableAccounts,
            txName: "improveOffer",
            confirmOptions,
        };
    }

    async improveOfferIx(
        accounts: {
            participant: PublicKey;
            auction: PublicKey;
            auctionConfig?: PublicKey;
            bestOfferToken?: PublicKey;
        },
        args: { offerPrice: Uint64; totalDeposit?: Uint64 },
    ): Promise<[approveIx: TransactionInstruction, improveOfferIx: TransactionInstruction]> {
        const { participant, auction, auctionConfig, bestOfferToken } = accounts;
        const { offerPrice } = args;

        let { totalDeposit } = args;

        let auctionInfo: AuctionInfo | undefined;
        if (totalDeposit === undefined) {
            const { info } = await this.fetchAuction({ address: auction });
            if (info === null) {
                throw new Error("no auction info found");
            }
            auctionInfo = info;
            totalDeposit = BigInt(auctionInfo.amountIn.add(auctionInfo.securityDeposit).toString());
        }

        const { transferAuthority, ix: approveIx } = await this.approveTransferAuthorityIx(
            { auction, owner: participant },
            {
                offerPrice,
                totalDeposit,
            },
        );

        const improveOfferIx = await this.program.methods
            .improveOffer(uint64ToBN(offerPrice))
            .accounts({
                transferAuthority,
                activeAuction: await this.activeAuctionComposite(
                    { auction, config: auctionConfig, bestOfferToken: bestOfferToken },
                    { auctionInfo },
                ),
                offerToken: splToken.getAssociatedTokenAddressSync(this.mint, participant),
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
            })
            .instruction();

        return [approveIx, improveOfferIx];
    }

    async prepareOrderResponseCctpIx(
        accounts: {
            payer: PublicKey;
            fastVaa: PublicKey;
            finalizedVaa: PublicKey;
            baseFeeToken?: PublicKey;
        },
        args: CctpMessageArgs,
    ): Promise<TransactionInstruction> {
        const { payer, fastVaa, finalizedVaa } = accounts;

        let { baseFeeToken } = accounts;
        baseFeeToken ??= await splToken.getAssociatedTokenAddress(this.mint, payer);

        const fastVaaAcct = await VaaAccount.fetch(this.program.provider.connection, fastVaa);
        const fromEndpoint = this.routerEndpointAddress(fastVaaAcct.emitterInfo().chain);

        const { fastMarketOrder } = LiquidityLayerMessage.decode(fastVaaAcct.payload());
        if (fastMarketOrder === undefined) {
            throw new Error("Message not FastMarketOrder");
        }
        const toEndpoint = this.routerEndpointAddress(toChainId(fastMarketOrder.targetChain));

        const { encodedCctpMessage } = args;
        const {
            authority: messageTransmitterAuthority,
            messageTransmitterConfig,
            usedNonces,
            messageTransmitterEventAuthority,
            tokenMessengerMinterProgram,
            tokenMessenger,
            remoteTokenMessenger,
            tokenMinter,
            localToken,
            tokenPair,
            custodyToken: tokenMessengerMinterCustodyToken,
            messageTransmitterProgram,
            tokenMessengerMinterEventAuthority,
        } = this.messageTransmitterProgram().receiveTokenMessengerMinterMessageAccounts(
            this.mint,
            encodedCctpMessage,
        );

        const preparedOrderResponse = this.preparedOrderResponseAddress(fastVaaAcct.digest());
        return this.program.methods
            .prepareOrderResponseCctp(args)
            .accounts({
                payer,
                custodian: this.checkedCustodianComposite(),
                fastOrderPath: this.fastOrderPathComposite({ fastVaa, fromEndpoint, toEndpoint }),
                finalizedVaa: this.liquidityLayerVaaComposite(finalizedVaa),
                preparedOrderResponse,
                preparedCustodyToken: this.preparedCustodyTokenAddress(preparedOrderResponse),
                baseFeeToken,
                usdc: this.usdcComposite(),
                cctp: {
                    mintRecipient: this.cctpMintRecipientComposite(),
                    messageTransmitterAuthority,
                    messageTransmitterConfig,
                    usedNonces,
                    messageTransmitterEventAuthority,
                    tokenMessenger,
                    remoteTokenMessenger,
                    tokenMinter,
                    localToken,
                    tokenPair,
                    tokenMessengerMinterCustodyToken,
                    tokenMessengerMinterEventAuthority,
                    tokenMessengerMinterProgram,
                    messageTransmitterProgram,
                },
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .instruction();
    }

    async settleAuctionCompleteTx(
        accounts: {
            executor: PublicKey;
            fastVaa: PublicKey;
            finalizedVaa: PublicKey;
            bestOfferToken: PublicKey;
            auction: PublicKey;
        },
        args: CctpMessageArgs,
        signers: Signer[],
        opts: PreparedTransactionOptions,
        confirmOptions?: ConfirmOptions,
    ): Promise<PreparedTransaction> {
        let { executor, fastVaa, finalizedVaa, auction, bestOfferToken } = accounts;

        const prepareOrderResponseIx = await this.prepareOrderResponseCctpIx(
            { payer: executor, fastVaa, finalizedVaa, baseFeeToken: bestOfferToken },
            args,
        );
        const fastVaaAccount = await VaaAccount.fetch(this.program.provider.connection, fastVaa);

        // Fetch the prepared order response.
        const preparedOrderResponse = this.preparedOrderResponseAddress(fastVaaAccount.digest());

        // The executor must be the owner of the best offer token if there is no penalty.
        const { status } = await this.fetchAuction({ address: auction });
        if (status.completed?.executePenalty === null) {
            const { owner } = await splToken.getAccount(
                this.program.provider.connection,
                bestOfferToken,
            );
            executor = owner;
        }

        const settleAuctionCompletedIx = await this.settleAuctionCompleteIx({
            beneficiary: executor,
            auction,
            preparedOrderResponse,
            bestOfferToken,
            baseFeeToken: bestOfferToken,
        });

        const preparedTx: PreparedTransaction = {
            ixs: [prepareOrderResponseIx, settleAuctionCompletedIx],
            signers,
            computeUnits: opts.computeUnits!,
            feeMicroLamports: opts.feeMicroLamports,
            nonceAccount: opts.nonceAccount,
            addressLookupTableAccounts: opts.addressLookupTableAccounts,
            txName: "settleAuctionComplete",
            confirmOptions,
        };

        return preparedTx;
    }

    async settleAuctionCompleteIx(accounts: {
        preparedOrderResponse: PublicKey;
        auction?: PublicKey;
        beneficiary?: PublicKey;
        baseFeeToken?: PublicKey;
        bestOfferToken?: PublicKey;
    }) {
        const { preparedOrderResponse } = accounts;

        let { auction, beneficiary, baseFeeToken, bestOfferToken } = accounts;

        if (auction === undefined || beneficiary === undefined || baseFeeToken === undefined) {
            const { seeds, info } = await this.fetchPreparedOrderResponse({
                address: preparedOrderResponse,
            });

            auction ??= this.auctionAddress(seeds.fastVaaHash);
            beneficiary ??= info.preparedBy;
            baseFeeToken ??= info.baseFeeToken;
        }

        if (bestOfferToken === undefined) {
            const { info } = await this.fetchAuction({ address: auction });
            if (info === null) {
                throw new Error("no auction info found");
            }

            bestOfferToken = info.bestOfferToken;
        }

        return this.program.methods
            .settleAuctionComplete()
            .accounts({
                beneficiary,
                baseFeeToken,
                preparedOrderResponse,
                preparedCustodyToken: this.preparedCustodyTokenAddress(preparedOrderResponse),
                auction,
                bestOfferToken,
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
            })
            .instruction();
    }

    async settleAuctionNoneTx(
        accounts: {
            executor: PublicKey;
            fastVaa: PublicKey;
            finalizedVaa: PublicKey;
            auction?: PublicKey;
        },
        args: CctpMessageArgs,
        signers: Signer[],
        opts: PreparedTransactionOptions,
        confirmOptions?: ConfirmOptions,
    ): Promise<PreparedTransaction> {
        const { executor, fastVaa, finalizedVaa, auction } = accounts;

        const { feeRecipientToken } = await this.fetchCustodian();
        const prepareOrderResponseIx = await this.prepareOrderResponseCctpIx(
            { payer: executor, fastVaa, finalizedVaa, baseFeeToken: feeRecipientToken },
            args,
        );
        const fastVaaAccount = await VaaAccount.fetch(this.program.provider.connection, fastVaa);
        const { fastMarketOrder } = LiquidityLayerMessage.decode(fastVaaAccount.payload());
        if (fastMarketOrder === undefined) {
            throw new Error("Message not FastMarketOrder");
        }

        // Fetch the prepared order response.
        const fastVaaHash = fastVaaAccount.digest();
        const preparedOrderResponse = this.preparedOrderResponseAddress(fastVaaHash);

        const settleAuctionNoneIx = await (async () => {
            if (fastMarketOrder.targetChain === "Solana") {
                return this.settleAuctionNoneLocalIx({
                    payer: executor,
                    reservedSequence: this.reservedFastFillSequenceAddress(fastVaaHash),
                    preparedOrderResponse,
                    auction,
                });
            } else {
                return this.settleAuctionNoneCctpIx(
                    {
                        payer: executor,
                        fastVaa,
                        preparedOrderResponse,
                    },
                    { targetChain: toChainId(fastMarketOrder.targetChain) },
                );
            }
        })();

        const preparedTx: PreparedTransaction = {
            ixs: [prepareOrderResponseIx, settleAuctionNoneIx],
            signers,
            computeUnits: opts.computeUnits!,
            feeMicroLamports: opts.feeMicroLamports,
            nonceAccount: opts.nonceAccount,
            addressLookupTableAccounts: opts.addressLookupTableAccounts,
            txName: "settleAuctionComplete",
            confirmOptions,
        };

        return preparedTx;
    }

    async settleAuctionNoneLocalIx(
        accounts: {
            payer: PublicKey;
            reservedSequence: PublicKey;
            preparedOrderResponse?: PublicKey;
            auction?: PublicKey;
        },
        opts: {
            sourceChain?: ChainId;
            orderSender?: Array<number>;
            sequence?: Uint64;
        } = {},
    ) {
        const { payer, reservedSequence } = accounts;

        let { auction, preparedOrderResponse } = accounts;
        let { sourceChain, orderSender, sequence } = opts;

        if (
            auction === undefined ||
            preparedOrderResponse === undefined ||
            sourceChain === undefined ||
            orderSender === undefined ||
            sequence === undefined
        ) {
            const {
                seeds: { fastVaaHash },
                fastFillSeeds,
            } = await this.fetchReservedFastFillSequence({
                address: reservedSequence,
            });
            auction ??= this.auctionAddress(fastVaaHash);
            preparedOrderResponse ??= this.preparedOrderResponseAddress(fastVaaHash);

            if (!isChainId(fastFillSeeds.sourceChain)) {
                throw new Error("Invalid source chain");
            }
            sourceChain ??= fastFillSeeds.sourceChain;
            orderSender ??= fastFillSeeds.orderSender;
            sequence ??= fastFillSeeds.sequence;
        }

        const { feeRecipientToken } = await this.fetchCustodian();

        return this.program.methods
            .settleAuctionNoneLocal()
            .accounts({
                payer,
                custodian: this.checkedCustodianComposite(),
                feeRecipientToken,
                prepared: this.closePreparedOrderResponseComposite({
                    by: payer,
                    orderResponse: preparedOrderResponse,
                }),
                auction,
                reservedSequence,
                fastFill: this.fastFillAddress(sourceChain, orderSender, sequence),
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
                localCustodyToken: this.localCustodyTokenAddress(sourceChain),
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                sysvars: this.requiredSysvarsComposite(),
            })
            .instruction();
    }

    async settleAuctionNoneCctpIx(
        accounts: {
            payer: PublicKey;
            fastVaa: PublicKey;
            preparedOrderResponse?: PublicKey;
            auction?: PublicKey;
        },
        opts: {
            sourceChain?: ChainId;
            targetChain?: ChainId;
        } = {},
    ) {
        const { payer, fastVaa } = accounts;

        let { auction, preparedOrderResponse } = accounts;
        let { sourceChain, targetChain } = opts;

        let fastVaaAccount: VaaAccount | undefined;
        if (auction === undefined || preparedOrderResponse === undefined) {
            fastVaaAccount = await VaaAccount.fetch(this.program.provider.connection, fastVaa);
            auction ??= this.auctionAddress(fastVaaAccount.digest());
            preparedOrderResponse ??= this.preparedOrderResponseAddress(fastVaaAccount.digest());
        }

        if (sourceChain === undefined || targetChain === undefined) {
            fastVaaAccount ??= await VaaAccount.fetch(this.program.provider.connection, fastVaa);
            sourceChain ??= fastVaaAccount.emitterInfo().chain;

            const message = LiquidityLayerMessage.decode(fastVaaAccount.payload());
            if (message.fastMarketOrder === undefined) {
                throw new Error("Message not FastMarketOrder");
            }

            targetChain ??= toChainId(message.fastMarketOrder.targetChain);
        }
        const {
            custodian,
            routerEndpoint: toRouterEndpoint,
            coreMessage,
            cctpMessage,
            coreBridgeConfig,
            coreEmitterSequence,
            coreFeeCollector,
            coreBridgeProgram,
            tokenMessengerMinterSenderAuthority,
            messageTransmitterConfig,
            tokenMessenger,
            remoteTokenMessenger,
            tokenMinter,
            localToken,
            tokenMessengerMinterEventAuthority,
            messageTransmitterProgram,
            tokenMessengerMinterProgram,
        } = await this.burnAndPublishAccounts(auction, { targetChain });

        const { feeRecipientToken } = await this.fetchCustodian();

        return this.program.methods
            .settleAuctionNoneCctp()
            .accounts({
                payer,
                coreMessage,
                cctpMessage,
                custodian: this.checkedCustodianComposite(custodian),
                feeRecipientToken,
                prepared: this.closePreparedOrderResponseComposite({
                    by: payer,
                    orderResponse: preparedOrderResponse,
                }),
                auction,
                wormhole: {
                    config: coreBridgeConfig,
                    emitterSequence: coreEmitterSequence,
                    feeCollector: coreFeeCollector,
                    coreBridgeProgram,
                },
                cctp: {
                    mint: this.mint,
                    tokenMessengerMinterSenderAuthority,
                    messageTransmitterConfig,
                    tokenMessenger,
                    remoteTokenMessenger,
                    tokenMinter,
                    localToken,
                    tokenMessengerMinterEventAuthority,
                    tokenMessengerMinterProgram,
                    messageTransmitterProgram,
                },
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                sysvars: this.requiredSysvarsComposite(),
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
            })
            .instruction();
    }

    async executeFastOrderTx(
        accounts: {
            payer: PublicKey;
            fastVaa: PublicKey;
            auction?: PublicKey;
            executorToken?: PublicKey;
            reservedSequence?: PublicKey;
        },
        signers: Signer[],
        opts: PreparedTransactionOptions,
        confirmOptions?: ConfirmOptions,
    ): Promise<PreparedTransaction> {
        const { payer, fastVaa, executorToken } = accounts;

        let { auction, reservedSequence } = accounts;

        let fastVaaAccount: VaaAccount | undefined;
        let targetChain: ChainId | undefined;
        if (auction === undefined || reservedSequence === undefined) {
            fastVaaAccount = await VaaAccount.fetch(this.program.provider.connection, fastVaa);
            const fastVaaHash = fastVaaAccount.digest();
            auction = this.auctionAddress(fastVaaHash);
            reservedSequence = this.reservedFastFillSequenceAddress(fastVaaHash);

            const { fastMarketOrder } = LiquidityLayerMessage.decode(fastVaaAccount.payload());
            if (fastMarketOrder === undefined) {
                throw new Error("Message not FastMarketOrder");
            }

            targetChain = toChainId(fastMarketOrder.targetChain);
        }

        // TODO: Make this smarter. Consider adding a target chain argument.
        if (targetChain === undefined) {
            fastVaaAccount ??= await VaaAccount.fetch(this.program.provider.connection, fastVaa);

            const { fastMarketOrder } = LiquidityLayerMessage.decode(fastVaaAccount.payload());
            if (fastMarketOrder === undefined) {
                throw new Error("Message not FastMarketOrder");
            }

            targetChain = toChainId(fastMarketOrder.targetChain);
        }

        const executeOrderIx = await (async () => {
            if (targetChain === toChainId("Solana")) {
                return this.executeFastOrderLocalIx({
                    payer,
                    fastVaa,
                    auction,
                    executorToken,
                    reservedSequence,
                });
            } else {
                return this.executeFastOrderCctpIx(
                    {
                        payer,
                        fastVaa,
                        auction,
                        executorToken,
                    },
                    { targetChain },
                );
            }
        })();

        return {
            ixs: [executeOrderIx],
            signers,
            computeUnits: opts.computeUnits!,
            feeMicroLamports: opts.feeMicroLamports,
            nonceAccount: opts.nonceAccount,
            addressLookupTableAccounts: opts.addressLookupTableAccounts,
            txName: "executeOrder",
            confirmOptions,
        };
    }

    async executeFastOrderCctpIx(
        accounts: {
            payer: PublicKey;
            fastVaa: PublicKey;
            executorToken?: PublicKey;
            auction?: PublicKey;
            auctionConfig?: PublicKey;
            bestOfferToken?: PublicKey;
            initialOfferToken?: PublicKey;
            initialParticipant?: PublicKey;
        },
        opts: {
            targetChain?: ChainId;
        } = {},
    ) {
        const connection = this.program.provider.connection;

        const { payer, fastVaa, auctionConfig, bestOfferToken } = accounts;

        let { auction, executorToken, initialOfferToken, initialParticipant } = accounts;
        let { targetChain } = opts;

        executorToken ??= splToken.getAssociatedTokenAddressSync(this.mint, payer);

        let fastVaaAccount: VaaAccount | undefined;
        if (auction === undefined) {
            fastVaaAccount = await VaaAccount.fetch(connection, fastVaa);
            auction = this.auctionAddress(fastVaaAccount.digest());
        }

        if (targetChain === undefined) {
            fastVaaAccount ??= await VaaAccount.fetch(connection, fastVaa);

            const { fastMarketOrder } = LiquidityLayerMessage.decode(fastVaaAccount.payload());
            if (fastMarketOrder === undefined) {
                throw new Error("Message not FastMarketOrder");
            }
            targetChain ??= toChainId(fastMarketOrder.targetChain);
        }

        let auctionInfo: AuctionInfo | undefined;
        if (initialOfferToken === undefined || initialParticipant === undefined) {
            const { preparedBy, info } = await this.fetchAuction({ address: auction });
            if (info === null) {
                throw new Error("no auction info found");
            }
            auctionInfo = info;
            initialOfferToken ??= info.initialOfferToken;
            initialParticipant ??= preparedBy;
        }

        const {
            custodian,
            routerEndpoint: toRouterEndpoint,
            coreMessage,
            cctpMessage,
            coreBridgeConfig,
            coreEmitterSequence,
            coreFeeCollector,
            coreBridgeProgram,
            tokenMessengerMinterSenderAuthority,
            messageTransmitterConfig,
            tokenMessenger,
            remoteTokenMessenger,
            tokenMinter,
            localToken,
            tokenMessengerMinterEventAuthority,
            messageTransmitterProgram,
            tokenMessengerMinterProgram,
        } = await this.burnAndPublishAccounts(auction, { targetChain });

        const mint = this.mint;
        return this.program.methods
            .executeFastOrderCctp()
            .accounts({
                payer,
                coreMessage,
                cctpMessage,
                executeOrder: {
                    fastVaa: this.liquidityLayerVaaComposite(fastVaa),
                    activeAuction: await this.activeAuctionComposite(
                        {
                            auction,
                            config: auctionConfig,
                            bestOfferToken,
                        },
                        { auctionInfo },
                    ),
                    executorToken,
                    initialOfferToken,
                    initialParticipant,
                },
                toRouterEndpoint: this.routerEndpointComposite(toRouterEndpoint),
                custodian: this.checkedCustodianComposite(custodian),
                wormhole: {
                    config: coreBridgeConfig,
                    emitterSequence: coreEmitterSequence,
                    feeCollector: coreFeeCollector,
                    coreBridgeProgram,
                },
                cctp: {
                    mint,
                    tokenMessengerMinterSenderAuthority,
                    messageTransmitterConfig,
                    tokenMessenger,
                    remoteTokenMessenger,
                    tokenMinter,
                    localToken,
                    tokenMessengerMinterEventAuthority,
                    tokenMessengerMinterProgram,
                    messageTransmitterProgram,
                },
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                sysvars: this.requiredSysvarsComposite(),
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
            })
            .instruction();
    }

    async reserveFastFillSequenceComposite(
        accounts: {
            payer: PublicKey;
            fastVaa: PublicKey;
            fromEndpoint?: PublicKey;
            toEndpoint?: PublicKey;
            sequencer?: PublicKey;
            reserved?: PublicKey;
            auction?: PublicKey;
        },
        opts: ReserveFastFillSequenceCompositeOpts,
    ): Promise<{
        reserveSequence: {
            payer: PublicKey;
            fastOrderPath: FastOrderPathComposite;
            sequencer: PublicKey;
            reserved: PublicKey;
            auction: PublicKey;
            systemProgram: PublicKey;
        };
        definedOpts: {
            fastVaaHash: VaaHash;
            sourceChain: ChainId;
            orderSender: Array<number>;
            targetChain: ChainId;
        };
    }> {
        const { payer, fastVaa } = accounts;

        let { fromEndpoint, toEndpoint, sequencer, reserved, auction } = accounts;
        let { fastVaaHash, sourceChain, orderSender, targetChain } = opts;

        if (
            fastVaaHash === undefined ||
            sourceChain === undefined ||
            orderSender === undefined ||
            targetChain === undefined
        ) {
            const fastVaaAccount = await VaaAccount.fetch(
                this.program.provider.connection,
                fastVaa,
            );
            fastVaaHash ??= fastVaaAccount.digest();
            sourceChain ??= fastVaaAccount.emitterInfo().chain;

            const { fastMarketOrder } = LiquidityLayerMessage.decode(fastVaaAccount.payload());
            if (fastMarketOrder === undefined) {
                throw new Error("Message not FastMarketOrder");
            }
            orderSender ??= Array.from(fastMarketOrder.sender.toUint8Array());
            targetChain ??= toChainId(fastMarketOrder.targetChain);
        }

        fromEndpoint ??= this.routerEndpointAddress(sourceChain);
        toEndpoint ??= this.routerEndpointAddress(targetChain);
        sequencer ??= this.fastFillSequencerAddress(sourceChain, orderSender);
        reserved ??= this.reservedFastFillSequenceAddress(fastVaaHash);
        auction ??= this.auctionAddress(fastVaaHash);

        return {
            reserveSequence: {
                payer,
                fastOrderPath: this.fastOrderPathComposite({ fastVaa, fromEndpoint, toEndpoint }),
                sequencer,
                reserved,
                auction,
                systemProgram: SystemProgram.programId,
            },
            definedOpts: { fastVaaHash, sourceChain, orderSender, targetChain },
        };
    }

    async reserveFastFillSequenceActiveAuctionIx(
        accounts: {
            payer: PublicKey;
            fastVaa: PublicKey;
            fromEndpoint?: PublicKey;
            toEndpoint?: PublicKey;
            fastFillSequencer?: PublicKey;
            reservedSequence?: PublicKey;
            auction?: PublicKey;
            auctionConfig?: PublicKey;
        },
        opts: ReserveFastFillSequenceCompositeOpts = {},
    ): Promise<TransactionInstruction> {
        const {
            payer,
            fastVaa,
            fromEndpoint,
            toEndpoint,
            fastFillSequencer,
            reservedSequence,
            auction,
        } = accounts;
        const { reserveSequence } = await this.reserveFastFillSequenceComposite(
            {
                payer,
                fastVaa,
                fromEndpoint,
                toEndpoint,
                sequencer: fastFillSequencer,
                reserved: reservedSequence,
                auction,
            },
            opts,
        );

        let { auctionConfig } = accounts;

        if (auctionConfig === undefined) {
            const { info } = await this.fetchAuction({ address: reserveSequence.auction });
            if (info === null) {
                throw new Error("no auction info found");
            }
            auctionConfig = this.auctionConfigAddress(info.configId);
        }

        return this.program.methods
            .reserveFastFillSequenceActiveAuction()
            .accounts({
                reserveSequence,
                auctionConfig,
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
            })
            .instruction();
    }

    async reserveFastFillSequenceNoAuctionIx(
        accounts: {
            payer: PublicKey;
            fastVaa: PublicKey;
            fromEndpoint?: PublicKey;
            toEndpoint?: PublicKey;
            fastFillSequencer?: PublicKey;
            reservedSequence?: PublicKey;
            auction?: PublicKey;
            preparedOrderResponse?: PublicKey;
        },
        opts: ReserveFastFillSequenceCompositeOpts = {},
    ): Promise<TransactionInstruction> {
        const { payer, fastVaa, fromEndpoint, toEndpoint, fastFillSequencer, reservedSequence } =
            accounts;
        const { reserveSequence, definedOpts } = await this.reserveFastFillSequenceComposite(
            {
                payer,
                fastVaa,
                fromEndpoint,
                toEndpoint,
                sequencer: fastFillSequencer,
                reserved: reservedSequence,
            },
            opts,
        );
        const { fastVaaHash } = definedOpts;

        let { auction, preparedOrderResponse } = accounts;
        auction ??= this.auctionAddress(fastVaaHash);
        preparedOrderResponse ??= this.preparedOrderResponseAddress(fastVaaHash);

        return this.program.methods
            .reserveFastFillSequenceNoAuction()
            .accounts({
                reserveSequence,
                preparedOrderResponse,
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
            })
            .instruction();
    }

    async executeFastOrderLocalIx(
        accounts: {
            payer: PublicKey;
            fastVaa: PublicKey;
            reservedSequence?: PublicKey;
            executorToken?: PublicKey;
            auction?: PublicKey;
            auctionConfig?: PublicKey;
            bestOfferToken?: PublicKey;
            initialOfferToken?: PublicKey;
            initialParticipant?: PublicKey;
            reserveBeneficiary?: PublicKey;
        },
        opts: {
            sourceChain?: ChainId;
            orderSender?: Array<number>;
            sequence?: Uint64;
        } = {},
    ) {
        const connection = this.program.provider.connection;

        const { payer, fastVaa, auctionConfig, bestOfferToken } = accounts;

        let {
            reservedSequence,
            auction,
            executorToken,
            initialOfferToken,
            initialParticipant,
            reserveBeneficiary,
        } = accounts;
        let { sourceChain, orderSender, sequence } = opts;
        executorToken ??= splToken.getAssociatedTokenAddressSync(this.mint, payer);

        if (
            auction === undefined ||
            reservedSequence === undefined ||
            sourceChain === undefined ||
            orderSender === undefined
        ) {
            const fastVaaAccount = await VaaAccount.fetch(connection, fastVaa);
            const fastVaaHash = fastVaaAccount.digest();
            auction ??= this.auctionAddress(fastVaaHash);
            reservedSequence ??= this.reservedFastFillSequenceAddress(fastVaaHash);
            sourceChain ??= fastVaaAccount.emitterInfo().chain;

            const { fastMarketOrder } = LiquidityLayerMessage.decode(fastVaaAccount.payload());
            if (fastMarketOrder === undefined) {
                throw new Error("Message not FastMarketOrder");
            }
            orderSender ??= Array.from(fastMarketOrder.sender.toUint8Array());
        }

        if (sequence === undefined || reserveBeneficiary === undefined) {
            const reservedData = await this.fetchReservedFastFillSequence({
                address: reservedSequence,
            });
            sequence ??= reservedData.fastFillSeeds.sequence;
            reserveBeneficiary ??= reservedData.beneficiary;
        }

        let auctionInfo: AuctionInfo | undefined;
        if (initialOfferToken === undefined || initialParticipant === undefined) {
            const { preparedBy, info } = await this.fetchAuction({ address: auction });
            if (info === null) {
                throw new Error("no auction info found");
            }
            auctionInfo = info;
            initialOfferToken ??= auctionInfo.initialOfferToken;
            initialParticipant ??= preparedBy;
        }

        const activeAuction = await this.activeAuctionComposite(
            {
                auction,
                config: auctionConfig,
                bestOfferToken,
            },
            { auctionInfo },
        );

        return this.program.methods
            .executeFastOrderLocal()
            .accounts({
                payer,
                custodian: this.checkedCustodianComposite(),
                executeOrder: {
                    fastVaa: this.liquidityLayerVaaComposite(fastVaa),
                    activeAuction,
                    executorToken,
                    initialOfferToken,
                    initialParticipant,
                },
                reservedSequence,
                reserveBeneficiary,
                fastFill: this.fastFillAddress(sourceChain, orderSender, sequence),
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
                localCustodyToken: this.localCustodyTokenAddress(sourceChain),
                tokenProgram: splToken.TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                sysvars: this.requiredSysvarsComposite(),
            })
            .instruction();
    }

    async closeAuctionIx(accounts: {
        auction: PublicKey;
        beneficiary?: PublicKey;
    }): Promise<TransactionInstruction> {
        const { auction } = accounts;
        let { beneficiary } = accounts;

        if (beneficiary === undefined) {
            const { preparedBy } = await this.fetchAuction({ address: auction });
            beneficiary = preparedBy;
        }

        return this.program.methods
            .closeAuction()
            .accounts({
                auction,
                beneficiary,
                eventAuthority: this.eventAuthorityAddress(),
                program: this.ID,
            })
            .instruction();
    }

    async closeAuctionTx(
        accounts: { auction: PublicKey; beneficiary: PublicKey },
        signers: Signer[],
        opts: PreparedTransactionOptions,
        confirmOptions?: ConfirmOptions,
    ): Promise<PreparedTransaction> {
        const closeAuctionIx = await this.closeAuctionIx(accounts);

        return {
            ixs: [closeAuctionIx],
            signers,
            computeUnits: opts.computeUnits!,
            feeMicroLamports: opts.feeMicroLamports,
            nonceAccount: opts.nonceAccount,
            addressLookupTableAccounts: opts.addressLookupTableAccounts,
            txName: "closeAuction",
            confirmOptions,
        };
    }

    async redeemFastFillAccounts(fastFill: PublicKey): Promise<RedeemFastFillAccounts> {
        const {
            seeds: { sourceChain },
        } = await this.fetchFastFill({ address: fastFill });

        if (!isChainId(sourceChain)) {
            throw new Error("invalid source chain");
        }

        return {
            custodian: this.custodianAddress(),
            fromRouterEndpoint: this.routerEndpointAddress(sourceChain),
            toRouterEndpoint: this.routerEndpointAddress(toChainId("Solana")),
            localCustodyToken: this.localCustodyTokenAddress(sourceChain),
            eventAuthority: this.eventAuthorityAddress(),
            matchingEngineProgram: this.ID,
        };
    }

    async publishMessageAccounts(auction: PublicKey): Promise<PublishMessageAccounts> {
        const coreMessage = this.coreMessageAddress(auction);

        const coreBridgeProgram = this.coreBridgeProgramId();
        const custodian = this.custodianAddress();

        return {
            custodian,
            coreMessage,
            coreBridgeConfig: PublicKey.findProgramAddressSync(
                [Buffer.from("Bridge")],
                coreBridgeProgram,
            )[0],
            coreEmitterSequence: PublicKey.findProgramAddressSync(
                [Buffer.from("Sequence"), custodian.toBuffer()],
                coreBridgeProgram,
            )[0],
            coreFeeCollector: PublicKey.findProgramAddressSync(
                [Buffer.from("fee_collector")],
                coreBridgeProgram,
            )[0],
            coreBridgeProgram,
        };
    }

    async burnAndPublishAccounts(
        auction: PublicKey,
        args: {
            targetChain: ChainId;
            destinationCctpDomain?: number;
        },
    ): Promise<BurnAndPublishAccounts> {
        const { targetChain } = args;

        let { destinationCctpDomain } = args;

        if (destinationCctpDomain === undefined) {
            const { protocol } = await this.fetchRouterEndpointInfo(targetChain);
            if (protocol.cctp === undefined) {
                throw new Error("not CCTP endpoint");
            }
            destinationCctpDomain = protocol.cctp.domain;
        }

        const {
            senderAuthority: tokenMessengerMinterSenderAuthority,
            messageTransmitterConfig,
            tokenMessenger,
            remoteTokenMessenger,
            tokenMinter,
            localToken,
            tokenMessengerMinterEventAuthority,
            messageTransmitterProgram,
            tokenMessengerMinterProgram,
        } = this.tokenMessengerMinterProgram().depositForBurnWithCallerAccounts(
            this.mint,
            destinationCctpDomain,
        );

        const {
            custodian,
            coreMessage,
            coreBridgeConfig,
            coreEmitterSequence,
            coreFeeCollector,
            coreBridgeProgram,
        } = await this.publishMessageAccounts(auction);

        return {
            custodian,
            routerEndpoint: this.routerEndpointAddress(targetChain),
            coreMessage,
            cctpMessage: this.cctpMessageAddress(auction),
            coreBridgeConfig,
            coreEmitterSequence,
            coreFeeCollector,
            coreBridgeProgram,
            tokenMessengerMinterSenderAuthority,
            messageTransmitterConfig,
            tokenMessenger,
            remoteTokenMessenger,
            tokenMinter,
            localToken,
            tokenMessengerMinterEventAuthority,
            messageTransmitterProgram,
            tokenMessengerMinterProgram,
        };
    }

    upgradeManagerProgram(): UpgradeManagerProgram {
        switch (this._programId) {
            case mainnet(): {
                return new UpgradeManagerProgram(
                    this.program.provider.connection,
                    "4jyJ7EEsYa72REdD8ZMBvHFTXZ4VYGQPUHaJTajsK8SN",
                );
            }
            case testnet(): {
                return new UpgradeManagerProgram(
                    this.program.provider.connection,
                    "ucdP9ktgrXgEUnn6roqD2SfdGMR2JSiWHUKv23oXwxt",
                );
            }
            case localnet(): {
                return new UpgradeManagerProgram(
                    this.program.provider.connection,
                    "UpgradeManager11111111111111111111111111111",
                );
            }
            default: {
                throw new Error("unsupported network");
            }
        }
    }

    tokenMessengerMinterProgram(): TokenMessengerMinterProgram {
        return new TokenMessengerMinterProgram(this.program.provider.connection);
    }

    messageTransmitterProgram(): MessageTransmitterProgram {
        return new MessageTransmitterProgram(this.program.provider.connection);
    }

    coreBridgeProgramId(): PublicKey {
        switch (this._programId) {
            case mainnet(): {
                return new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");
            }
            case testnet(): {
                return new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
            }
            case localnet(): {
                return new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");
            }
            default: {
                throw new Error("unsupported network");
            }
        }
    }

    async computeDepositPenalty(
        auctionInfo: AuctionInfo,
        currentSlot: Uint64,
        configId?: number,
    ): Promise<{ penalty: bigint; userReward: bigint }> {
        const auctionParams = await this.fetchAuctionParameters(configId);

        const gracePeriod = BigInt(auctionParams.gracePeriod);
        const slotsElapsed =
            uint64ToBigInt(currentSlot) -
            uint64ToBigInt(auctionInfo.startSlot) -
            BigInt(auctionParams.duration);
        if (slotsElapsed <= gracePeriod) {
            return { penalty: 0n, userReward: 0n };
        }

        const amount = uint64ToBigInt(auctionInfo.securityDeposit);

        const penaltyPeriod = slotsElapsed - gracePeriod;
        const auctionPenaltySlots = BigInt(auctionParams.penaltyPeriod);
        const initialPenaltyBps = BigInt(auctionParams.initialPenaltyBps);
        const userPenaltyRewardBps = BigInt(auctionParams.userPenaltyRewardBps);

        if (penaltyPeriod >= auctionPenaltySlots || initialPenaltyBps == FEE_PRECISION_MAX) {
            const userReward = (amount * userPenaltyRewardBps) / FEE_PRECISION_MAX;
            return { penalty: amount - userReward, userReward };
        } else {
            const basePenalty = (amount * initialPenaltyBps) / FEE_PRECISION_MAX;
            const penalty =
                basePenalty + ((amount - basePenalty) * penaltyPeriod) / auctionPenaltySlots;
            const userReward = (penalty * userPenaltyRewardBps) / FEE_PRECISION_MAX;

            return { penalty: penalty - userReward, userReward };
        }
    }

    async computeMinOfferDelta(offerPrice: Uint64): Promise<bigint> {
        const { minOfferDeltaBps } = await this.fetchAuctionParameters();
        return (uint64ToBigInt(offerPrice) * BigInt(minOfferDeltaBps)) / FEE_PRECISION_MAX + 1n;
    }

    async computeNotionalSecurityDeposit(amountIn: Uint64, configId?: number) {
        const { securityDepositBase, securityDepositBps } = await this.fetchAuctionParameters(
            configId,
        );
        return (
            uint64ToBigInt(securityDepositBase) +
            (uint64ToBigInt(amountIn) * BigInt(securityDepositBps)) / FEE_PRECISION_MAX
        );
    }
}

export function mainnet(): ProgramId {
    return "HtkeCDdYY4i9ncAxXKjYTx8Uu3WM8JbtiLRYjtHwaVXb";
}

export function testnet(): ProgramId {
    return "mPydpGUWxzERTNpyvTKdvS7v8kvw5sgwfiP8WQFrXVS";
}

export function localnet(): ProgramId {
    return "MatchingEngine11111111111111111111111111111";
}
