# Zeit App API v1 + third-party vault integration

Small frontend-only demo for the public Zeit app API.

Run locally:

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:4173
```

Canonical gist:

```text
https://gist.github.com/zeit-dev/1849496a10b33b781a8fd85cfefb53ab
```

# Zeit App API v1

Base URL:

```text
https://pp.zeit.finance/api/app/v1
```

Staging:

```text
https://pp-stage.zeit.finance/api/app/v1
```

Auth: none. Read-only. Only public deployed vaults are returned by default.

## Endpoints

```http
GET /vaults?limit=20&offset=0
GET /vaults/search?q=macro&limit=20
GET /vaults/:vaultId
GET /addresses/:address/balances?includeClaims=false
```

Examples:

```bash
curl 'https://pp.zeit.finance/api/app/v1/vaults?limit=10'
curl 'https://pp.zeit.finance/api/app/v1/vaults/search?q=algo'
curl 'https://pp.zeit.finance/api/app/v1/vaults/vault_...'
curl 'https://pp.zeit.finance/api/app/v1/addresses/0x.../balances?includeClaims=true'
```

Response envelope:

```json
{
  "ok": true,
  "apiVersion": "v1",
  "data": {}
}
```

Important fields:

- `data.status.investable`: whether deposits should be enabled.
- `data.metrics`: price, APY, TVL, holders, volume.
- `data.capacity`: current vault capacity, with raw 6-decimal USDC-style strings.
- `data.contracts`: public deployed contract addresses.
- `data.investment.escrowAdapter`: vault-specific deposit contract.
- `data.investment.settlementAsset`: current vault asset, normally pUSD on Polygon.
- `data.investment.acceptedInputAssets`: accepted user input assets, currently pUSD and USDC.e on Polygon.

Address balances:

- `data.totals.pendingDepositAssetRaw`: queued deposit assets, 6 decimals.
- `data.totals.pendingWithdrawalSharesRaw`: queued withdrawal shares, 18 decimals.
- `data.totals.claimableDepositSharesRaw`: shares claimable after rolls, 18 decimals.
- `data.totals.claimableWithdrawalAssetsRaw`: assets claimable after rolls, 6 decimals.
- `data.vaults[]`: same breakdown per public vault.
- `includeClaims=true`: includes Merkle claim payloads/proofs for claim UI prep.

Errors:

```json
{
  "ok": false,
  "error": {
    "code": "vault_not_found",
    "message": "Vault not found"
  }
}
```

## Third-Party Deposits

Fetch vault detail first and use the addresses from `data.investment`; do not hardcode vault contract addresses.

Current Polygon v2 deposit flow:

1. Require Polygon `chainId = 137`.
2. Parse the user amount with 6 decimals.
3. If the user has pUSD:
   - `pUSD.approve(escrowAdapter, amount)`
   - `escrowAdapter.depositAsset(amount)`
4. If the user has USDC.e:
   - `USDCe.approve(collateralOnramp, amount)`
   - `collateralOnramp.wrap(USDCe, userAddress, amount)`
   - `pUSD.approve(escrowAdapter, amount)`
   - `escrowAdapter.depositAsset(amount)`

Minimal ABI fragments:

```ts
const erc20Abi = [
  "function approve(address spender,uint256 amount) returns (bool)",
];

const collateralOnrampAbi = [
  "function wrap(address asset,address to,uint256 amount)",
];

const escrowAdapterAbi = [
  "function depositAsset(uint256 amount)",
  "function depositAssetFor(address beneficiary,uint256 amount)",
];
```

Viem sketch:

```ts
import { parseAbi, parseUnits } from "viem";

const amount = parseUnits("10", 6);
const vault = await fetch(
  "https://pp.zeit.finance/api/app/v1/vaults/vault_..."
).then((r) => r.json());

const investment = vault.data.investment;
const escrowAdapter = investment.escrowAdapter;
const pUSD = investment.settlementAsset.address;
const usdce = investment.acceptedInputAssets.find(
  (a) => a.symbol === "USDC.e"
);

// USDC.e input path.
await walletClient.writeContract({
  address: usdce.address,
  abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
  functionName: "approve",
  args: [usdce.wrapper, amount],
});

await walletClient.writeContract({
  address: usdce.wrapper,
  abi: parseAbi(["function wrap(address asset,address to,uint256 amount)"]),
  functionName: "wrap",
  args: [usdce.address, userAddress, amount],
});

await walletClient.writeContract({
  address: pUSD,
  abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
  functionName: "approve",
  args: [escrowAdapter, amount],
});

