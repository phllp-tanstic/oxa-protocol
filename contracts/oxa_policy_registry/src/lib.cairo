/// OXA Policy Registry — per-owner spend policy storage.
/// Standard Starknet storage contract, no privacy-specific pattern.
/// Blueprint §2.7, §5.1, §5.2. `authorized_issuer` gate on `record_spend`
/// per Decision 0002/§6 review: without it, any caller could record spend
/// against any owner, defeating the cap it's meant to enforce.

pub mod errors {
    pub const ZERO_OWNER: felt252 = 'ZERO_OWNER';
    pub const ZERO_CATEGORY: felt252 = 'ZERO_CATEGORY';
    pub const ZERO_ENDPOINT_ID: felt252 = 'ZERO_ENDPOINT_ID';
    pub const ZERO_ISSUER: felt252 = 'ZERO_ISSUER';
    pub const NOT_AUTHORIZED_ISSUER: felt252 = 'NOT_AUTHORIZED_ISSUER';
    pub const POLICY_CAP_EXCEEDED: felt252 = 'POLICY_CAP_EXCEEDED';
    pub const ENDPOINT_NOT_ALLOWED: felt252 = 'ENDPOINT_NOT_ALLOWED';
    pub const MODE_LOCK_VIOLATION: felt252 = 'MODE_LOCK_VIOLATION';
    pub const TTL_EXCEEDS_MAX: felt252 = 'TTL_EXCEEDS_MAX';
}

#[derive(Serde, Copy, Drop, starknet::Store)]
pub struct CategoryPolicy {
    pub per_request_cap: u128,
    pub period_cap: u128,
    pub period_seconds: u64,
    pub max_ttl_seconds: u64,
    pub mode_locked: bool,
    pub locked_mode: bool,
}

#[starknet::interface]
pub trait IOxaPolicyRegistry<T> {
    fn set_category_policy(ref self: T, category: felt252, policy: CategoryPolicy);
    fn set_endpoint_allowed(
        ref self: T, category: felt252, endpoint_id: felt252, allowed: bool,
    );
    fn set_authorized_issuer(ref self: T, issuer: starknet::ContractAddress);
    fn get_category_policy(self: @T, owner: starknet::ContractAddress, category: felt252) -> CategoryPolicy;
    fn is_endpoint_allowed(
        self: @T, owner: starknet::ContractAddress, category: felt252, endpoint_id: felt252,
    ) -> bool;
    fn get_authorized_issuer(self: @T, owner: starknet::ContractAddress) -> starknet::ContractAddress;
    fn record_spend(ref self: T, owner: starknet::ContractAddress, category: felt252, amount: u128);
}

#[starknet::contract]
pub mod OxaPolicyRegistry {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StoragePointerReadAccess, StoragePointerWriteAccess, StoragePathEntry,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use super::{CategoryPolicy, IOxaPolicyRegistry, errors};

    #[storage]
    struct Storage {
        policies: Map<(ContractAddress, felt252), CategoryPolicy>,
        spend_windows: Map<(ContractAddress, felt252), (u64, u128)>,
        endpoint_allowlist: Map<(ContractAddress, felt252, felt252), bool>,
        authorized_issuer: Map<ContractAddress, ContractAddress>,
    }

    #[abi(embed_v0)]
    pub impl OxaPolicyRegistryImpl of IOxaPolicyRegistry<ContractState> {
        fn set_category_policy(ref self: ContractState, category: felt252, policy: CategoryPolicy) {
            assert(category.is_non_zero(), errors::ZERO_CATEGORY);
            let owner = get_caller_address();
            self.policies.entry((owner, category)).write(policy);
        }

        fn set_endpoint_allowed(
            ref self: ContractState, category: felt252, endpoint_id: felt252, allowed: bool,
        ) {
            assert(category.is_non_zero(), errors::ZERO_CATEGORY);
            assert(endpoint_id.is_non_zero(), errors::ZERO_ENDPOINT_ID);
            let owner = get_caller_address();
            self.endpoint_allowlist.entry((owner, category, endpoint_id)).write(allowed);
        }

        fn set_authorized_issuer(ref self: ContractState, issuer: ContractAddress) {
            assert(issuer.is_non_zero(), errors::ZERO_ISSUER);
            let owner = get_caller_address();
            self.authorized_issuer.entry(owner).write(issuer);
        }

        fn get_category_policy(
            self: @ContractState, owner: ContractAddress, category: felt252,
        ) -> CategoryPolicy {
            self.policies.entry((owner, category)).read()
        }

        fn is_endpoint_allowed(
            self: @ContractState, owner: ContractAddress, category: felt252, endpoint_id: felt252,
        ) -> bool {
            self.endpoint_allowlist.entry((owner, category, endpoint_id)).read()
        }

        fn get_authorized_issuer(self: @ContractState, owner: ContractAddress) -> ContractAddress {
            self.authorized_issuer.entry(owner).read()
        }

        fn record_spend(
            ref self: ContractState, owner: ContractAddress, category: felt252, amount: u128,
        ) {
            assert(owner.is_non_zero(), errors::ZERO_OWNER);
            assert(category.is_non_zero(), errors::ZERO_CATEGORY);

            let caller = get_caller_address();
            let authorized = self.authorized_issuer.entry(owner).read();
            assert(authorized.is_non_zero(), errors::NOT_AUTHORIZED_ISSUER);
            assert(caller == authorized, errors::NOT_AUTHORIZED_ISSUER);

            let policy = self.policies.entry((owner, category)).read();
            let now = get_block_timestamp();
            let (window_start, spent) = self.spend_windows.entry((owner, category)).read();

            assert(amount <= policy.per_request_cap, errors::POLICY_CAP_EXCEEDED);

            let (effective_window_start, effective_spent) =
                if now >= window_start + policy.period_seconds {
                    (now, 0_u128)
                } else {
                    (window_start, spent)
                };

            let new_spent = effective_spent + amount;
            assert(new_spent <= policy.period_cap, errors::POLICY_CAP_EXCEEDED);

            self.spend_windows.entry((owner, category)).write((effective_window_start, new_spent));
        }
    }
}
