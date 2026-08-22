/// OXA Credential Issuer — mint/reclaim via privacy_invoke; standalone redeem.
/// Blueprint §2.5, §2.10, §2.11, §5.1, §5.2. Grounded against the real
/// `privacy` package per Decision 0004. `owner`/`category` parameters on
/// `privacy_invoke` and the on-chain policy check per Decision 0002.

pub mod errors {
    pub const ZERO_COMMITMENT_HASH: felt252 = 'ZERO_COMMITMENT_HASH';
    pub const ZERO_TOKEN: felt252 = 'ZERO_TOKEN';
    pub const ZERO_AMOUNT: felt252 = 'ZERO_AMOUNT';
    pub const ZERO_ENDPOINT_ID: felt252 = 'ZERO_ENDPOINT_ID';
    pub const ZERO_OWNER: felt252 = 'ZERO_OWNER';
    pub const ZERO_CATEGORY: felt252 = 'ZERO_CATEGORY';
    pub const ZERO_PRIVACY_CONTRACT: felt252 = 'ZERO_PRIVACY_CONTRACT';
    pub const ZERO_POLICY_REGISTRY: felt252 = 'ZERO_POLICY_REGISTRY';
    pub const CREDENTIAL_EXISTS: felt252 = 'CREDENTIAL_EXISTS';
    pub const CREDENTIAL_NOT_FOUND: felt252 = 'CREDENTIAL_NOT_FOUND';
    pub const ALREADY_USED: felt252 = 'ALREADY_USED';
    pub const EXPIRED: felt252 = 'EXPIRED';
    pub const NOT_YET_EXPIRED: felt252 = 'NOT_YET_EXPIRED';
    pub const ENDPOINT_MISMATCH: felt252 = 'ENDPOINT_MISMATCH';
    pub const CALLER_NOT_PRIVACY: felt252 = 'CALLER_NOT_PRIVACY';
    pub const POLICY_CAP_EXCEEDED: felt252 = 'POLICY_CAP_EXCEEDED';
    pub const ENDPOINT_NOT_ALLOWED: felt252 = 'ENDPOINT_NOT_ALLOWED';
    pub const MODE_LOCK_VIOLATION: felt252 = 'MODE_LOCK_VIOLATION';
    pub const INVALID_RECLAIM_SECRET: felt252 = 'INVALID_RECLAIM_SECRET';
    pub const TRANSFER_FAILED: felt252 = 'TRANSFER_FAILED';
}

#[derive(Serde, Copy, Drop, starknet::Store)]
pub struct CredentialEntry {
    pub token: starknet::ContractAddress,
    pub amount: u128,
    pub endpoint_id: felt252,
    pub expiry_timestamp: u64,
    pub reclaim_commitment: felt252,
    pub used: bool,
}

#[derive(Serde, Copy, Drop, PartialEq)]
pub enum OxaOperation {
    Mint,
    Reclaim,
}

pub const OXA_CREDENTIAL_TAG: felt252 = 'OXA_CREDENTIAL_TAG:V1';
pub const OXA_RECLAIM_TAG: felt252 = 'OXA_RECLAIM_TAG:V1';

pub fn compute_credential_commitment(secret: felt252, endpoint_id: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span([OXA_CREDENTIAL_TAG, secret, endpoint_id].span())
}

pub fn compute_reclaim_commitment(reclaim_secret: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span([OXA_RECLAIM_TAG, reclaim_secret].span())
}

#[starknet::interface]
pub trait IOxaCredentialIssuer<T> {
    fn get_credential(self: @T, commitment_hash: felt252) -> CredentialEntry;

    fn privacy_invoke(
        ref self: T,
        operation: OxaOperation,
        commitment_hash: felt252,
        token: starknet::ContractAddress,
        amount: u128,
        endpoint_id: felt252,
        expiry_timestamp: u64,
        reclaim_commitment: felt252,
        reclaim_secret: felt252,
        note_id: felt252,
        owner: starknet::ContractAddress,
        category: felt252,
    ) -> Span<privacy::objects::OpenNoteDeposit>;

    fn redeem(
        ref self: T,
        credential_secret: felt252,
        endpoint_id: felt252,
        payout_address: starknet::ContractAddress,
    );
}

#[starknet::interface]
pub trait IERC20<T> {
    fn transfer(ref self: T, recipient: starknet::ContractAddress, amount: u256) -> bool;
}

