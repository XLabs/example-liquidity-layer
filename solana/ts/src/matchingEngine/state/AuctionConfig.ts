import { PublicKey } from "@solana/web3.js";

export type AuctionParameters = {
    userPenaltyRewardBps: number;
    initialPenaltyBps: number;
    duration: number;
    gracePeriod: number;
    penaltySlots: number;
};

export class AuctionConfig {
    id: number;
    parameters: AuctionParameters;

    constructor(id: number, parameters: AuctionParameters) {
        this.id = id;
        this.parameters = parameters;
    }

    static address(programId: PublicKey, id: number) {
        const encodedId = Buffer.alloc(4);
        encodedId.writeUInt32BE(id);
        return PublicKey.findProgramAddressSync(
            [Buffer.from("auction-config"), encodedId],
            programId
        )[0];
    }
}
