use starknet::ContractAddress;
use snforge_std::{
    declare, ContractClassTrait, DeclareResultTrait,
    start_cheat_caller_address, stop_cheat_caller_address,
    start_cheat_block_timestamp, stop_cheat_block_timestamp,
};
use oxa_policy_registry::{IOxaPolicyRegistryDispatcher, IOxaPolicyRegistryDispatcherTrait, CategoryPolicy};
use oxa_credential_issuer::{
    IOxaCredentialIssuerDispatcher, IOxaCredentialIssuerDispatcherTrait, OxaOperation,
    compute_credential_commitment, compute_reclaim_commitment,
};

#[starknet::contract]
mod MockERC20 {
    use starknet::storage::{Map, StoragePointerReadAccess, StoragePointerWriteAccess, StoragePathEntry};
    use starknet::ContractAddress;

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
    }

    #[starknet::interface]
    pub trait IMockERC20<T> {
        fn mint(ref self: T, to: ContractAddress, amount: u256);
        fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
        fn balance_of(self: @T, account: ContractAddress) -> u256;
    }

    #[abi(embed_v0)]
    impl MockERC20Impl of IMockERC20<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            let current = self.balances.entry(to).read();
            self.balances.entry(to).write(current + amount);
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let caller = starknet::get_caller_address();
            let caller_balance = self.balances.entry(caller).read();
            assert(caller_balance >= amount, 'INSUFFICIENT_BALANCE');
            self.balances.entry(caller).write(caller_balance - amount);
            let recipient_balance = self.balances.entry(recipient).read();
            self.balances.entry(recipient).write(recipient_balance + amount);
            true
        }

        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.entry(account).read()
        }
    }
}
use MockERC20::{IMockERC20Dispatcher, IMockERC20DispatcherTrait};

fn OWNER() -> ContractAddress { starknet::contract_address_const::<'owner'>() }
fn PRIVACY() -> ContractAddress { starknet::contract_address_const::<'privacy_pool'>() }
fn NOT_PRIVACY() -> ContractAddress { starknet::contract_address_const::<'not_privacy'>() }
fn PAYOUT() -> ContractAddress { starknet::contract_address_const::<'payout'>() }

const CATEGORY: felt252 = 'inference_apis';
const ENDPOINT: felt252 = 'endpoint_1';
const OTHER_ENDPOINT: felt252 = 'endpoint_2';

fn default_policy() -> CategoryPolicy {
    CategoryPolicy {
        per_request_cap: 1000, period_cap: 5000, period_seconds: 3600,
        max_ttl_seconds: 600, mode_locked: false, locked_mode: false,
    }
}

fn setup() -> (IOxaPolicyRegistryDispatcher, IOxaCredentialIssuerDispatcher, IMockERC20Dispatcher) {
    let registry_class = declare("OxaPolicyRegistry").unwrap().contract_class();
    let (registry_addr, _) = registry_class.deploy(@array![]).unwrap();
    let registry = IOxaPolicyRegistryDispatcher { contract_address: registry_addr };

    let token_class = declare("MockERC20").unwrap().contract_class();
    let (token_addr, _) = token_class.deploy(@array![]).unwrap();
    let token = IMockERC20Dispatcher { contract_address: token_addr };

    let issuer_class = declare("OxaCredentialIssuer").unwrap().contract_class();
    let mut calldata = array![];
    PRIVACY().serialize(ref calldata);
    registry_addr.serialize(ref calldata);
    let (issuer_addr, _) = issuer_class.deploy(@calldata).unwrap();
    let issuer = IOxaCredentialIssuerDispatcher { contract_address: issuer_addr };

    start_cheat_caller_address(registry_addr, OWNER());
    registry.set_category_policy(CATEGORY, default_policy());
    registry.set_endpoint_allowed(CATEGORY, ENDPOINT, true);
    registry.set_authorized_issuer(issuer_addr);
    stop_cheat_caller_address(registry_addr);

    token.mint(issuer_addr, 1000000_u256);

    (registry, issuer, token)
}