#[starknet::contract]
pub mod OxaCredentialIssuer {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use privacy::objects::OpenNoteDeposit;
    use starknet::storage::{
        Map, StoragePointerReadAccess, StoragePointerWriteAccess, StoragePathEntry,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use oxa_policy_registry::{IOxaPolicyRegistryDispatcher, IOxaPolicyRegistryDispatcherTrait};
    use super::{
        CredentialEntry, OxaOperation, IOxaCredentialIssuer, IERC20Dispatcher, IERC20DispatcherTrait,
        errors, OXA_CREDENTIAL_TAG, OXA_RECLAIM_TAG,
    };

    #[storage]
    struct Storage {
        privacy_contract: ContractAddress,
        policy_registry: ContractAddress,
        credentials: Map<felt252, CredentialEntry>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        CredentialRedeemed: CredentialRedeemed,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CredentialRedeemed {
        pub commitment_hash: felt252,
        pub token: ContractAddress,
        pub amount: u128,
        pub payout_address: ContractAddress,
        pub timestamp: u64,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        privacy_contract: ContractAddress,
        policy_registry: ContractAddress,
    ) {
        assert(privacy_contract.is_non_zero(), errors::ZERO_PRIVACY_CONTRACT);
        assert(policy_registry.is_non_zero(), errors::ZERO_POLICY_REGISTRY);
        self.privacy_contract.write(privacy_contract);
        self.policy_registry.write(policy_registry);
    }

    #[abi(embed_v0)]
    pub impl OxaCredentialIssuerImpl of IOxaCredentialIssuer<ContractState> {
        fn get_credential(self: @ContractState, commitment_hash: felt252) -> CredentialEntry {
            self.credentials.entry(commitment_hash).read()
        }

        fn privacy_invoke(
            ref self: ContractState,
            operation: OxaOperation,
            commitment_hash: felt252,
            token: ContractAddress,
            amount: u128,
            endpoint_id: felt252,
            expiry_timestamp: u64,
            reclaim_commitment: felt252,
            reclaim_secret: felt252,
            note_id: felt252,
            owner: ContractAddress,
            category: felt252,
        ) -> Span<OpenNoteDeposit> {
            assert(get_caller_address() == self.privacy_contract.read(), errors::CALLER_NOT_PRIVACY);
            assert(commitment_hash.is_non_zero(), errors::ZERO_COMMITMENT_HASH);

            match operation {
                OxaOperation::Mint => {
                    assert(token.is_non_zero(), errors::ZERO_TOKEN);
                    assert(amount.is_non_zero(), errors::ZERO_AMOUNT);
                    assert(endpoint_id.is_non_zero(), errors::ZERO_ENDPOINT_ID);
                    assert(owner.is_non_zero(), errors::ZERO_OWNER);
                    assert(category.is_non_zero(), errors::ZERO_CATEGORY);

                    let existing = self.credentials.entry(commitment_hash).read();
                    assert(existing.token.is_zero(), errors::CREDENTIAL_EXISTS);

                    let registry = IOxaPolicyRegistryDispatcher {
                        contract_address: self.policy_registry.read(),
                    };
                    assert(
                        registry.is_endpoint_allowed(owner, category, endpoint_id),
                        errors::ENDPOINT_NOT_ALLOWED,
                    );
                    registry.record_spend(owner, category, amount);

                    self.credentials.entry(commitment_hash).write(
                        CredentialEntry {
                            token, amount, endpoint_id, expiry_timestamp,
                            reclaim_commitment, used: false,
                        },
                    );

                    array![].span()
                },
                OxaOperation::Reclaim => {
                    let entry = self.credentials.entry(commitment_hash).read();
                    assert(entry.token.is_non_zero(), errors::CREDENTIAL_NOT_FOUND);
                    assert(!entry.used, errors::ALREADY_USED);
                    assert(get_block_timestamp() > entry.expiry_timestamp, errors::NOT_YET_EXPIRED);

                    let expected = poseidon_hash_span([OXA_RECLAIM_TAG, reclaim_secret].span());
                    assert(expected == entry.reclaim_commitment, errors::INVALID_RECLAIM_SECRET);

                    let mut updated = entry;
                    updated.used = true;
                    self.credentials.entry(commitment_hash).write(updated);

                    array![
                        OpenNoteDeposit { note_id, token: entry.token, amount: entry.amount },
                    ].span()
                },
            }
        }

        fn redeem(
            ref self: ContractState,
            credential_secret: felt252,
            endpoint_id: felt252,
            payout_address: ContractAddress,
        ) {
            let commitment_hash = poseidon_hash_span(
                [OXA_CREDENTIAL_TAG, credential_secret, endpoint_id].span(),
            );
            let entry = self.credentials.entry(commitment_hash).read();
            assert(entry.token.is_non_zero(), errors::CREDENTIAL_NOT_FOUND);
            assert(!entry.used, errors::ALREADY_USED);
            assert(get_block_timestamp() <= entry.expiry_timestamp, errors::EXPIRED);
            assert(entry.endpoint_id == endpoint_id, errors::ENDPOINT_MISMATCH);

            let mut updated = entry;
            updated.used = true;
            self.credentials.entry(commitment_hash).write(updated);

            let token = IERC20Dispatcher { contract_address: entry.token };
            let sent = token.transfer(payout_address, entry.amount.into());
            assert(sent, errors::TRANSFER_FAILED);

            self.emit(
                Event::CredentialRedeemed(
                    CredentialRedeemed {
                        commitment_hash, token: entry.token, amount: entry.amount,
                        payout_address, timestamp: get_block_timestamp(),
                    },
                ),
            );
        }
    }
}
