// SPDX-License-Identifier: Apache 2

pragma solidity 0.8.19;

import {IWormhole} from "wormhole-solidity/IWormhole.sol";
import {ITokenBridge} from "wormhole-solidity/ITokenBridge.sol";
import {ICircleIntegration} from "wormhole-solidity/ICircleIntegration.sol";
import {ICurvePool} from "curve-solidity/ICurvePool.sol";

interface IMatchingEngine {
	struct Route {
		address target;
		bool cctp;
		int8 poolIndex;
	}

	struct CurvePoolInfo {
		ICurvePool pool;
		int8 nativeTokenIndex;
	}

	function executeOrder(bytes calldata vaa) external payable returns (uint64 sequence);

	function executeOrder(
		ICircleIntegration.RedeemParameters calldata redeemParams
	) external payable returns (uint64 sequence);

	function enableExecutionRoute(
		uint16 chainId,
		address target,
		bool cctp,
		int8 poolIndex
	) external;

	function disableExecutionRoute(uint16 chainId) external;

	function registerOrderRouter(uint16 chainId, bytes32 router) external;

	function updateCurvePool(ICurvePool pool, int8 nativeTokenIndex) external;

	function setPause(bool paused) external;

	function submitOwnershipTransferRequest(address newOwner) external;

	function cancelOwnershipTransferRequest() external;

	function confirmOwnershipTransferRequest() external;

	function getChainId() external view returns (uint16);

	function getWormhole() external view returns (IWormhole);

	function getTokenBridge() external view returns (ITokenBridge);

	function getCircleIntegration() external view returns (ICircleIntegration);

	function getExecutionRoute(uint16 chainId) external view returns (Route memory);

	function getOrderRouter(uint16 chainId) external view returns (bytes32);

	function getCurvePoolInfo() external pure returns (CurvePoolInfo memory);

	function getOwner() external view returns (address);

	function getPendingOwner() external view returns (address);

	function getPaused() external view returns (bool);
}
