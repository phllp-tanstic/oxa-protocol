use starknet::ContractAddress;
use snforge_std::{
    declare, ContractClassTrait, DeclareResultTrait,
    start_cheat_caller_address, stop_cheat_caller_address,
    start_cheat_block_timestamp, stop_cheat_block_timestamp,
};
use oxa_policy_registry::{
    IOxaPolicyRegistryDispatcher, IOxaPolicyRegistryDispatcherTrait, CategoryPolicy,
};

fn OWNER() -> ContractAddress {
    starknet::contract_address_const::<'owner'>()
}

fn ISSUER() -> ContractAddress {
    starknet::contract_address_const::<'issuer'>()
}

fn NOT_ISSUER() -> ContractAddress {
    starknet::contract_address_const::<'not_issuer'>()
}

const CATEGORY: felt252 = 'inference_apis';
const ENDPOINT: felt252 = 'endpoint_1';

fn deploy() -> IOxaPolicyRegistryDispatcher {
    let contract = declare("OxaPolicyRegistry").unwrap().contract_class();
    let (contract_address, _) = contract.deploy(@array![]).unwrap();
    IOxaPolicyRegistryDispatcher { contract_address }
}

fn default_policy() -> CategoryPolicy {
    CategoryPolicy {
        per_request_cap: 1000,
        period_cap: 5000,
        period_seconds: 3600,
        max_ttl_seconds: 600,
        mode_locked: false,
        locked_mode: false,
    }
}

#[test]
fn test_set_and_get_category_policy() {
    let registry = deploy();
    start_cheat_caller_address(registry.contract_address, OWNER());
    registry.set_category_policy(CATEGORY, default_policy());
    stop_cheat_caller_address(registry.contract_address);

    let policy = registry.get_category_policy(OWNER(), CATEGORY);
    assert(policy.per_request_cap == 1000, 'wrong per_request_cap');
    assert(policy.period_cap == 5000, 'wrong period_cap');
}

#[test]
fn test_set_endpoint_allowed() {
    let registry = deploy();
    start_cheat_caller_address(registry.contract_address, OWNER());
    registry.set_endpoint_allowed(CATEGORY, ENDPOINT, true);
    stop_cheat_caller_address(registry.contract_address);

    assert(registry.is_endpoint_allowed(OWNER(), CATEGORY, ENDPOINT), 'endpoint should be allowed');
    assert(!registry.is_endpoint_allowed(OWNER(), CATEGORY, 'other_endpoint'), 'other endpoint should not');
}

#[test]
fn test_record_spend_within_cap_succeeds() {
    let registry = deploy();
    start_cheat_caller_address(registry.contract_address, OWNER());
    registry.set_category_policy(CATEGORY, default_policy());
    registry.set_authorized_issuer(ISSUER());
    stop_cheat_caller_address(registry.contract_address);

    start_cheat_caller_address(registry.contract_address, ISSUER());
    registry.record_spend(OWNER(), CATEGORY, 500);
    stop_cheat_caller_address(registry.contract_address);
    assert(true, 'reached end');
}

#[test]
#[should_panic(expected: ('NOT_AUTHORIZED_ISSUER',))]
fn test_record_spend_unauthorized_caller_panics() {
    let registry = deploy();
    start_cheat_caller_address(registry.contract_address, OWNER());
    registry.set_category_policy(CATEGORY, default_policy());
    registry.set_authorized_issuer(ISSUER());
    stop_cheat_caller_address(registry.contract_address);

    start_cheat_caller_address(registry.contract_address, NOT_ISSUER());
    registry.record_spend(OWNER(), CATEGORY, 500);
    stop_cheat_caller_address(registry.contract_address);
}

#[test]
#[should_panic(expected: ('NOT_AUTHORIZED_ISSUER',))]
fn test_record_spend_no_issuer_set_panics() {
    let registry = deploy();
    start_cheat_caller_address(registry.contract_address, OWNER());
    registry.set_category_policy(CATEGORY, default_policy());
    stop_cheat_caller_address(registry.contract_address);

    start_cheat_caller_address(registry.contract_address, ISSUER());
    registry.record_spend(OWNER(), CATEGORY, 500);
    stop_cheat_caller_address(registry.contract_address);
}

#[test]
#[should_panic(expected: ('POLICY_CAP_EXCEEDED',))]
fn test_record_spend_exceeds_per_request_cap_panics() {
    let registry = deploy();
    start_cheat_caller_address(registry.contract_address, OWNER());
    registry.set_category_policy(CATEGORY, default_policy());
    registry.set_authorized_issuer(ISSUER());
    stop_cheat_caller_address(registry.contract_address);

    start_cheat_caller_address(registry.contract_address, ISSUER());
    registry.record_spend(OWNER(), CATEGORY, 1001);
    stop_cheat_caller_address(registry.contract_address);
}

#[test]
#[should_panic(expected: ('POLICY_CAP_EXCEEDED',))]
fn test_record_spend_exceeds_period_cap_panics() {
    let registry = deploy();
    start_cheat_caller_address(registry.contract_address, OWNER());
    registry.set_category_policy(CATEGORY, default_policy());
    registry.set_authorized_issuer(ISSUER());
    stop_cheat_caller_address(registry.contract_address);

    start_cheat_block_timestamp(registry.contract_address, 1000);
    start_cheat_caller_address(registry.contract_address, ISSUER());
    registry.record_spend(OWNER(), CATEGORY, 1000);
    registry.record_spend(OWNER(), CATEGORY, 1000);
    registry.record_spend(OWNER(), CATEGORY, 1000);
    registry.record_spend(OWNER(), CATEGORY, 1000);
    registry.record_spend(OWNER(), CATEGORY, 1000);
    registry.record_spend(OWNER(), CATEGORY, 1);
    stop_cheat_caller_address(registry.contract_address);
    stop_cheat_block_timestamp(registry.contract_address);
}

#[test]
fn test_record_spend_window_rolls_over() {
    let registry = deploy();
    start_cheat_caller_address(registry.contract_address, OWNER());
    registry.set_category_policy(CATEGORY, default_policy());
    registry.set_authorized_issuer(ISSUER());
    stop_cheat_caller_address(registry.contract_address);

    start_cheat_caller_address(registry.contract_address, ISSUER());

    start_cheat_block_timestamp(registry.contract_address, 1000);
    registry.record_spend(OWNER(), CATEGORY, 1000);
    registry.record_spend(OWNER(), CATEGORY, 1000);
    registry.record_spend(OWNER(), CATEGORY, 1000);
    registry.record_spend(OWNER(), CATEGORY, 1000);
    registry.record_spend(OWNER(), CATEGORY, 1000); // total 5000, exactly at period_cap
    stop_cheat_block_timestamp(registry.contract_address);

    // Past the window: this would fail if the window hadn't rolled over
    // (5000 + 1000 = 6000 > period_cap of 5000).
    start_cheat_block_timestamp(registry.contract_address, 1000 + 3601);
    registry.record_spend(OWNER(), CATEGORY, 1000);
    stop_cheat_block_timestamp(registry.contract_address);

    stop_cheat_caller_address(registry.contract_address);
    assert(true, 'window rolled over correctly');
}
