# Securely Storing Private Keys for Bot Operators 
## **Expirmental***
### Overview
Right now most bot operaters use a `.env` file to store their private key in plain text. Compromising this key would lead to full control and access of the account. If the bot requires collateral to operate this is even more of a concern. 

As large institutional players and firms look to operate as market makers, liquidators, or even trade on decentralized exchanges, they need to know their private keys are securely stored and could not be easily accessed given a breach of a machine. 

A common approach for trading custody is through various providers like [fireblocks](https://fireblocks.com) or [copper](https://copper.co). This works quite well for trading given the integrations that each platform has built out. If you want to implement and operate your own trading infrastructure you will need API access which is often lacking across many of these platforms. Additionally each of these platforms are institutional grade and thus their pricing reflects that.

A institutional standard for secret storage is [Hashicorp Vault](https://www.vaultproject.io). Vault is a secret store and has a very robust API and even alllows alerting on secret access or signing via [Sentinel Policies](https://developer.hashicorp.com/vault/tutorials/policies/sentinel).

The easiest way to integrate vault is through pushing your private key as a key-value pair and accessing it from within your program. 

Note, needing to read the private key from a key-value pair in your program is far better than storing in an `.env` (for security, flexability, and an audit trail) but still leaves the private key in memory which can easily be dumped and read!

The best and most secure usage is to have a module within hashicorp that listens for a raw unsigned transaction and signs it within the vault (also note: very expiremental feature). [github.com/saberistic/solana-secrets-engine](https://github.com/saberistic/solana-secrets-engine) starts on this work, and I plan on continuing and improving it in the future.

### Key Value Usage 
```
# start vault 
make 

# export vault addr
export VAULT_ADDR='http://127.0.0.1:8200'

# store your private key 
vault kv put -mount=secret pk pk=<enter your private key here>
```

### Hashicorp Hosted Platform 
Launching the hosted platform you will need to create a policy, create a token and assign it a rol. You can read about token authentication [here](https://developer.hashicorp.com/vault/tutorials/tokens/tokens)

Create a `.hcl` file to serve as the policy
```
# read solana pk
path "secret/+/pk" {
    capabilities = ["read", "list"]
}
```

Write out vault policy and assign the role to a token
```
vault policy write solana solana.hcl
```

Write out auth and assign the role
```
vault write auth/token/roles/bot \
    allowed_policies="solana" \
    orphan=true \
    period=8h

vault token create -role=bot
```

### Secrets Engine Usage 
**Not fully implemented yet**
The build of this module can be found in [plugin.md](./plugin.md)

```
# start vault 
make 

# export vault addr
export VAULT_ADDR='http://127.0.0.1:8200'

# when signing via the vault module is fully implemented enable it with
make enable

# Write an account to the Solana secrets engine
$ vault write -f solana-secrets/test
Key       Value
---       -----
pubKey    XXXXXX

# Retrieve a signed transaction from Solana secrets engine
$ vault read solana-secrets/test tx=ZZZZZZ // base64 encoded transaction
Key          Value
---          -----
encodedTX    YYYYYY // base64 encoded signed transaction
pubKey       XXXXXX
```