# Uniswap developer feedback

Written while building wallet top-ups for GTMMAXING at ETHGlobal Mumbai (November 2026), using the Uniswap API (`/quote`, `/check_approval`, `/swap`, `/plan`) and TJAR on Base.
Everything below comes from real requests made during the build.

## What worked well

- **Chained Actions removed the hardest part of the product.**
  Before them we would have had to orchestrate swap, bridge and swap ourselves.
  One quote gave a route into USDC on Base from all 25 token and chain pairs we tried, across 8 chains.
- **`recipient` is honored on every routing type we tried.**
  `CLASSIC`, `BRIDGE` and `CHAINED` quotes all kept our treasury as the output recipient, and the plan we created echoed it back.
  That let the server fix the destination so the browser cannot redirect a payment.
- **TJAR's documentation names its sharp edges.**
  The full-balance release, the nonce guarantee and the warning that a rotated-out releaser still answers its view calls each shaped our keeper directly.

- **The quotes held up with real money.**
  0.001 ETH on Arbitrum was quoted at $2.20 USDC on Base and delivered $2.21, as a `BRIDGE` step followed by a `CLASSIC` step in one plan.
  Our keeper's jar clearing quoted a guaranteed $2.04 for the released ETH, and the swap delivered $2.09.

## What cost us time

### 1. Chained routes need a header the integration guide does not mention

The guide says "You do not request chained routing explicitly" and "The `/quote` request format is unchanged".
Without the header, 30 ARB on Arbitrum to USDC on Base returned `404 ResourceNotFound: No quotes available`, which reads as "no route exists".
With `x-chained-actions-enabled: true`, the same request returned `routing: CHAINED`.
**Suggestion:** document the header on the Chained Actions pages and in the OpenAPI quote parameters, or return an error that names it.

### 2. EIP-712 data is not in the shape wallets accept

Permit data from `/quote` and `SIGN_MSG` plan steps arrives as `{ domain, types, values }`.
`eth_signTypedData_v4` needs `{ domain, types: { EIP712Domain, ... }, primaryType, message }`.
Our fake API in tests could not catch this; only reading a real plan response did.
**Suggestion:** return `primaryType` and include `EIP712Domain`, or show the conversion in the integration guide.

### 3. No way to tie a bridge delivery back to a payment

A plan ending in a swap is fine: on our live payment, the last step's proof named the destination transaction on Base, so we credited from it directly.
For a plan ending in a bridge, we know the source transaction but not the destination one.
`GetSwapsResponse.fillTxHash` is marked internal and is absent for Across, which carries `swapId` instead.
A merchant receiving several payments therefore has to match deliveries by amount and time.
That also means searching logs, which is the call a free RPC endpoint rate-limited during our first live payment.
**Suggestion:** expose the destination transaction hash on a completed bridge step or plan.
A memo or reference field carried through to the delivery would solve it completely.

### 4. The status vocabulary is easy to misread

A new plan reports overall `status: ACTIVE` while its first step is already `AWAITING_ACTION`, although the schema describes `ACTIVE` as "all steps NOT_READY".
Clients that branch on overall status first can stall.
Plans use `COMPLETED` while steps use `COMPLETE`.

### 5. `check_approval` for a bridge relies on an undocumented input

Passing the `BRIDGE` quote to `/check_approval` is what points the approval at the right contract, but the OpenAPI spec marks that field `x-internal`.
We did not test a bridge approval without it, but the public spec gives no other way to name the spender.

### 6. TJAR has no testnet deployment

The Trading API supports Base Sepolia, while the TJAR deployment list has mainnets only.
Our keeper's first real run therefore had to use mainnet funds.

### 7. Finding a jar's assets as documented needs a paid RPC

The searcher guide says to build the asset list from `Transfer` logs into the jar.
That query has no token address, and on 2026-11-06 the free Base endpoints we tried all refused it: `mainnet.base.org` ("request limit reached"), publicnode ("Please specify an address") and drpc (range limits).
A small jar will not attract a searcher who pays for indexing, so our keeper checks balances of common tokens instead and can miss an unusual one.
**Suggestion:** a public jar-contents endpoint in the Uniswap API, since the TJAR Dashboard must compute this already.

### 8. A fixed clearing price needs guardrails for anyone crediting deposits

The docs discuss overshoot as lost value.
For a merchant who credits customers on deposit, it is an exploit: deposit 100, get credit for 100, then clear the jar yourself for a threshold of 25 and take your 100 back.
We cap the value credited per clearing round at the threshold, tracked by releaser nonce.
**Suggestion:** add a section to the operator guide on crediting deposits safely.
