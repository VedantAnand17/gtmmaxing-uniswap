# Wallet top-ups: Uniswap as the checkout for agents

An agent that runs out of credits used to stop dead: its owner had to find a card and buy a monthly plan.
Now the `insufficient_credits` refusal carries a link to `/topup/`, the owner pays from a wallet with almost any token, and the agent repeats the same call.
The feature is off until `UNISWAP_API_KEY` and `TOPUP_TREASURY` are set; with them unset, nothing changes for anyone.

## The three rails

| Rail | When | How money arrives |
| --- | --- | --- |
| `usdc` | USDC on Base | Plain transfer to the treasury |
| `swap` | Any other token, on a chain in `api/src/application/topups/catalog.ts`, or a pasted token address | Uniswap API route (`CLASSIC`, `BRIDGE` or `CHAINED`) with the treasury as recipient |
| `jar` | Small payments in an allowlisted Base token, when the payer opts in | Plain transfer into our Token Jar, cleared later for USDC by anyone running `packages/tjar-keeper` |

Credits are `floor(USDC received / 0.015)`, the Starter plan's rate.

## How a credit is earned

The server decides every wallet action (`TopupService.advance`), so the page cannot redirect a payment.
A row in `crypto_topups` becomes `credited` only with proof, and its `crypto_topups_grant` trigger adds the credits and a ledger entry in that one statement.

- **Whose payment:** the wallet signs a message naming this account, and the paying transaction must come from that wallet.
- **Which payment:** a swap transaction must match the destination and calldata Uniswap built for this top-up, whose recipient the server set.
  A cross-chain plan must be owned by our API key, name this wallet as swapper and the treasury as recipient, and report `COMPLETED`.
- **How much:** only USDC seen arriving on Base counts, never the quote.
  Relayers deliver bridges from transactions we cannot name in advance, so `deliver` matches unused deliveries by size.
  Each candidate has already proved a payment, so a match cannot create credit from nothing.
- **Only once:** unique indexes on the settlement log and the source transaction make replays fail.

## Why the jar has limits

A jar pays the treasury one fixed `threshold` per clearing, whatever it holds.
So if we credited every deposit, someone could deposit 100, take credit for 100, clear the jar themselves for a threshold of 25, and get their 100 back.
Three rules close that:

1. The value credited in one round never exceeds the threshold (`jarCommitted`, keyed by the releaser's nonce, with a slot reserved before the wallet pays).
2. Only allowlisted tokens are accepted, since a jar deposit is priced rather than swapped, and a thin pool could lie.
3. Deposits are capped, and credit is the lower of the original quote and the current guaranteed output, less a 5% haircut that pays the clearer.

Each cleared round pays the treasury at least what it credited, so the exposure is one threshold's worth of value if the jar's tokens collapse before anyone clears them.
Keep the threshold small and use `setConfig` to tune it, remembering that lowering it can leak value already in the jar.

## Operating it

Deploy the pair through the TJAR Factory on Base, with the treasury as `resourceRecipient`, then set `TOPUP_JAR` and `TOPUP_RELEASER`:

```bash
cast send 0xfAc70EEEE259F2140CBbB8e3157b75A52ce39fee \
  "deploy(address,address,uint256,address,address,bytes32)(address,address)" \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 $TREASURY $THRESHOLD $OWNER 0x0000000000000000000000000000000000000000 $SALT \
  --rpc-url https://mainnet.base.org
```

Run the keeper as a dry run first: `JAR=.. UNISWAP_API_KEY=.. pnpm --filter @found/tjar-keeper keeper`.
Add `KEEPER_KEY` and `--execute`, and optionally `--swap` to turn the released assets back into USDC.

Smart-contract wallets are not supported yet, because the wallet signature is checked as an ordinary account signature.
