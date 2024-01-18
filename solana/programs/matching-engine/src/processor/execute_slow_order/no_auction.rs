use crate::state::{AuctionData, AuctionStatus, Custodian, RouterEndpoint};
use anchor_lang::prelude::*;
use anchor_spl::token;
use wormhole_cctp_solana::{
    cctp::{message_transmitter_program, token_messenger_minter_program},
    wormhole::core_bridge_program::{self, VaaAccount},
};

use super::CctpMessageArgs;

#[derive(Accounts)]
pub struct ExecuteSlowOrderNoAuction<'info> {
    #[account(mut)]
    payer: Signer<'info>,

    /// This program's Wormhole (Core Bridge) emitter authority.
    ///
    /// CHECK: Seeds must be \["emitter"\].
    #[account(
        seeds = [Custodian::SEED_PREFIX],
        bump = custodian.bump,
    )]
    custodian: Account<'info, Custodian>,

    /// CHECK: Must be owned by the Wormhole Core Bridge program. This account will be read via
    /// zero-copy using the [VaaAccount](core_bridge_program::sdk::VaaAccount) reader.
    #[account(owner = core_bridge_program::id())]
    fast_vaa: AccountInfo<'info>,

    /// CHECK: Must be owned by the Wormhole Core Bridge program. This account will be read via
    /// zero-copy using the [VaaAccount](core_bridge_program::sdk::VaaAccount) reader.
    #[account(owner = core_bridge_program::id())]
    finalized_vaa: AccountInfo<'info>,

    /// There should be no account data here because an auction was never created.
    #[account(
        init,
        payer = payer,
        space = 8 + AuctionData::INIT_SPACE,
        seeds = [
            AuctionData::SEED_PREFIX,
            VaaAccount::load(&fast_vaa)?.try_digest()?.as_ref(),
        ],
        bump,
    )]
    auction_data: Account<'info, AuctionData>,

    /// Redeemer, who owns the token account that will receive the minted tokens.
    ///
    /// CHECK: Signer must be the redeemer encoded in the Deposit Fill message.
    redeemer: Signer<'info>,

    /// Destination token account, which the redeemer may not own. But because the redeemer is a
    /// signer and is the one encoded in the Deposit Fill message, he may have the tokens be sent
    /// to any account he chooses (this one).
    ///
    /// CHECK: This token account must already exist.
    #[account(mut)]
    dst_token: AccountInfo<'info>,

    /// Mint recipient token account, which is encoded as the mint recipient in the CCTP message.
    /// The CCTP Token Messenger Minter program will transfer the amount encoded in the CCTP message
    /// from its custody account to this account.
    ///
    /// CHECK: Mutable. Seeds must be \["custody"\].
    ///
    /// NOTE: This account must be encoded as the mint recipient in the CCTP message.
    #[account(
        mut,
        seeds = [common::constants::CUSTODY_TOKEN_SEED_PREFIX],
        bump = custodian.custody_token_bump,
    )]
    custody_token: AccountInfo<'info>,

    /// Registered emitter account representing a Circle Integration on another network.
    ///
    /// Seeds must be \["registered_emitter", target_chain.to_be_bytes()\].
    #[account(
        seeds = [
            RouterEndpoint::SEED_PREFIX,
            router_endpoint.chain.to_be_bytes().as_ref(),
        ],
        bump = router_endpoint.bump,
    )]
    router_endpoint: Account<'info, RouterEndpoint>,

    /// CHECK: Seeds must be \["message_transmitter_authority"\] (CCTP Message Transmitter program).
    message_transmitter_authority: UncheckedAccount<'info>,

    /// CHECK: Seeds must be \["message_transmitter"\] (CCTP Message Transmitter program).
    message_transmitter_config: AccountInfo<'info>,

    /// CHECK: Mutable. Seeds must be \["used_nonces", remote_domain.to_string(),
    /// first_nonce.to_string()\] (CCTP Message Transmitter program).
    #[account(mut)]
    used_nonces: UncheckedAccount<'info>,

    /// CHECK: Seeds must be \["token_messenger"\] (CCTP Token Messenger Minter program).
    token_messenger: UncheckedAccount<'info>,

    /// CHECK: Seeds must be \["remote_token_messenger"\, remote_domain.to_string()] (CCTP Token
    /// Messenger Minter program).
    remote_token_messenger: UncheckedAccount<'info>,

    /// CHECK: Seeds must be \["token_minter"\] (CCTP Token Messenger Minter program).
    token_minter: UncheckedAccount<'info>,

    /// Token Messenger Minter's Local Token account. This program uses the mint of this account to
    /// validate the `mint_recipient` token account's mint.
    ///
    /// CHECK: Mutable. Seeds must be \["local_token", mint\] (CCTP Token Messenger Minter program).
    #[account(mut)]
    local_token: UncheckedAccount<'info>,

    /// CHECK: Seeds must be \["token_pair", remote_domain.to_string(), remote_token_address\] (CCTP
    /// Token Messenger Minter program).
    token_pair: AccountInfo<'info>,

    /// CHECK: Mutable. Seeds must be \["custody", mint\] (CCTP Token Messenger Minter program).
    #[account(mut)]
    token_messenger_minter_custody_token: AccountInfo<'info>,

    token_messenger_minter_program:
        Program<'info, token_messenger_minter_program::TokenMessengerMinter>,
    message_transmitter_program: Program<'info, message_transmitter_program::MessageTransmitter>,
    token_program: Program<'info, token::Token>,
    system_program: Program<'info, System>,
}

