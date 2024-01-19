import * as wormholeSdk from "@certusone/wormhole-sdk";
import * as splToken from "@solana/spl-token";
import {
    AddressLookupTableProgram,
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    SYSVAR_RENT_PUBKEY,
    SystemProgram,
} from "@solana/web3.js";
import { use as chaiUse, expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { CctpTokenBurnMessage, Fill, LiquidityLayerDeposit, LiquidityLayerMessage } from "../src";
import { Custodian, RouterEndpoint, TokenRouterProgram } from "../src/tokenRouter";
import {
    CircleAttester,
    ETHEREUM_USDC_ADDRESS,
    LOCALHOST,
    MOCK_GUARDIANS,
    OWNER_ASSISTANT_KEYPAIR,
    PAYER_KEYPAIR,
    USDC_MINT_ADDRESS,
    expectIxErr,
    expectIxOk,
    postLiquidityLayerVaa,
} from "./helpers";

chaiUse(chaiAsPromised);

describe("Token Router", function () {
    const connection = new Connection(LOCALHOST, "processed");
    // payer is also the recipient in all tests
    const payer = PAYER_KEYPAIR;
    const relayer = Keypair.generate();
    const owner = Keypair.generate();
    const ownerAssistant = OWNER_ASSISTANT_KEYPAIR;

    const foreignChain = wormholeSdk.CHAINS.ethereum;
    const invalidChain = (foreignChain + 1) as wormholeSdk.ChainId;
    const foreignEndpointAddress = Array.from(Buffer.alloc(32, "deadbeef", "hex"));
    const foreignCctpDomain = 0;
    const unregisteredContractAddress = Buffer.alloc(32, "deafbeef", "hex");
    const tokenRouter = new TokenRouterProgram(connection);

    let lookupTableAddress: PublicKey;

    describe("Admin", function () {
        describe("Initialize", function () {
            it("Cannot Initialize without USDC Mint", async function () {
                const mint = await splToken.createMint(connection, payer, payer.publicKey, null, 6);

                const ix = await tokenRouter.initializeIx({
                    owner: payer.publicKey,
                    ownerAssistant: ownerAssistant.publicKey,
                    mint,
                });
                await expectIxErr(connection, [ix], [payer], "Error Code: NotUsdc");
            });

            it("Cannot Initialize with Default Owner Assistant", async function () {
                const ix = await tokenRouter.initializeIx({
                    owner: payer.publicKey,
                    ownerAssistant: PublicKey.default,
                    mint: USDC_MINT_ADDRESS,
                });

                await expectIxErr(connection, [ix], [payer], "Error Code: AssistantZeroPubkey");
            });

            it("Initialize", async function () {
                const ix = await tokenRouter.initializeIx({
                    owner: payer.publicKey,
                    ownerAssistant: ownerAssistant.publicKey,
                    mint: USDC_MINT_ADDRESS,
                });

                await expectIxOk(connection, [ix], [payer]);

                const custodianData = await tokenRouter.fetchCustodian(
                    tokenRouter.custodianAddress()
                );
                expect(custodianData).to.eql(
                    new Custodian(
                        253, // bump
                        254, // custodyTokenBump
                        false, // paused
                        payer.publicKey, // owner
                        null, // pendingOwner
                        ownerAssistant.publicKey,
                        payer.publicKey // pausedSetBy
                    )
                );

                const { amount } = await splToken.getAccount(
                    connection,
                    tokenRouter.custodyTokenAccountAddress()
                );
                expect(amount).to.equal(0n);
            });

            it("Cannot Initialize Again", async function () {
                const ix = await tokenRouter.initializeIx({
                    owner: payer.publicKey,
                    ownerAssistant: ownerAssistant.publicKey,
                    mint: USDC_MINT_ADDRESS,
                });

                await expectIxErr(
                    connection,
                    [ix],
                    [payer],
                    `Allocate: account Address { address: ${tokenRouter
                        .custodianAddress()
                        .toString()}, base: None } already in use`
                );
            });

            after("Setup Lookup Table", async function () {
                // Create.
                const [createIx, lookupTable] = await connection.getSlot("finalized").then((slot) =>
                    AddressLookupTableProgram.createLookupTable({
                        authority: payer.publicKey,
                        payer: payer.publicKey,
                        recentSlot: slot,
                    })
                );

                await expectIxOk(connection, [createIx], [payer]);

                const usdcCommonAccounts = tokenRouter.commonAccounts(USDC_MINT_ADDRESS);

                // Extend.
                const extendIx = AddressLookupTableProgram.extendLookupTable({
                    payer: payer.publicKey,
                    authority: payer.publicKey,
                    lookupTable,
                    addresses: Object.values(usdcCommonAccounts).filter((key) => key !== undefined),
                });

                await expectIxOk(connection, [extendIx], [payer], {
                    confirmOptions: { commitment: "finalized" },
                });

                lookupTableAddress = lookupTable;
            });

            after("Transfer Lamports to Owner and Owner Assistant", async function () {
                await expectIxOk(
                    connection,
                    [
                        SystemProgram.transfer({
                            fromPubkey: payer.publicKey,
                            toPubkey: owner.publicKey,
                            lamports: 1000000000,
                        }),
                        SystemProgram.transfer({
                            fromPubkey: payer.publicKey,
                            toPubkey: ownerAssistant.publicKey,
                            lamports: 1000000000,
                        }),
                        SystemProgram.transfer({
                            fromPubkey: payer.publicKey,
                            toPubkey: relayer.publicKey,
                            lamports: 1000000000,
                        }),
                    ],
                    [payer]
                );
            });
        });

        describe("Ownership Transfer Request", async function () {
            it("Submit Ownership Transfer Request as Payer to Owner Pubkey", async function () {
                const ix = await tokenRouter.submitOwnershipTransferIx({
                    owner: payer.publicKey,
                    newOwner: owner.publicKey,
                });

                await expectIxOk(connection, [ix], [payer]);

                // Confirm that the pending owner variable is set in the owner config.
                const { pendingOwner } = await tokenRouter.fetchCustodian(
                    tokenRouter.custodianAddress()
                );

                expect(pendingOwner).deep.equals(owner.publicKey);
            });

            it("Cannot Cancel Ownership Request as Non-Owner", async function () {
                const ix = await tokenRouter.cancelOwnershipTransferIx({
                    owner: ownerAssistant.publicKey,
                });

                await expectIxErr(connection, [ix], [ownerAssistant], "Error Code: OwnerOnly");
            });

            it("Cancel Ownership Request as Payer", async function () {
                const ix = await tokenRouter.cancelOwnershipTransferIx({
                    owner: payer.publicKey,
                });

                await expectIxOk(connection, [ix], [payer]);

                // Confirm the pending owner field was reset.
                const { pendingOwner } = await tokenRouter.fetchCustodian(
                    tokenRouter.custodianAddress()
                );
                expect(pendingOwner).deep.equals(null);
            });

            it("Submit Ownership Transfer Request as Payer Again to Owner Pubkey", async function () {
                const ix = await tokenRouter.submitOwnershipTransferIx({
                    owner: payer.publicKey,
                    newOwner: owner.publicKey,
                });

                await expectIxOk(connection, [ix], [payer]);

                // Confirm that the pending owner variable is set in the owner config.
                const { pendingOwner } = await tokenRouter.fetchCustodian(
                    tokenRouter.custodianAddress()
                );

                expect(pendingOwner).deep.equals(owner.publicKey);
            });

            it("Cannot Confirm Ownership Transfer Request as Non-Pending Owner", async function () {
                const ix = await tokenRouter.confirmOwnershipTransferIx({
                    pendingOwner: ownerAssistant.publicKey,
                });

                await expectIxErr(
                    connection,
                    [ix],
                    [ownerAssistant],
                    "Error Code: NotPendingOwner"
                );
            });

            it("Confirm Ownership Transfer Request as Pending Owner", async function () {
                const ix = await tokenRouter.confirmOwnershipTransferIx({
                    pendingOwner: owner.publicKey,
                });

                await expectIxOk(connection, [ix], [owner]);

                // Confirm that the owner config reflects the current ownership status.
                {
                    const { owner: actualOwner, pendingOwner } = await tokenRouter.fetchCustodian(
                        tokenRouter.custodianAddress()
                    );
                    expect(actualOwner).deep.equals(owner.publicKey);
                    expect(pendingOwner).deep.equals(null);
                }
            });

            it("Cannot Submit Ownership Transfer Request to Default Pubkey", async function () {
                const ix = await tokenRouter.submitOwnershipTransferIx({
                    owner: owner.publicKey,
                    newOwner: PublicKey.default,
                });

                await expectIxErr(connection, [ix], [owner], "Error Code: InvalidNewOwner");
            });

            it("Cannot Submit Ownership Transfer Request to Himself", async function () {
                const ix = await tokenRouter.submitOwnershipTransferIx({
                    owner: owner.publicKey,
                    newOwner: owner.publicKey,
                });

                await expectIxErr(connection, [ix], [owner], "Error Code: AlreadyOwner");
            });

            it("Cannot Submit Ownership Transfer Request as Non-Owner", async function () {
                const ix = await tokenRouter.submitOwnershipTransferIx({
                    owner: ownerAssistant.publicKey,
                    newOwner: relayer.publicKey,
                });

                await expectIxErr(connection, [ix], [ownerAssistant], "Error Code: OwnerOnly");
            });
        });

        describe("Update Owner Assistant", async function () {
            it("Cannot Update Assistant to Default Pubkey", async function () {
                const ix = await tokenRouter.updateOwnerAssistantIx({
                    owner: owner.publicKey,
                    newOwnerAssistant: PublicKey.default,
                });

                await expectIxErr(connection, [ix], [owner], "Error Code: InvalidNewAssistant");
            });

            it("Cannot Update Assistant as Non-Owner", async function () {
                const ix = await tokenRouter.updateOwnerAssistantIx({
                    owner: ownerAssistant.publicKey,
                    newOwnerAssistant: relayer.publicKey,
                });

                await expectIxErr(connection, [ix], [ownerAssistant], "Error Code: OwnerOnly");
            });

            it("Update Assistant as Owner", async function () {
                const ix = await tokenRouter.updateOwnerAssistantIx({
                    owner: owner.publicKey,
                    newOwnerAssistant: relayer.publicKey,
                });

                await expectIxOk(connection, [ix], [payer, owner]);

                // Confirm the assistant field was updated.
                const { ownerAssistant: actualOwnerAssistant } = await tokenRouter.fetchCustodian(
                    tokenRouter.custodianAddress()
                );
                expect(actualOwnerAssistant).to.eql(relayer.publicKey);

                // Set the assistant back to the assistant key.
                await expectIxOk(
                    connection,
                    [
                        await tokenRouter.updateOwnerAssistantIx({
                            owner: owner.publicKey,
                            newOwnerAssistant: ownerAssistant.publicKey,
                        }),
                    ],
                    [owner]
                );
            });
        });

        describe("Add CCTP Router Endpoint", function () {
            const expectedEndpointBump = 255;

            it("Cannot Add CCTP Router Endpoint as Non-Owner and Non-Assistant", async function () {
                const ix = await tokenRouter.addCctpRouterEndpointIx(
                    {
                        ownerOrAssistant: payer.publicKey,
                    },
                    {
                        chain: foreignChain,
                        address: foreignEndpointAddress,
                        cctpDomain: foreignCctpDomain,
                        mintRecipient: null,
                    }
                );

                await expectIxErr(connection, [ix], [payer], "Error Code: OwnerOrAssistantOnly");
            });

            [wormholeSdk.CHAINS.unset, wormholeSdk.CHAINS.solana].forEach((chain) =>
                it(`Cannot Register Chain ID == ${chain}`, async function () {
                    const ix = await tokenRouter.addCctpRouterEndpointIx(
                        {
                            ownerOrAssistant: ownerAssistant.publicKey,
                        },
                        {
                            chain,
                            address: foreignEndpointAddress,
                            cctpDomain: foreignCctpDomain,
                            mintRecipient: null,
                        }
                    );

                    await expectIxErr(
                        connection,
                        [ix],
                        [ownerAssistant],
                        "Error Code: ChainNotAllowed"
                    );
                })
            );

            it("Cannot Register Zero Address", async function () {
                const ix = await tokenRouter.addCctpRouterEndpointIx(
                    {
                        ownerOrAssistant: owner.publicKey,
                    },
                    {
                        chain: foreignChain,
                        address: new Array(32).fill(0),
                        cctpDomain: foreignCctpDomain,
                        mintRecipient: null,
                    }
                );

                await expectIxErr(connection, [ix], [owner], "Error Code: InvalidEndpoint");
            });

            it(`Add CCTP Router Endpoint as Owner Assistant`, async function () {
                const contractAddress = Array.from(Buffer.alloc(32, "fbadc0de", "hex"));
                const ix = await tokenRouter.addCctpRouterEndpointIx(
                    {
                        ownerOrAssistant: ownerAssistant.publicKey,
                    },
                    {
                        chain: foreignChain,
                        address: contractAddress,
                        cctpDomain: foreignCctpDomain,
                        mintRecipient: null,
                    }
                );

                await expectIxOk(connection, [ix], [ownerAssistant]);

                const routerEndpointData = await tokenRouter.fetchRouterEndpoint(
                    tokenRouter.routerEndpointAddress(foreignChain)
                );
                expect(routerEndpointData).to.eql(
                    new RouterEndpoint(
                        expectedEndpointBump,
                        foreignChain,
                        contractAddress,
                        contractAddress,
                        { cctp: { domain: foreignCctpDomain } } // protocol
                    )
                );
            });

            it(`Update Router Endpoint as Owner`, async function () {
                const ix = await tokenRouter.addCctpRouterEndpointIx(
                    {
                        ownerOrAssistant: owner.publicKey,
                    },
                    {
                        chain: foreignChain,
                        address: foreignEndpointAddress,
                        cctpDomain: foreignCctpDomain,
                        mintRecipient: null,
                    }
                );

                await expectIxOk(connection, [ix], [owner]);

                const routerEndpointData = await tokenRouter.fetchRouterEndpoint(
                    tokenRouter.routerEndpointAddress(foreignChain)
                );
                expect(routerEndpointData).to.eql(
                    new RouterEndpoint(
                        expectedEndpointBump,
                        foreignChain,
                        foreignEndpointAddress,
                        foreignEndpointAddress,
                        { cctp: { domain: foreignCctpDomain } } // protocol
                    )
                );
            });
        });

        describe("Set Pause", async function () {
            it("Cannot Set Pause for Transfers as Non-Owner", async function () {
                const ix = await tokenRouter.setPauseIx(
                    {
                        ownerOrAssistant: payer.publicKey,
                    },
                    true // paused
                );

                await expectIxErr(connection, [ix], [payer], "Error Code: OwnerOrAssistantOnly");
            });

            it("Set Paused == true as Owner Assistant", async function () {
                const paused = true;
                const ix = await tokenRouter.setPauseIx(
                    {
                        ownerOrAssistant: ownerAssistant.publicKey,
                    },
                    paused
                );

                await expectIxOk(connection, [ix], [ownerAssistant]);

                const { paused: actualPaused, pausedSetBy } = await tokenRouter.fetchCustodian(
                    tokenRouter.custodianAddress()
                );
                expect(actualPaused).equals(paused);
                expect(pausedSetBy).eql(ownerAssistant.publicKey);
            });

            it("Set Paused == false as Owner", async function () {
                const paused = false;
                const ix = await tokenRouter.setPauseIx(
                    {
                        ownerOrAssistant: owner.publicKey,
                    },
                    paused
                );

                await expectIxOk(connection, [ix], [owner]);

                const { paused: actualPaused, pausedSetBy } = await tokenRouter.fetchCustodian(
                    tokenRouter.custodianAddress()
                );
                expect(actualPaused).equals(paused);
                expect(pausedSetBy).eql(owner.publicKey);
            });
        });
    });

    describe("Business Logic", function () {
        describe("Place Market Order (CCTP)", function () {
            const payerToken = splToken.getAssociatedTokenAddressSync(
                USDC_MINT_ADDRESS,
                payer.publicKey
            );
            const burnSourceAuthority = Keypair.generate();

            before("Set Up Arbitrary Burn Source", async function () {
                const burnSource = await splToken.createAccount(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    burnSourceAuthority.publicKey
                );

                // Add funds to account.
                await splToken.mintTo(
                    connection,
                    payer,
                    USDC_MINT_ADDRESS,
                    burnSource,
                    payer,
                    1_000_000_000n // 1,000 USDC
                );
            });

            it("Cannot Place Market Order with Unregistered Endpoint", async function () {
                const amountIn = 69n;
                const unregisteredEndpoint = tokenRouter.routerEndpointAddress(
                    wormholeSdk.CHAIN_ID_SOLANA
                );
                const ix = await tokenRouter.placeMarketOrderCctpIx(
                    {
                        payer: payer.publicKey,
                        mint: USDC_MINT_ADDRESS,
                        burnSource: payerToken,
                        burnSourceAuthority: payer.publicKey,
                        routerEndpoint: unregisteredEndpoint,
                    },
                    {
                        amountIn,
                        targetChain: foreignChain,
                        redeemer: Array.from(Buffer.alloc(32, "deadbeef", "hex")),
                        redeemerMessage: Buffer.from("All your base are belong to us"),
                    }
                );

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxErr(connection, [ix], [payer], "Error Code: AccountNotInitialized", {
                    addressLookupTableAccounts: [lookupTableAccount!],
                });
            });

            it("Cannot Place Market Order with Insufficient Amount", async function () {
                const ix = await tokenRouter.placeMarketOrderCctpIx(
                    {
                        payer: payer.publicKey,
                        mint: USDC_MINT_ADDRESS,
                        burnSource: payerToken,
                        burnSourceAuthority: payer.publicKey,
                    },
                    {
                        amountIn: 0n,
                        targetChain: foreignChain,
                        redeemer: Array.from(Buffer.alloc(32, "deadbeef", "hex")),
                        redeemerMessage: Buffer.from("All your base are belong to us"),
                    }
                );

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxErr(connection, [ix], [payer], "Error Code: InsufficientAmount", {
                    addressLookupTableAccounts: [lookupTableAccount!],
                });
            });

            it("Cannot Place Market Order with Invalid Redeemer", async function () {
                const amountIn = 69n;
                const ix = await tokenRouter.placeMarketOrderCctpIx(
                    {
                        payer: payer.publicKey,
                        mint: USDC_MINT_ADDRESS,
                        burnSource: payerToken,
                        burnSourceAuthority: payer.publicKey,
                    },
                    {
                        amountIn,
                        targetChain: foreignChain,
                        redeemer: new Array(32).fill(0),
                        redeemerMessage: Buffer.from("All your base are belong to us"),
                    }
                );

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxErr(connection, [ix], [payer], "Error Code: InvalidRedeemer", {
                    addressLookupTableAccounts: [lookupTableAccount!],
                });
            });

            it("Cannot Place Market Order as Invalid Burn Source Authority", async function () {
                const burnSourceAuthority = Keypair.generate();

                const amountIn = 69n;
                const ix = await tokenRouter.placeMarketOrderCctpIx(
                    {
                        payer: payer.publicKey,
                        mint: USDC_MINT_ADDRESS,
                        burnSource: payerToken,
                        burnSourceAuthority: burnSourceAuthority.publicKey,
                    },
                    {
                        amountIn,
                        targetChain: foreignChain,
                        redeemer: Array.from(Buffer.alloc(32, "deadbeef", "hex")),
                        redeemerMessage: Buffer.from("All your base are belong to us"),
                    }
                );

                // NOTE: This error comes from the SPL Token program.
                await expectIxErr(
                    connection,
                    [ix],
                    [payer, burnSourceAuthority],
                    "Error: owner does not match"
                );
            });

            it("Place Market Order as Burn Source Authority", async function () {
                const burnSource = splToken.getAssociatedTokenAddressSync(
                    USDC_MINT_ADDRESS,
                    burnSourceAuthority.publicKey
                );
                const amountIn = 69n;
                const ix = await tokenRouter.placeMarketOrderCctpIx(
                    {
                        payer: payer.publicKey,
                        mint: USDC_MINT_ADDRESS,
                        burnSource,
                        burnSourceAuthority: burnSourceAuthority.publicKey,
                    },
                    {
                        amountIn,
                        targetChain: foreignChain,
                        redeemer: Array.from(Buffer.alloc(32, "deadbeef", "hex")),
                        redeemerMessage: Buffer.from("All your base are belong to us"),
                    }
                );

                const { amount: balanceBefore } = await splToken.getAccount(connection, burnSource);

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxOk(connection, [ix], [payer, burnSourceAuthority], {
                    addressLookupTableAccounts: [lookupTableAccount!],
                });

                // Check balance.
                const { amount: balanceAfter } = await splToken.getAccount(connection, burnSource);
                expect(balanceAfter + amountIn).equals(balanceBefore);

                // TODO: check message
            });

            it("Pause", async function () {
                const ix = await tokenRouter.setPauseIx(
                    {
                        ownerOrAssistant: owner.publicKey,
                    },
                    true // paused
                );

                await expectIxOk(connection, [ix], [owner]);
            });

            it("Cannot Place Market Order when Paused", async function () {
                const ix = await tokenRouter.placeMarketOrderCctpIx(
                    {
                        payer: payer.publicKey,
                        mint: USDC_MINT_ADDRESS,
                        burnSource: payerToken,
                        burnSourceAuthority: payer.publicKey,
                    },
                    {
                        amountIn: 69n,
                        targetChain: foreignChain,
                        redeemer: Array.from(Buffer.alloc(32, "deadbeef", "hex")),
                        redeemerMessage: Buffer.from("All your base are belong to us"),
                    }
                );

                await expectIxErr(connection, [ix], [payer], "Error Code: Paused");
            });

            it("Unpause", async function () {
                const ix = await tokenRouter.setPauseIx(
                    {
                        ownerOrAssistant: ownerAssistant.publicKey,
                    },
                    false // paused
                );

                await expectIxOk(connection, [ix], [ownerAssistant]);
            });

            it("Place Market Order after Unpaused", async function () {
                const amountIn = 69n;
                const ix = await tokenRouter.placeMarketOrderCctpIx(
                    {
                        payer: payer.publicKey,
                        mint: USDC_MINT_ADDRESS,
                        burnSource: payerToken,
                        burnSourceAuthority: payer.publicKey,
                    },
                    {
                        amountIn,
                        targetChain: foreignChain,
                        redeemer: Array.from(Buffer.alloc(32, "deadbeef", "hex")),
                        redeemerMessage: Buffer.from("All your base are belong to us"),
                    }
                );

                const { amount: balanceBefore } = await splToken.getAccount(connection, payerToken);

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxOk(connection, [ix], [payer], {
                    addressLookupTableAccounts: [lookupTableAccount!],
                });

                // Check balance.
                const { amount: balanceAfter } = await splToken.getAccount(connection, payerToken);
                expect(balanceAfter + amountIn).equals(balanceBefore);

                // TODO: check message
            });
        });

        describe("Redeem Fill (CCTP)", function () {
            const payerToken = splToken.getAssociatedTokenAddressSync(
                USDC_MINT_ADDRESS,
                payer.publicKey
            );

            let testCctpNonce = 2n ** 64n - 1n;

            // Hack to prevent math overflow error when invoking CCTP programs.
            testCctpNonce -= 2n * 6400n;

            let wormholeSequence = 0n;

            const localVariables = new Map<string, any>();

            it("Cannot Redeem Fill with Invalid VAA Account (Not Owned by Core Bridge)", async function () {
                const redeemer = Keypair.generate();

                const encodedMintRecipient = Array.from(
                    tokenRouter.custodyTokenAccountAddress().toBuffer()
                );
                const sourceCctpDomain = 0;
                const cctpNonce = testCctpNonce++;
                const amount = 69n;

                // Concoct a Circle message.
                const burnSource = Array.from(Buffer.alloc(32, "beefdead", "hex"));
                const { encodedCctpMessage, cctpAttestation } = await craftCctpTokenBurnMessage(
                    tokenRouter,
                    sourceCctpDomain,
                    cctpNonce,
                    encodedMintRecipient,
                    amount,
                    burnSource
                );
                const vaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    foreignEndpointAddress,
                    wormholeSequence++,
                    Buffer.from("Oh noes!")
                );

                const ix = await tokenRouter.redeemCctpFillIx(
                    {
                        payer: payer.publicKey,
                        vaa,
                        redeemer: redeemer.publicKey,
                        dstToken: payerToken,
                    },
                    {
                        encodedCctpMessage,
                        cctpAttestation,
                    }
                );

                // Replace the VAA account pubkey with garbage.
                ix.keys[ix.keys.findIndex((key) => key.pubkey.equals(vaa))].pubkey =
                    SYSVAR_RENT_PUBKEY;

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxErr(
                    connection,
                    [ix],
                    [payer, redeemer],
                    "Error Code: ConstraintOwner",
                    {
                        addressLookupTableAccounts: [lookupTableAccount!],
                    }
                );
            });

            it("Cannot Redeem Fill from Invalid Source Router Chain", async function () {
                const redeemer = Keypair.generate();

                const encodedMintRecipient = Array.from(
                    tokenRouter.custodyTokenAccountAddress().toBuffer()
                );
                const sourceCctpDomain = 0;
                const cctpNonce = testCctpNonce++;
                const amount = 69n;

                // Concoct a Circle message.
                const burnSource = Array.from(Buffer.alloc(32, "beefdead", "hex"));
                const { destinationCctpDomain, burnMessage, encodedCctpMessage, cctpAttestation } =
                    await craftCctpTokenBurnMessage(
                        tokenRouter,
                        sourceCctpDomain,
                        cctpNonce,
                        encodedMintRecipient,
                        amount,
                        burnSource
                    );

                const message = new LiquidityLayerMessage({
                    deposit: new LiquidityLayerDeposit(
                        {
                            tokenAddress: burnMessage.burnTokenAddress,
                            amount,
                            sourceCctpDomain,
                            destinationCctpDomain,
                            cctpNonce,
                            burnSource,
                            mintRecipient: encodedMintRecipient,
                        },
                        {
                            slowOrderResponse: {
                                baseFee: 69n,
                            },
                        }
                    ),
                });

                const vaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    foreignEndpointAddress,
                    wormholeSequence++,
                    message,
                    "polygon"
                );
                const ix = await tokenRouter.redeemCctpFillIx(
                    {
                        payer: payer.publicKey,
                        vaa,
                        redeemer: redeemer.publicKey,
                        dstToken: payerToken,
                        routerEndpoint: tokenRouter.routerEndpointAddress(foreignChain),
                    },
                    {
                        encodedCctpMessage,
                        cctpAttestation,
                    }
                );

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxErr(
                    connection,
                    [ix],
                    [payer, redeemer],
                    "Error Code: InvalidSourceRouter",
                    {
                        addressLookupTableAccounts: [lookupTableAccount!],
                    }
                );
            });

            it("Cannot Redeem Fill from Invalid Source Router Address", async function () {
                const redeemer = Keypair.generate();

                const encodedMintRecipient = Array.from(
                    tokenRouter.custodyTokenAccountAddress().toBuffer()
                );
                const sourceCctpDomain = 0;
                const cctpNonce = testCctpNonce++;
                const amount = 69n;

                // Concoct a Circle message.
                const burnSource = Array.from(Buffer.alloc(32, "beefdead", "hex"));
                const { destinationCctpDomain, burnMessage, encodedCctpMessage, cctpAttestation } =
                    await craftCctpTokenBurnMessage(
                        tokenRouter,
                        sourceCctpDomain,
                        cctpNonce,
                        encodedMintRecipient,
                        amount,
                        burnSource
                    );

                const message = new LiquidityLayerMessage({
                    deposit: new LiquidityLayerDeposit(
                        {
                            tokenAddress: burnMessage.burnTokenAddress,
                            amount,
                            sourceCctpDomain,
                            destinationCctpDomain,
                            cctpNonce,
                            burnSource,
                            mintRecipient: encodedMintRecipient,
                        },
                        {
                            slowOrderResponse: {
                                baseFee: 69n,
                            },
                        }
                    ),
                });

                const vaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    new Array(32).fill(0), // emitter address
                    wormholeSequence++,
                    message
                );
                const ix = await tokenRouter.redeemCctpFillIx(
                    {
                        payer: payer.publicKey,
                        vaa,
                        redeemer: redeemer.publicKey,
                        dstToken: payerToken,
                    },
                    {
                        encodedCctpMessage,
                        cctpAttestation,
                    }
                );

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxErr(
                    connection,
                    [ix],
                    [payer, redeemer],
                    "Error Code: InvalidSourceRouter",
                    {
                        addressLookupTableAccounts: [lookupTableAccount!],
                    }
                );
            });

            it("Cannot Redeem Fill with Invalid Deposit Message", async function () {
                const redeemer = Keypair.generate();

                const encodedMintRecipient = Array.from(
                    tokenRouter.custodyTokenAccountAddress().toBuffer()
                );
                const sourceCctpDomain = 0;
                const cctpNonce = testCctpNonce++;
                const amount = 69n;

                // Concoct a Circle message.
                const burnSource = Array.from(Buffer.alloc(32, "beefdead", "hex"));
                const { destinationCctpDomain, burnMessage, encodedCctpMessage, cctpAttestation } =
                    await craftCctpTokenBurnMessage(
                        tokenRouter,
                        sourceCctpDomain,
                        cctpNonce,
                        encodedMintRecipient,
                        amount,
                        burnSource
                    );

                const message = new LiquidityLayerMessage({
                    deposit: new LiquidityLayerDeposit(
                        {
                            tokenAddress: burnMessage.burnTokenAddress,
                            amount,
                            sourceCctpDomain,
                            destinationCctpDomain,
                            cctpNonce,
                            burnSource,
                            mintRecipient: encodedMintRecipient,
                        },
                        {
                            slowOrderResponse: {
                                baseFee: 69n,
                            },
                        }
                    ),
                });

                // Override the payload ID in the deposit message.
                const encodedMessage = message.encode();
                encodedMessage[147] = 69;

                const vaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    foreignEndpointAddress,
                    wormholeSequence++,
                    encodedMessage
                );
                const ix = await tokenRouter.redeemCctpFillIx(
                    {
                        payer: payer.publicKey,
                        vaa,
                        redeemer: redeemer.publicKey,
                        dstToken: payerToken,
                    },
                    {
                        encodedCctpMessage,
                        cctpAttestation,
                    }
                );

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxErr(
                    connection,
                    [ix],
                    [payer, redeemer],
                    "Error Code: InvalidDepositMessage",
                    {
                        addressLookupTableAccounts: [lookupTableAccount!],
                    }
                );
            });

            it("Cannot Redeem Fill with Invalid Payload ID", async function () {
                const redeemer = Keypair.generate();

                const encodedMintRecipient = Array.from(
                    tokenRouter.custodyTokenAccountAddress().toBuffer()
                );
                const sourceCctpDomain = 0;
                const cctpNonce = testCctpNonce++;
                const amount = 69n;

                // Concoct a Circle message.
                const burnSource = Array.from(Buffer.alloc(32, "beefdead", "hex"));
                const { destinationCctpDomain, burnMessage, encodedCctpMessage, cctpAttestation } =
                    await craftCctpTokenBurnMessage(
                        tokenRouter,
                        sourceCctpDomain,
                        cctpNonce,
                        encodedMintRecipient,
                        amount,
                        burnSource
                    );

                const message = new LiquidityLayerMessage({
                    deposit: new LiquidityLayerDeposit(
                        {
                            tokenAddress: burnMessage.burnTokenAddress,
                            amount,
                            sourceCctpDomain,
                            destinationCctpDomain,
                            cctpNonce,
                            burnSource,
                            mintRecipient: encodedMintRecipient,
                        },
                        {
                            slowOrderResponse: {
                                baseFee: 69n,
                            },
                        }
                    ),
                });

                const vaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    foreignEndpointAddress,
                    wormholeSequence++,
                    message
                );
                const ix = await tokenRouter.redeemCctpFillIx(
                    {
                        payer: payer.publicKey,
                        vaa,
                        redeemer: redeemer.publicKey,
                        dstToken: payerToken,
                    },
                    {
                        encodedCctpMessage,
                        cctpAttestation,
                    }
                );

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxErr(
                    connection,
                    [ix],
                    [payer, redeemer],
                    "Error Code: InvalidPayloadId",
                    {
                        addressLookupTableAccounts: [lookupTableAccount!],
                    }
                );
            });

            it("Remove Router Endpoint", async function () {
                const ix = await tokenRouter.removeRouterEndpointIx(
                    {
                        ownerOrAssistant: ownerAssistant.publicKey,
                    },
                    foreignChain
                );

                await expectIxOk(connection, [ix], [ownerAssistant]);
            });

            it("Cannot Redeem Fill without Router Endpoint", async function () {
                const redeemer = Keypair.generate();

                const encodedMintRecipient = Array.from(
                    tokenRouter.custodyTokenAccountAddress().toBuffer()
                );
                const sourceCctpDomain = 0;
                const cctpNonce = testCctpNonce++;
                const amount = 69n;

                // Concoct a Circle message.
                const burnSource = Array.from(Buffer.alloc(32, "beefdead", "hex"));
                const { destinationCctpDomain, burnMessage, encodedCctpMessage, cctpAttestation } =
                    await craftCctpTokenBurnMessage(
                        tokenRouter,
                        sourceCctpDomain,
                        cctpNonce,
                        encodedMintRecipient,
                        amount,
                        burnSource
                    );

                const message = new LiquidityLayerMessage({
                    deposit: new LiquidityLayerDeposit(
                        {
                            tokenAddress: burnMessage.burnTokenAddress,
                            amount,
                            sourceCctpDomain,
                            destinationCctpDomain,
                            cctpNonce,
                            burnSource,
                            mintRecipient: encodedMintRecipient,
                        },
                        {
                            fill: {
                                sourceChain: foreignChain,
                                orderSender: Array.from(Buffer.alloc(32, "d00d", "hex")),
                                redeemer: Array.from(redeemer.publicKey.toBuffer()),
                                redeemerMessage: Buffer.from("Somebody set up us the bomb"),
                            },
                        }
                    ),
                });

                const vaa = await postLiquidityLayerVaa(
                    connection,
                    payer,
                    MOCK_GUARDIANS,
                    foreignEndpointAddress,
                    wormholeSequence++,
                    message
                );
                const ix = await tokenRouter.redeemCctpFillIx(
                    {
                        payer: payer.publicKey,
                        vaa,
                        redeemer: redeemer.publicKey,
                        dstToken: payerToken,
                    },
                    {
                        encodedCctpMessage,
                        cctpAttestation,
                    }
                );

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxErr(
                    connection,
                    [ix],
                    [payer, redeemer],
                    "Error Code: AccountNotInitialized",
                    {
                        addressLookupTableAccounts: [lookupTableAccount!],
                    }
                );

                // Save for later.
                localVariables.set("args", { encodedCctpMessage, cctpAttestation });
                localVariables.set("vaa", vaa);
                localVariables.set("redeemer", redeemer);
                localVariables.set("amount", amount);
            });

            it("Add Router Endpoint", async function () {
                const ix = await tokenRouter.addCctpRouterEndpointIx(
                    {
                        ownerOrAssistant: ownerAssistant.publicKey,
                    },
                    {
                        chain: foreignChain,
                        address: foreignEndpointAddress,
                        cctpDomain: foreignCctpDomain,
                        mintRecipient: null,
                    }
                );

                await expectIxOk(connection, [ix], [ownerAssistant]);
            });

            it("Cannot Redeem Fill with Invalid Redeemer", async function () {
                const args = localVariables.get("args") as {
                    encodedCctpMessage: Buffer;
                    cctpAttestation: Buffer;
                };
                const vaa = localVariables.get("vaa") as PublicKey;

                const redeemer = Keypair.generate();

                const ix = await tokenRouter.redeemCctpFillIx(
                    {
                        payer: payer.publicKey,
                        vaa,
                        redeemer: redeemer.publicKey,
                        dstToken: payerToken,
                    },
                    args
                );

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxErr(
                    connection,
                    [ix],
                    [payer, redeemer],
                    "Error Code: InvalidRedeemer",
                    {
                        addressLookupTableAccounts: [lookupTableAccount!],
                    }
                );
            });

            it("Redeem Fill", async function () {
                const args = localVariables.get("args") as {
                    encodedCctpMessage: Buffer;
                    cctpAttestation: Buffer;
                };
                const vaa = localVariables.get("vaa") as PublicKey;
                const redeemer = localVariables.get("redeemer") as Keypair;

                const amount = localVariables.get("amount") as bigint;
                expect(localVariables.delete("amount")).is.true;

                const ix = await tokenRouter.redeemCctpFillIx(
                    {
                        payer: payer.publicKey,
                        vaa,
                        redeemer: redeemer.publicKey,
                        dstToken: payerToken,
                    },
                    args
                );

                const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
                    units: 250_000,
                });

                const { amount: balanceBefore } = await splToken.getAccount(connection, payerToken);

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                await expectIxOk(connection, [computeIx, ix], [payer, redeemer], {
                    addressLookupTableAccounts: [lookupTableAccount!],
                });

                // Check balance.
                const { amount: balanceAfter } = await splToken.getAccount(connection, payerToken);
                expect(balanceAfter).equals(balanceBefore + amount);
            });

            it("Cannot Redeem Same Fill Again", async function () {
                const args = localVariables.get("args") as {
                    encodedCctpMessage: Buffer;
                    cctpAttestation: Buffer;
                };
                expect(localVariables.delete("args")).is.true;

                const vaa = localVariables.get("vaa") as PublicKey;
                expect(localVariables.delete("vaa")).is.true;

                const redeemer = localVariables.get("redeemer") as Keypair;
                expect(localVariables.delete("redeemer")).is.true;

                const ix = await tokenRouter.redeemCctpFillIx(
                    {
                        payer: payer.publicKey,
                        vaa,
                        redeemer: redeemer.publicKey,
                        dstToken: payerToken,
                    },
                    args
                );

                const { value: lookupTableAccount } = await connection.getAddressLookupTable(
                    lookupTableAddress
                );
                // NOTE: This is a CCTP Message Transmitter program error.
                await expectIxErr(
                    connection,
                    [ix],
                    [payer, redeemer],
                    "Error Code: NonceAlreadyUsed",
                    {
                        addressLookupTableAccounts: [lookupTableAccount!],
                    }
                );
            });
        });
    });
});

