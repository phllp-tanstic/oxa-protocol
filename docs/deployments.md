# Deployments

## Sepolia Testnet

| Contract | Address | Declared | Deployed |
|---|---|---|---|
| `OxaPolicyRegistry` | `0x039cc9515534d60c65e955139a4c092e66e3fd9fe788714f3afa730352c9c4a0` | [tx](https://sepolia.voyager.online/tx/0x06c8d3aac76ff4087a06147a1b67c35ce91c526a3b756acd0545d9d12a7838f1) | [tx](https://sepolia.voyager.online/tx/0x0294fb26282c44546665a1718e69e4f9910c3ae4ea11ec16c510ca4037fc04bc) |
| `OxaCredentialIssuer` | `0x058cef9c73ab7868bfb2905a33bad7e66b20a6bed02b933b2905c4cb2883cadd` | [tx](https://sepolia.voyager.online/tx/0x0208cb767871559f86f7b296645b2c68968cd2847057a427457a9ac726045c62) | [tx](https://sepolia.voyager.online/tx/0x03c9b7b0ff881da7999e091c43ca7b81cb1a49fea93e4dedd0d849490e34564e) |

Deployer/test-owner account: `0x015717f83241a77d1cdc97f3235e38bfd56a15771a7824f4fd6400c9db1ade62`
Broker account: `0x0022ee304d5f23f3c8754fb2adba232d168bb0003f61d7d6633a24feba9bb58c`

`OxaCredentialIssuer` constructor args: privacy_contract = Sepolia STRK20 pool
(`0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91`),
policy_registry = the `OxaPolicyRegistry` address above.

Config performed: `set_authorized_issuer` (authorizing `OxaCredentialIssuer`
to call `record_spend`), `set_category_policy` and `set_endpoint_allowed`
for test category `test_mvl` / test endpoint `endpoint_1` — real Sepolia
transactions, confirmed via `sncast call` returning the expected stored
values.

**Mainnet:** not yet deployed. `strk20.json` remains empty until real
mainnet transactions exist, per the hackathon rules' own definition of
that file — testnet addresses do not belong there.