#[test]
#[should_panic(expected: ('CALLER_NOT_PRIVACY',))]
fn test_privacy_invoke_caller_not_privacy_panics() {
    let (_, issuer, token) = setup();
    start_cheat_caller_address(issuer.contract_address, NOT_PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, 'commitment', token.contract_address, 500, ENDPOINT,
        9999, 'reclaim_commit', 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);
}

#[test]
#[should_panic(expected: ('ZERO_AMOUNT',))]
fn test_mint_zero_amount_panics() {
    let (_, issuer, token) = setup();
    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, 'commitment', token.contract_address, 0, ENDPOINT,
        9999, 'reclaim_commit', 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);
}

#[test]
#[should_panic(expected: ('ENDPOINT_NOT_ALLOWED',))]
fn test_mint_endpoint_not_allowed_panics() {
    let (_, issuer, token) = setup();
    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, 'commitment', token.contract_address, 500, 'unlisted_endpoint',
        9999, 'reclaim_commit', 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);
}

#[test]
fn test_mint_success_and_get_credential() {
    let (_, issuer, token) = setup();
    let commitment = compute_credential_commitment('secret1', ENDPOINT);
    let reclaim_commitment = compute_reclaim_commitment('reclaim1');

    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, commitment, token.contract_address, 500, ENDPOINT,
        9999, reclaim_commitment, 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);

    let entry = issuer.get_credential(commitment);
    assert(entry.amount == 500, 'wrong amount');
    assert(entry.used == false, 'should not be used yet');
    assert(entry.endpoint_id == ENDPOINT, 'wrong endpoint_id');
}

#[test]
#[should_panic(expected: ('CREDENTIAL_EXISTS',))]
fn test_mint_duplicate_commitment_panics() {
    let (_, issuer, token) = setup();
    let commitment = compute_credential_commitment('secret1', ENDPOINT);
    let reclaim_commitment = compute_reclaim_commitment('reclaim1');

    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, commitment, token.contract_address, 500, ENDPOINT,
        9999, reclaim_commitment, 0, 0, OWNER(), CATEGORY,
    );
    issuer.privacy_invoke(
        OxaOperation::Mint, commitment, token.contract_address, 500, ENDPOINT,
        9999, reclaim_commitment, 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);
}

#[test]
fn test_redeem_success_transfers_token_and_marks_used() {
    let (_, issuer, token) = setup();
    let commitment = compute_credential_commitment('secret1', ENDPOINT);
    let reclaim_commitment = compute_reclaim_commitment('reclaim1');

    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, commitment, token.contract_address, 500, ENDPOINT,
        9999, reclaim_commitment, 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);

    issuer.redeem('secret1', ENDPOINT, PAYOUT());

    assert(token.balance_of(PAYOUT()) == 500_u256, 'payout did not receive funds');
    let entry = issuer.get_credential(commitment);
    assert(entry.used == true, 'entry should be marked used');
}

#[test]
#[should_panic(expected: ('ALREADY_USED',))]
fn test_redeem_double_use_panics() {
    let (_, issuer, token) = setup();
    let commitment = compute_credential_commitment('secret1', ENDPOINT);
    let reclaim_commitment = compute_reclaim_commitment('reclaim1');

    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, commitment, token.contract_address, 500, ENDPOINT,
        9999, reclaim_commitment, 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);

    issuer.redeem('secret1', ENDPOINT, PAYOUT());
    issuer.redeem('secret1', ENDPOINT, PAYOUT());
}

#[test]
#[should_panic(expected: ('EXPIRED',))]
fn test_redeem_after_expiry_panics() {
    let (_, issuer, token) = setup();
    let commitment = compute_credential_commitment('secret1', ENDPOINT);
    let reclaim_commitment = compute_reclaim_commitment('reclaim1');

    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, commitment, token.contract_address, 500, ENDPOINT,
        100, reclaim_commitment, 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);

    start_cheat_block_timestamp(issuer.contract_address, 101);
    issuer.redeem('secret1', ENDPOINT, PAYOUT());
    stop_cheat_block_timestamp(issuer.contract_address);
}

