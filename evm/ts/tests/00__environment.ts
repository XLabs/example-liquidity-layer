import {
  CHAIN_ID_AVAX,
  CHAIN_ID_ETH,
  CHAIN_ID_POLYGON,
  coalesceChainId,
  tryNativeToHexString,
  tryNativeToUint8Array,
} from "@certusone/wormhole-sdk";
import { expect } from "chai";
import { ethers } from "ethers";
import * as fs from "fs";
import {
  CurveFactory__factory,
  ICircleBridge__factory,
  ICircleIntegration__factory,
  ICurvePool__factory,
  IMessageTransmitter__factory,
  ITokenBridge__factory,
  IUSDC__factory,
  IWormhole__factory,
} from "../src/types";
import {
  CANONICAL_TOKEN_ADDRESS,
  CANONICAL_TOKEN_CHAIN,
  CURVE_FACTORY_ADDRESS,
  GUARDIAN_PRIVATE_KEY,
  LOCALHOSTS,
  MATCHING_ENGINE_CHAIN,
  MATCHING_ENGINE_POOL_COINS,
  TOKEN_BRIDGE_ADDRESSES,
  USDC_ADDRESSES,
  WALLET_PRIVATE_KEYS,
  WORMHOLE_CCTP_ADDRESSES,
  WORMHOLE_GUARDIAN_SET_INDEX,
  WORMHOLE_MESSAGE_FEE,
  mineWait,
  mineWaitWut,
  mintNativeUsdc,
  mintWrappedTokens,
} from "./helpers";
import { TokenImplementation__factory } from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";