pub fn execute_slow_order_no_auction(
    ctx: Context<ExecuteSlowOrderNoAuction>,
    args: CctpMessageArgs,
) -> Result<()> {
    let fast_vaa = VaaAccount::load(&ctx.accounts.fast_vaa).unwrap();

    // NOTE: We do not need the return values here for this instruction.
    super::prepare_execute_slow_order(
        &fast_vaa,
        super::PrepareExecuteSlowOrder {
            payer: &ctx.accounts.payer,
            custodian: &ctx.accounts.custodian,
            finalized_vaa: &ctx.accounts.finalized_vaa,
            custody_token: ctx.accounts.custody_token.as_ref(),
            message_transmitter_authority: &ctx.accounts.message_transmitter_authority,
            message_transmitter_config: &ctx.accounts.message_transmitter_config,
            used_nonces: &ctx.accounts.used_nonces,
            token_messenger: &ctx.accounts.token_messenger,
            remote_token_messenger: &ctx.accounts.remote_token_messenger,
            token_minter: &ctx.accounts.token_minter,
            local_token: &ctx.accounts.local_token,
            token_pair: &ctx.accounts.token_pair,
            token_messenger_minter_custody_token: &ctx
                .accounts
                .token_messenger_minter_custody_token,
            message_transmitter_program: &ctx.accounts.message_transmitter_program,
            token_messenger_minter_program: &ctx.accounts.token_messenger_minter_program,
            token_program: &ctx.accounts.token_program,
            system_program: &ctx.accounts.system_program,
        },
        args,
    )?;

    // TODO:
    // // SECURITY: We need to verify the router path, since an auction was never created
    // // and this check is done in `placeInitialBid`.
    // _verifyRouterPath(
    //     cctpVaa.emitterChainId,
    //     cctpVaa.emitterAddress,
    //     order.targetChain,
    // );

    // sequence = _handleCctpTransfer(order.amountIn - baseFee, cctpVaa.emitterChainId, order);

    // /**
    //  * Pay the `feeRecipient` the `baseFee`. This ensures that the protocol relayer
    //  * is paid for relaying slow VAAs that do not have an associated auction.
    //  * This prevents the protocol relayer from any MEV attacks.
    //  */
    // SafeERC20.safeTransfer(_token, feeRecipient(), baseFee);

    // /*
    //  * SECURITY: this is a necessary security check. This will prevent a relayer from
    //  * starting an auction with the fast transfer VAA, even though the slow
    //  * relayer already delivered the slow VAA. Not setting this could lead
    //  * to trapped funds (which would require an upgrade to fix).
    //  */
    // auction.status = AuctionStatus.Completed;

    ctx.accounts.auction_data.status = AuctionStatus::Completed;

    Ok(())
}
