# Agent ENS names

An owner can link a connected agent to an ENS name.
The name gives the agent a public identity, and one text record on it decides whether the agent may start paid work.

## How it works

1. The owner writes the agent's id into the name's `com.gtmmaxing.agent` text record.
2. The owner enters the name on the agent's card on the Usage page.
   `PUT /agents/:id/ens` reads the record through the ENS Universal Resolver and links the name only if the record holds this agent's id.
   That read is the proof of control, so the app needs no wallet connection, signature or gas.
3. Every new agent run checks the record in `AgentGateway.execute`.
   If it no longer holds the agent's id, the call is refused with `ens_stopped` and nothing is sent.
   Setting the record again resumes the agent.

Runs already under way finish, and free reads, quotes and idempotent replays keep working.

## ENSv2 delegation

On an ENSv2 Permissioned Resolver the owner can use Enhanced Access Control to give another account `ROLE_SET_TEXT` for this one key with `grantSetterRoles`.
That account, such as an on-call teammate or a Safe, can stop or resume agents but cannot change the name's addresses or other records.
A resolver role has no per-name scope, so the holder can edit this key on every name that resolver serves.

## Checks and failure behaviour

- A confirmed answer stands for 30 seconds (`ENS_FRESH_MS`), so a busy agent does not read the chain on every call.
- When the chain cannot be read, the last confirmed answer stands for one hour (`ENS_OUTAGE_GRACE_MS`), and after that the agent is refused with `ens_check_unavailable` until a read succeeds.
- A reverted resolution means the name does not resolve, and counts as a missing record.
- Agents without a linked name never touch the chain.
- `ETH_RPC_URL` sets the mainnet RPC; public endpoints are used when it is unset.

A record can only stop an agent or confirm it.
Credentials, scopes and credit caps stay in GTMMAXING, so nobody can gain access or spend by editing a record.
Linked names are public onchain, so linking is always the owner's choice.

## Where things live

| Piece | Code |
| --- | --- |
| Reader and guard | `api/src/application/agent-ens.ts` |
| Link and unlink routes | `api/src/routes/agents.ts` |
| Spending check | `api/src/application/agent-gateway/index.ts` |
| Usage page panel | `web/src/features/agents/EnsName.tsx` |
| Tests | `api/test/agent-ens.test.ts`, `web/src/features/agents/agents.test.tsx` |
