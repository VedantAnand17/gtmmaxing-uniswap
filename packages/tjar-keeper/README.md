# TJAR keeper

Clears a [Uniswap Token Jar](https://developers.uniswap.org/docs/protocols/tjar/overview) when it pays to.
A jar keeps no list of its contents and nobody watches a small one, so an operator accepting mixed tokens needs something that does.
Anyone can run this against any jar on Base and keep the margin.

```bash
# Dry run: prints the jar's assets, their value and the decision
JAR=0x.. UNISWAP_API_KEY=.. RPC_URL=https://mainnet.base.org node src/cli.ts

# Clear it, then swap what was released into the jar's resource token
JAR=0x.. UNISWAP_API_KEY=.. KEEPER_KEY=0x.. node src/cli.ts --execute --swap
```

It finds assets from the jar's `Transfer` logs plus its native balance, and values each at the Uniswap API's guaranteed output.
It names the most valuable assets up to `maxReleaseLength`, skips any not worth their own gas, and clears only when they beat `releaseCost` plus gas and `MARGIN`.
The decision is the pure function in `src/decide.ts`; `src/cli.ts` is the chain and API plumbing.
