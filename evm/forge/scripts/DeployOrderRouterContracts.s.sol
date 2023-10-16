// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ICircleIntegration} from "wormhole-solidity/ICircleIntegration.sol";
import {ITokenBridge} from "wormhole-solidity/ITokenBridge.sol";

import {OrderRouterSetup} from "../../src/OrderRouter/OrderRouterSetup.sol";
import {OrderRouterImplementation} from "../../src/OrderRouter/OrderRouterImplementation.sol";

import {CheckWormholeContracts} from "./helpers/CheckWormholeContracts.sol";

contract DeployOrderRouterContracts is CheckWormholeContracts, Script {
    uint16 immutable _chainId = uint16(vm.envUint("RELEASE_CHAIN_ID"));

    address immutable _token = vm.envAddress("RELEASE_TOKEN_ADDRESS");
    uint16 immutable _matchingEngineChain = uint16(vm.envUint("RELEASE_MATCHING_ENGINE_CHAIN"));
    bytes32 immutable _matchingEngineEndpoint = vm.envBytes32("RELEASE_MATCHING_ENGINE_ENDPOINT");

    uint16 immutable _canonicalTokenChain = uint16(vm.envUint("RELEASE_CANONICAL_TOKEN_CHAIN"));
    bytes32 immutable _canonicalTokenAddress = vm.envBytes32("RELEASE_CANONICAL_TOKEN_ADDRESS");

    address immutable _tokenBridgeAddress = vm.envAddress("RELEASE_TOKEN_BRIDGE_ADDRESS");
    address immutable _wormholeCctpAddress = vm.envAddress("RELEASE_WORMHOLE_CCTP_ADDRESS");

    address immutable _ownerAssistantAddress = vm.envAddress("RELEASE_OWNER_ASSISTANT_ADDRESS");
    uint256 immutable _defaultRelayerFee = vm.envUint("RELEASE_DEFAULT_RELAYER_FEE");

    function deploy() public {
        requireValidChain(_chainId, _tokenBridgeAddress, _wormholeCctpAddress);

        OrderRouterImplementation implementation = new OrderRouterImplementation(
            _token,
            _matchingEngineChain,
            _matchingEngineEndpoint,
            _canonicalTokenChain,
            _canonicalTokenAddress,
            _tokenBridgeAddress,
            _wormholeCctpAddress
        );

        OrderRouterSetup setup = new OrderRouterSetup();
        address proxy = setup.deployProxy(
            address(implementation),
            _ownerAssistantAddress,
            _defaultRelayerFee
        );

        console2.log("Deployed OrderRouter (chain=%s): %s", _chainId, proxy);
    }

    function run() public {
        // Begin sending transactions.
        vm.startBroadcast();

        // Deploy setup, implementation and erc1967 proxy.
        deploy();

        // Done.
        vm.stopBroadcast();
    }
}