#[test]
#[should_panic(expected: ('ENDPOINT_MISMATCH',))]
fn test_redeem_endpoint_mismatch_panics() {
    let (_, issuer, token) = setup();
    let commitment = compute_credential_commitment('secret1', OTHER_ENDPOINT);
    let reclaim_commitment = compute_reclaim_commitment('reclaim1');

    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, commitment, token.contract_address, 500, ENDPOINT,
        9999, reclaim_commitment, 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);

    issuer.redeem('secret1', OTHER_ENDPOINT, PAYOUT());
}

#[test]
#[should_panic(expected: ('NOT_YET_EXPIRED',))]
fn test_reclaim_before_expiry_panics() {
    let (_, issuer, token) = setup();
    let commitment = compute_credential_commitment('secret1', ENDPOINT);
    let reclaim_commitment = compute_reclaim_commitment('reclaim1');

    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, commitment, token.contract_address, 500, ENDPOINT,
        9999, reclaim_commitment, 0, 0, OWNER(), CATEGORY,
    );
    issuer.privacy_invoke(
        OxaOperation::Reclaim, commitment, token.contract_address, 500, ENDPOINT,
        9999, reclaim_commitment, 'reclaim1', 'note_1', OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);
}

#[test]
#[should_panic(expected: ('INVALID_RECLAIM_SECRET',))]
fn test_reclaim_wrong_secret_panics() {
    let (_, issuer, token) = setup();
    let commitment = compute_credential_commitment('secret1', ENDPOINT);
    let reclaim_commitment = compute_reclaim_commitment('reclaim1');

    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, commitment, token.contract_address, 500, ENDPOINT,
        100, reclaim_commitment, 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);

    start_cheat_block_timestamp(issuer.contract_address, 101);
    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Reclaim, commitment, token.contract_address, 500, ENDPOINT,
        100, reclaim_commitment, 'wrong_secret', 'note_1', OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);
    stop_cheat_block_timestamp(issuer.contract_address);
}

#[test]
fn test_reclaim_success_after_expiry() {
    let (_, issuer, token) = setup();
    let commitment = compute_credential_commitment('secret1', ENDPOINT);
    let reclaim_commitment = compute_reclaim_commitment('reclaim1');

    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    issuer.privacy_invoke(
        OxaOperation::Mint, commitment, token.contract_address, 500, ENDPOINT,
        100, reclaim_commitment, 0, 0, OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);

    start_cheat_block_timestamp(issuer.contract_address, 101);
    start_cheat_caller_address(issuer.contract_address, PRIVACY());
    let deposits = issuer.privacy_invoke(
        OxaOperation::Reclaim, commitment, token.contract_address, 500, ENDPOINT,
        100, reclaim_commitment, 'reclaim1', 'note_1', OWNER(), CATEGORY,
    );
    stop_cheat_caller_address(issuer.contract_address);
    stop_cheat_block_timestamp(issuer.contract_address);

    assert(deposits.len() == 1, 'expected one OpenNoteDeposit');
    let deposit = *deposits.at(0);
    assert(deposit.amount == 500, 'wrong reclaim amount');

    let entry = issuer.get_credential(commitment);
    assert(entry.used == true, 'entry should be marked used');
}

#[test]
fn test_commitment_domain_separation() {
    let c1 = compute_credential_commitment('secret1', ENDPOINT);
    let c2 = compute_credential_commitment('secret1', OTHER_ENDPOINT);
    let c3 = compute_credential_commitment('secret2', ENDPOINT);
    assert(c1 != c2, 'endpoint collision');
    assert(c1 != c3, 'secret collision');
}