await walletClient.writeContract({
  address: escrowAdapter,
  abi: parseAbi(["function depositAsset(uint256 amount)"]),
  functionName: "depositAsset",
  args: [amount],
});
```

Notes:

- Deposits are queued. Shares become claimable after the vault manager rolls the vault.
- Use exact allowances where possible.
- For sponsored Privy embedded wallets, send the same transactions through Privy's native sponsored transaction path. Do not use Alchemy paymaster RPC unless that wallet stack is explicitly configured for it.

## Depositing From Other Chains

The vault deposit itself is Polygon-only today. A third-party frontend can still offer cross-chain deposits by bridging first, then executing the Polygon deposit leg.

Simple flow:

1. Fetch vault detail from `GET /vaults/:vaultId`.
2. Bridge the user asset to Polygon `chainId=137`.
3. If the bridge output is USDC.e, wrap it to pUSD with `collateralOnramp.wrap(...)`.
4. Approve pUSD to `investment.escrowAdapter`.
5. Call `escrowAdapter.depositAsset(amount)` from the user wallet.

Relayer/one-click flow:

1. Bridge/relay into Polygon and make the final Polygon calldata call.
2. If output is USDC.e, final calls are: approve USDC.e to onramp, wrap to pUSD, approve pUSD to escrow adapter.
3. If the relayer is the transaction sender, call `depositAssetFor(beneficiary, amount)` so shares accrue to the user.

Do not bridge tokens directly to the escrow adapter address without calldata; that will not create a deposit request.

## Claims

Use `GET /addresses/:address/balances?includeClaims=true` to find settled, unclaimed balances.

Direct Polygon claim flow:

1. Require Polygon `chainId = 137`.
2. For claimable deposit shares, call `escrowAdapter.claimDeposits(claims)`.
3. For claimable withdrawal assets, call `escrowAdapter.claimWithdrawals(claims)`.

Minimal ABI:

```ts
const escrowAdapterClaimAbi = [
  "function claimDeposits((uint64 epoch,uint256 requestId,uint256 shares,bytes32[] proof)[] claims) returns (uint256)",
  "function claimWithdrawals((uint64 epoch,uint256 requestId,uint256 assets,bytes32[] proof)[] claims) returns (uint256)",
];
```

Viem sketch:

```ts
const balances = await fetch(
  `https://pp.zeit.finance/api/app/v1/addresses/${user}/balances?includeClaims=true`
).then((r) => r.json());

const entry = balances.data.vaults.find((v) => v.vault.id === vaultId);

const depositClaims = entry.claimable.deposits.claims.map((c) => ({
  epoch: BigInt(c.epochSolved),
  requestId: BigInt(c.requestId),
  shares: BigInt(c.shares),
  proof: c.proof,
}));

await walletClient.writeContract({
  address: entry.escrowAdapter,
  abi: parseAbi(escrowAdapterClaimAbi),
  functionName: "claimDeposits",
  args: [depositClaims],
});

const withdrawalClaims = entry.claimable.withdrawals.claims.map((c) => ({
  epoch: BigInt(c.epochSolved),
  requestId: BigInt(c.requestId),
  assets: BigInt(c.assets),
  proof: c.proof,
}));

await walletClient.writeContract({
  address: entry.escrowAdapter,
  abi: parseAbi(escrowAdapterClaimAbi),
  functionName: "claimWithdrawals",
  args: [withdrawalClaims],
});
```

Notes:

- Claim chunks should be kept to 10 claims or fewer.
- `claimDeposits` returns vault share tokens.
- Direct `claimWithdrawals` returns the vault asset, normally pUSD on Polygon.
- For a USDC.e cash-out, use the vault's app flow or the multi-chain claim-assets flow below when the vault supports the unwrap/off-ramp path.

Multi-chain claim prep endpoints:

```http
POST /api/vaults/public/:vaultId/multi-chain/claim-and-bridge
POST /api/vaults/public/:vaultId/multi-chain/claim-assets
```

Claim shares to a remote chain:

1. POST `{ "owner": userAddress, "destinationChainId": 42161 }` to `claim-and-bridge`.
2. Have the wallet sign the returned `intentTypedData`.
3. Build calldata for `claimDepositsAndBridgeFor(...)` with the returned `calldataParams`, `claims`, and signature.
4. Request a Relay call-execution quote from the user's current chain to Polygon.
5. Send the Relay origin transaction and poll Relay/LayerZero delivery.

Claim withdrawal assets to a remote chain:

1. POST `{ "owner": userAddress, "destinationChainId": 42161 }` to `claim-assets`.
2. Have the wallet sign the returned `intentTypedData`.
3. Build calldata for `claimWithdrawalsToDepositAddressFor(...)` or `claimWithdrawalsToUnwrappedDepositAddressFor(...)`, depending on `calldataParams.claimAssetMode`.
4. Request a Relay call-execution quote using `relay.callExecutionQuotePayload` plus the calldata transaction.
5. Send the Relay origin transaction, then poll both `relay.callExecution` and `relay.depositAddress.statusUrl`.