async function craftCctpTokenBurnMessage(
    tokenRouter: TokenRouterProgram,
    sourceCctpDomain: number,
    cctpNonce: bigint,
    encodedMintRecipient: number[],
    amount: bigint,
    burnSource: number[],
    overrides: { destinationCctpDomain?: number } = {}
) {
    const { destinationCctpDomain: inputDestinationCctpDomain } = overrides;

    const messageTransmitterProgram = tokenRouter.messageTransmitterProgram();
    const { version, localDomain } = await messageTransmitterProgram.fetchMessageTransmitterConfig(
        messageTransmitterProgram.messageTransmitterConfigAddress()
    );
    const destinationCctpDomain = inputDestinationCctpDomain ?? localDomain;

    const tokenMessengerMinterProgram = tokenRouter.tokenMessengerMinterProgram();
    const { tokenMessenger: sourceTokenMessenger } =
        await tokenMessengerMinterProgram.fetchRemoteTokenMessenger(
            tokenMessengerMinterProgram.remoteTokenMessengerAddress(sourceCctpDomain)
        );

    const burnMessage = new CctpTokenBurnMessage(
        {
            version,
            sourceDomain: sourceCctpDomain,
            destinationDomain: destinationCctpDomain,
            nonce: cctpNonce,
            sender: sourceTokenMessenger,
            recipient: Array.from(tokenMessengerMinterProgram.ID.toBuffer()), // targetTokenMessenger
            targetCaller: Array.from(tokenRouter.custodianAddress().toBuffer()), // targetCaller
        },
        0,
        Array.from(wormholeSdk.tryNativeToUint8Array(ETHEREUM_USDC_ADDRESS, "ethereum")), // sourceTokenAddress
        encodedMintRecipient,
        amount,
        burnSource
    );

    const encodedCctpMessage = burnMessage.encode();
    const cctpAttestation = new CircleAttester().createAttestation(encodedCctpMessage);

    return {
        destinationCctpDomain,
        burnMessage,
        encodedCctpMessage,
        cctpAttestation,
    };
}