describe("Environment", () => {
  //for (const network of ["avalanche", "arbitrum", "ethereum", "polygon"]) {
  for (const network of ["avalanche"]) {
    const networkName = network.charAt(0).toUpperCase() + network.slice(1);

    if (!(network in LOCALHOSTS)) {
      throw new Error(`Missing network: ${network}`);
    }

    const localhost = (LOCALHOSTS as any)[network] as string;
    const usdcAddress = (USDC_ADDRESSES as any)[network] as string;
    const tokenBridgeAddress = (TOKEN_BRIDGE_ADDRESSES as any)[
      network
    ] as string;
    const wormholeCctpAddress = (WORMHOLE_CCTP_ADDRESSES as any)[network];

    describe(`${networkName} Fork`, () => {
      const provider = new ethers.providers.StaticJsonRpcProvider(localhost);
      const wallets = WALLET_PRIVATE_KEYS.map(
        (key) => new ethers.Wallet(key, provider)
      );

      const deployer = wallets[9];

      const tokenBridge = ITokenBridge__factory.connect(
        tokenBridgeAddress,
        provider
      );

      const wormholeCctp =
        wormholeCctpAddress === null
          ? null
          : ICircleIntegration__factory.connect(wormholeCctpAddress, provider);

      const orderRouterJson = `${__dirname}/../../out/OrderRouter.sol/OrderRouter.json`;
      if (!fs.existsSync(orderRouterJson)) {
        throw new Error(`Missing OrderRouter.json: ${orderRouterJson}`);
      }

      const { abi: orderRouterAbi, bytecode: orderRouterBytecode } = JSON.parse(
        fs.readFileSync(orderRouterJson, "utf8")
      );

      it("Wallets", async () => {
        const balances = await Promise.all(
          wallets.map((wallet) => wallet.getBalance())
        );

        for (const balance of balances) {
          expect(balance.toString()).equals("10000000000000000000000");
        }
      }); // it("Wallets", async () => {

      it("Modify Core Bridge", async () => {
        const coreBridge = IWormhole__factory.connect(
          await tokenBridge.wormhole(),
          provider
        );

        const chainId = await coreBridge.chainId();
        // @ts-ignore
        expect(chainId).to.equal(coalesceChainId(network));

        // fetch current coreBridge protocol fee
        const messageFee = await coreBridge.messageFee();
        expect(messageFee.eq(WORMHOLE_MESSAGE_FEE)).to.be.true;

        // override guardian set
        {
          // check guardian set index
          const guardianSetIndex =
            await coreBridge.getCurrentGuardianSetIndex();
          expect(guardianSetIndex).to.equal(WORMHOLE_GUARDIAN_SET_INDEX);

          // override guardian set
          const abiCoder = ethers.utils.defaultAbiCoder;

          // get slot for Guardian Set at the current index
          const guardianSetSlot = ethers.utils.keccak256(
            abiCoder.encode(["uint32", "uint256"], [guardianSetIndex, 2])
          );

          // Overwrite all but first guardian set to zero address. This isn't
          // necessary, but just in case we inadvertently access these slots
          // for any reason.
          const numGuardians = await provider
            .getStorageAt(coreBridge.address, guardianSetSlot)
            .then((value) => ethers.BigNumber.from(value).toBigInt());
          for (let i = 1; i < numGuardians; ++i) {
            await provider.send("anvil_setStorageAt", [
              coreBridge.address,
              abiCoder.encode(
                ["uint256"],
                [
                  ethers.BigNumber.from(
                    ethers.utils.keccak256(guardianSetSlot)
                  ).add(i),
                ]
              ),
              ethers.utils.hexZeroPad("0x0", 32),
            ]);
          }

          // Now overwrite the first guardian key with the devnet key specified
          // in the function argument.
          const devnetGuardian = new ethers.Wallet(GUARDIAN_PRIVATE_KEY)
            .address;
          await provider.send("anvil_setStorageAt", [
            coreBridge.address,
            abiCoder.encode(
              ["uint256"],
              [
                ethers.BigNumber.from(
                  ethers.utils.keccak256(guardianSetSlot)
                ).add(
                  0 // just explicit w/ index 0
                ),
              ]
            ),
            ethers.utils.hexZeroPad(devnetGuardian, 32),
          ]);

          // change the length to 1 guardian
          await provider.send("anvil_setStorageAt", [
            coreBridge.address,
            guardianSetSlot,
            ethers.utils.hexZeroPad("0x1", 32),
          ]);

          // Confirm guardian set override
          const guardians = await coreBridge
            .getGuardianSet(guardianSetIndex)
            .then(
              (guardianSet: any) => guardianSet[0] // first element is array of keys
            );
          expect(guardians.length).to.equal(1);
          expect(guardians[0]).to.equal(devnetGuardian);
        }
      }); // it("Modify Core Bridge", async () => {

      it("Modify Token Bridge", async () => {
        // TODO
        // override outstanding bridged?
      });

      if (wormholeCctp !== null) {
        it("Modify Circle Contracts", async () => {
          const circleBridge = ICircleBridge__factory.connect(
            await wormholeCctp.circleBridge(),
            provider
          );

          // fetch attestation manager address
          const attesterManager = await circleBridge
            .localMessageTransmitter()
            .then((address) =>
              IMessageTransmitter__factory.connect(address, provider)
            )
            .then((messageTransmitter) => messageTransmitter.attesterManager());
          const myAttester = new ethers.Wallet(GUARDIAN_PRIVATE_KEY, provider);

          // start prank (impersonate the attesterManager)
          await provider.send("anvil_impersonateAccount", [attesterManager]);
          await provider.send("anvil_setBalance", [
            attesterManager,
            ethers.BigNumber.from("1000000000000000000")._hex,
          ]);

          // instantiate message transmitter
          const messageTransmitter = await circleBridge
            .localMessageTransmitter()
            .then((address) =>
              IMessageTransmitter__factory.connect(
                address,
                provider.getSigner(attesterManager)
              )
            );
          // const existingAttester = await messageTransmitter.getEnabledAttester(0);

          // update the number of required attestations to one
          await messageTransmitter
            .setSignatureThreshold(ethers.BigNumber.from("1"))
            .then((tx) => mineWait(provider, tx));

          // enable devnet guardian as attester
          await messageTransmitter
            .enableAttester(myAttester.address)
            .then((tx) => mineWait(provider, tx));

          // stop prank
          await provider.send("anvil_stopImpersonatingAccount", [
            attesterManager,
          ]);

          // fetch number of attesters
          const numAttesters =
            await messageTransmitter.getNumEnabledAttesters();

          // confirm that the attester address swap was successful
          const attester = await circleBridge
            .localMessageTransmitter()
            .then((address) =>
              IMessageTransmitter__factory.connect(address, provider)
            )
            .then((messageTransmitter) =>
              messageTransmitter.getEnabledAttester(
                numAttesters.sub(ethers.BigNumber.from("1"))
              )
            );
          expect(myAttester.address).to.equal(attester);
        }); // it("Modify Circle Contracts", async () => {

        it("Mint CCTP USDC", async () => {
          // fetch master minter address
          const masterMinter = await IUSDC__factory.connect(
            usdcAddress,
            provider
          ).masterMinter();

          // start prank (impersonate the Circle masterMinter)
          await provider.send("anvil_impersonateAccount", [masterMinter]);
          await provider.send("anvil_setBalance", [
            masterMinter,
            ethers.BigNumber.from("1000000000000000000")._hex,
          ]);

          // configure my wallet as minter
          {
            const usdc = IUSDC__factory.connect(
              usdcAddress,
              provider.getSigner(masterMinter)
            );

            await usdc
              .configureMinter(deployer.address, ethers.constants.MaxUint256)
              .then((tx) => mineWait(provider, tx));
          }

          // stop prank
          await provider.send("anvil_stopImpersonatingAccount", [masterMinter]);

          // mint USDC and confirm with a balance check
          {
            const usdc = IUSDC__factory.connect(usdcAddress, deployer);
            const amount = ethers.utils.parseUnits("69420", 6);

            const balanceBefore = await usdc.balanceOf(deployer.address);

            await usdc
              .mint(deployer.address, amount)
              .then((tx) => mineWait(provider, tx));

            const balanceAfter = await usdc.balanceOf(deployer.address);
            expect(balanceAfter.sub(balanceBefore).eq(amount)).is.true;

            await usdc
              .transfer("0x0000000000000000000000000000000000000001", amount)
              .then((tx) => mineWait(provider, tx));
          }
        }); // it("CCTP USDC", async () => {
      } // if (wormholeCctp !== null) {

      if (network === "avalanche") {
        it("Deploy Curve Pool", async () => {
          const curveFactory = CurveFactory__factory.connect(
            CURVE_FACTORY_ADDRESS,
            deployer
          );

          const receipt = await curveFactory
            .deploy_plain_pool(
              // "USDC Matching Engine Pool",
              // "meUSDC",
              "Mothership Test Pool", // Name
              "WormUSDC", // Symbol
              MATCHING_ENGINE_POOL_COINS,
              100, // A
              4_000_000, // fee (0.04%)
              0, // asset type
              0 // implementation index
            )
            .catch((err) => {
              console.log(err);
              throw err;
            })
            .then((tx) => mineWait(provider, tx));

          const poolAddress = ethers.utils.hexlify(
            ethers.utils.arrayify(receipt.logs[1].topics[2]).subarray(12)
          );
          const curvePool = ICurvePool__factory.connect(poolAddress, deployer);

          for (let i = 0; i < 3; ++i) {
            const actual = await curvePool.coins(i);
            expect(actual).to.equal(MATCHING_ENGINE_POOL_COINS[i]);
          }

          // Prep to add liquidity.
          const legAmount = "1000000";

          const avaxUsdcAmount = ethers.utils.parseUnits(legAmount, 6);
          const { usdc: avaxUsdc } = await mintNativeUsdc(
            deployer,
            usdcAddress,
            deployer.address,
            ethers.utils.parseUnits(legAmount, 6)
          );

          {
            const balance = await avaxUsdc.balanceOf(deployer.address);
            expect(balance).to.eql(avaxUsdcAmount);
          }

          const ethUsdcAmount = ethers.utils.parseUnits(legAmount, 6);
          const { wrappedToken: ethUsdc } = await mintWrappedTokens(
            deployer,
            tokenBridgeAddress,
            "ethereum",
            USDC_ADDRESSES.ethereum!,
            deployer.address,
            ethers.utils.parseUnits(legAmount, 6)
          );

          {
            const balance = await ethUsdc.balanceOf(deployer.address);
            expect(balance).to.eql(ethUsdcAmount);
          }

          const polyUsdcAmount = ethers.utils.parseUnits(legAmount, 6);
          const { wrappedToken: polyUsdc } = await mintWrappedTokens(
            deployer,
            tokenBridgeAddress,
            "polygon",
            USDC_ADDRESSES.polygon!,
            deployer.address,
            ethers.utils.parseUnits(legAmount, 6)
          );

          {
            const balance = await polyUsdc.balanceOf(deployer.address);
            expect(balance).to.eql(polyUsdcAmount);
          }

          // Now add liquidity.
          await avaxUsdc
            .approve(curvePool.address, avaxUsdcAmount)
            .then((tx) => mineWait(provider, tx));
          await ethUsdc
            .approve(curvePool.address, ethUsdcAmount)
            .then((tx) => mineWait(provider, tx));
          await polyUsdc
            .approve(curvePool.address, polyUsdcAmount)
            .then((tx) => mineWait(provider, tx));

          await curvePool["add_liquidity(uint256[3],uint256)"](
            [avaxUsdcAmount, ethUsdcAmount, polyUsdcAmount],
            0
          ).then((tx) => mineWait(provider, tx));

          const avaxUsdcLiqBalance = await curvePool.balances(0);
          expect(avaxUsdcLiqBalance).to.eql(avaxUsdcAmount);

          const ethUsdcLiqBalance = await curvePool.balances(1);
          expect(ethUsdcLiqBalance).to.eql(ethUsdcAmount);

          const polyUsdcLiqBalance = await curvePool.balances(2);
          expect(polyUsdcLiqBalance).to.eql(polyUsdcAmount);
        });

        it("Deploy Matching Engine", async () => {
          // TODO
        });
      }

      it("Deploy Order Router", async () => {
        const factory = new ethers.ContractFactory(
          orderRouterAbi,
          orderRouterBytecode,
          deployer
        );

        // Deploy an instance of the contract
        const orderRouter = await factory.deploy(
          usdcAddress,
          MATCHING_ENGINE_CHAIN,
          "0x" +
            tryNativeToHexString(
              "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", // TODO: fix this
              "ethereum"
            ),
          CANONICAL_TOKEN_CHAIN,
          "0x" + CANONICAL_TOKEN_ADDRESS,
          tokenBridgeAddress,
          wormholeCctpAddress ?? ethers.constants.AddressZero
        );

        await mineWait(provider, orderRouter.deployTransaction);

        const maxAmount = await orderRouter.MAX_AMOUNT();
        expect(maxAmount.toString()).equals(
          "115792089237316195423570985008687907853269984665640564039457584007913129"
        );
        //console.log("wtf", wtf);
      }); // it("Deploy Order Router", async () => {
    });
  } // for (const network of ["arbitrum", "avalanche", "ethereum", "polygon"]) {
});
