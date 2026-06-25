import {
  createWalletClient,
  custom,
  formatUnits,
  parseAbi,
  parseUnits,
} from "https://esm.sh/viem@2.51.2";
import { polygon } from "https://esm.sh/viem@2.51.2/chains";

const POLYGON_HEX_CHAIN_ID = "0x89";
const POLYGON_PARAMS = {
  chainId: POLYGON_HEX_CHAIN_ID,
  chainName: "Polygon",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  rpcUrls: ["https://polygon-rpc.com"],
  blockExplorerUrls: ["https://polygonscan.com"],
};

const erc20Abi = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);

const collateralOnrampAbi = parseAbi(["function wrap(address asset,address to,uint256 amount)"]);

const escrowAdapterAbi = parseAbi([
  "function depositAsset(uint256 amount)",
  "function depositAssetFor(address beneficiary,uint256 amount)",
  "function claimDeposits((uint64 epoch,uint256 requestId,uint256 shares,bytes32[] proof)[] claims) returns (uint256)",
  "function claimWithdrawals((uint64 epoch,uint256 requestId,uint256 assets,bytes32[] proof)[] claims) returns (uint256)",
]);

const state = {
  apiBase: "https://pp.zeit.finance/api/app/v1",
  vaults: [],
  selectedVault: null,
  walletAddress: null,
  walletClient: null,
  balances: null,
};

const $ = (id) => document.getElementById(id);

const elements = {
  environment: $("environment"),
  refreshVaults: $("refreshVaults"),
  searchForm: $("searchForm"),
  searchInput: $("searchInput"),
  vaultList: $("vaultList"),
  connectWallet: $("connectWallet"),
  vaultDetail: $("vaultDetail"),
  depositAmount: $("depositAmount"),
  depositAsset: $("depositAsset"),
  runDeposit: $("runDeposit"),
  showDepositCalldata: $("showDepositCalldata"),
  loadBalances: $("loadBalances"),
  claimDeposits: $("claimDeposits"),
  claimWithdrawals: $("claimWithdrawals"),
  balanceSummary: $("balanceSummary"),
  destinationChainId: $("destinationChainId"),
  prepareClaimBridge: $("prepareClaimBridge"),
  prepareClaimAssets: $("prepareClaimAssets"),
  clearOutput: $("clearOutput"),
  output: $("output"),
  selectedHint: $("selectedHint"),
};

function backendOrigin() {
  return state.apiBase.replace(/\/api\/app\/v1$/, "");
}

function writeOutput(value) {
  elements.output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function appendOutput(label, value) {
  const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  elements.output.textContent = `${elements.output.textContent}\n\n${label}\n${rendered}`;
}

async function fetchJson(path, options) {
  const response = await fetch(`${state.apiBase}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body?.error?.message ?? body?.error ?? response.statusText);
  }
  return body;
}

async function fetchBackendJson(path, options) {
  const response = await fetch(`${backendOrigin()}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(body?.error ?? response.statusText);
  }
  return body;
}

function shortAddress(value) {
  if (!value) return "n/a";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function rawUsd(value) {
  return `${formatUnits(BigInt(value || "0"), 6)} USD`;
}

function rawShares(value) {
  return `${formatUnits(BigInt(value || "0"), 18)} shares`;
}

function selectedBalanceEntry() {
  if (!state.selectedVault || !state.balances) return null;
  return state.balances.vaults.find((entry) => entry.vault.id === state.selectedVault.id) ?? null;
}

async function loadVaults(query = "") {
  elements.vaultList.innerHTML = '<div class="empty-state">Loading vaults...</div>';
  const path = query
    ? `/vaults/search?q=${encodeURIComponent(query)}&limit=20`
    : "/vaults?limit=20";
  const response = await fetchJson(path);
  state.vaults = response.data ?? [];
  renderVaultList();
  writeOutput(response);
}

function renderVaultList() {
  if (state.vaults.length === 0) {
    elements.vaultList.innerHTML = '<div class="empty-state">No vaults found.</div>';
    return;
  }

  elements.vaultList.innerHTML = "";
  for (const vault of state.vaults) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `vault-item ${state.selectedVault?.id === vault.id ? "active" : ""}`;
    button.innerHTML = `
			<div class="vault-title">
				<span>${escapeHtml(vault.name)}</span>
				<span>${escapeHtml(vault.ticker ?? "")}</span>
			</div>
			<div class="vault-meta">
				<span>TVL ${formatNullableUsd(vault.metrics?.tvlUsd)}</span>
				<span>${vault.status?.investable ? "Investable" : "Not investable"}</span>
				<span>${escapeHtml(vault.version ?? "v0")}</span>
			</div>
		`;
    button.addEventListener("click", () => selectVault(vault.id));
    elements.vaultList.appendChild(button);
  }
}

async function selectVault(vaultId) {
  const response = await fetchJson(`/vaults/${encodeURIComponent(vaultId)}`);
  state.selectedVault = response.data;
  state.balances = null;
  renderVaultList();
  renderVaultDetail();
  renderBalances();
  writeOutput(response);
}

function renderVaultDetail() {
  const vault = state.selectedVault;
  if (!vault) {
    elements.vaultDetail.className = "empty-state";
    elements.vaultDetail.textContent = "No vault selected.";
    elements.selectedHint.textContent = "Choose a vault to inspect deposit and claim calls.";
    return;
  }

  const investment = vault.investment ?? {};
  elements.selectedHint.textContent = `${vault.name} (${vault.ticker ?? vault.id})`;
  elements.vaultDetail.className = "detail-card";
  elements.vaultDetail.innerHTML = `
		<h3>${escapeHtml(vault.name)}</h3>
		<dl>
			<div><dt>Vault ID</dt><dd>${escapeHtml(vault.id)}</dd></div>
			<div><dt>Status</dt><dd class="${vault.status?.investable ? "status-good" : "status-bad"}">${vault.status?.investable ? "Investable" : "Not investable"}</dd></div>
			<div><dt>Escrow adapter</dt><dd>${escapeHtml(investment.escrowAdapter ?? "n/a")}</dd></div>
			<div><dt>Share token</dt><dd>${escapeHtml(investment.shareToken ?? vault.contracts?.shareToken ?? "n/a")}</dd></div>
			<div><dt>Settlement asset</dt><dd>${escapeHtml(investment.settlementAsset?.symbol ?? "n/a")} ${escapeHtml(investment.settlementAsset?.address ?? "")}</dd></div>
			<div><dt>Capacity remaining</dt><dd>${rawUsd(vault.capacity?.remainingRaw ?? "0")}</dd></div>
		</dl>
	`;
}

function renderBalances() {
  const entry = selectedBalanceEntry();
  if (!entry) {
    elements.balanceSummary.innerHTML =
      '<div class="empty-state">Connect a wallet and load balances.</div>';
    return;
  }

  const items = [
    ["Pending deposits", rawUsd(entry.pending.deposits.assetRaw)],
    ["Pending withdrawals", rawShares(entry.pending.withdrawals.sharesRaw)],
    ["Claimable shares", rawShares(entry.claimable.deposits.sharesRaw)],
    ["Claimable assets", rawUsd(entry.claimable.withdrawals.assetsRaw)],
  ];

  elements.balanceSummary.innerHTML = items
    .map(
      ([label, value]) => `
				<div class="metric">
					<span>${label}</span>
					<strong>${value}</strong>
				</div>
			`,
    )
    .join("");
}

async function connectWallet() {
  if (!window.ethereum) {
    throw new Error("No injected wallet found.");
  }
  const [address] = await window.ethereum.request({
    method: "eth_requestAccounts",
  });
  state.walletAddress = address;
  state.walletClient = createWalletClient({
    account: address,
    chain: polygon,
    transport: custom(window.ethereum),
  });
  elements.connectWallet.textContent = shortAddress(address);
  writeOutput({ connected: address });
}

async function ensurePolygon() {
  if (!window.ethereum) throw new Error("No injected wallet found.");
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: POLYGON_HEX_CHAIN_ID }],
    });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [POLYGON_PARAMS],
    });
  }
}

function requireReady() {
  if (!state.selectedVault) throw new Error("Select a vault first.");
  if (!state.walletAddress || !state.walletClient) {
    throw new Error("Connect a wallet first.");
  }
}

function getInvestment() {
  const investment = state.selectedVault?.investment;
  if (!investment?.escrowAdapter || !investment?.settlementAsset?.address) {
    throw new Error("Selected vault is missing investment metadata.");
  }
  return investment;
}

async function runDeposit() {
  requireReady();
  await ensurePolygon();

  const investment = getInvestment();
  const amount = parseUnits(elements.depositAmount.value || "0", 6);
  if (amount <= 0n) throw new Error("Enter a positive amount.");

  const escrowAdapter = investment.escrowAdapter;
  const pUSD = investment.settlementAsset.address;
  const assetMode = elements.depositAsset.value;
  const txs = [];

  if (assetMode === "usdce") {
    const usdce = investment.acceptedInputAssets?.find((asset) => asset.symbol === "USDC.e");
    if (!usdce?.address || !usdce?.wrapper) {
      throw new Error("USDC.e wrapper metadata is unavailable for this vault.");
    }

    txs.push(
      await state.walletClient.writeContract({
        address: usdce.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [usdce.wrapper, amount],
      }),
    );
    txs.push(
      await state.walletClient.writeContract({
        address: usdce.wrapper,
        abi: collateralOnrampAbi,
        functionName: "wrap",
        args: [usdce.address, state.walletAddress, amount],
      }),
    );
  }

  txs.push(
    await state.walletClient.writeContract({
      address: pUSD,
      abi: erc20Abi,
      functionName: "approve",
      args: [escrowAdapter, amount],
    }),
  );
  txs.push(
    await state.walletClient.writeContract({
      address: escrowAdapter,
      abi: escrowAdapterAbi,
      functionName: "depositAsset",
      args: [amount],
    }),
  );

  writeOutput({ action: "deposit", txs });
}

function showDepositCalls() {
  if (!state.selectedVault) throw new Error("Select a vault first.");
  const investment = getInvestment();
  const amount = parseUnits(elements.depositAmount.value || "0", 6);
  const assetMode = elements.depositAsset.value;
  const calls = [];

  if (assetMode === "usdce") {
    const usdce = investment.acceptedInputAssets?.find((asset) => asset.symbol === "USDC.e");
    calls.push(
      { to: usdce?.address, functionName: "approve", args: [usdce?.wrapper, amount.toString()] },
      {
        to: usdce?.wrapper,
        functionName: "wrap",
        args: [usdce?.address, "userAddress", amount.toString()],
      },
    );
  }

  calls.push(
    {
      to: investment.settlementAsset.address,
      functionName: "approve",
      args: [investment.escrowAdapter, amount.toString()],
    },
    {
      to: investment.escrowAdapter,
      functionName: "depositAsset",
      args: [amount.toString()],
    },
  );
  writeOutput({ action: "deposit-call-preview", calls });
}

async function loadBalances() {
  if (!state.walletAddress) throw new Error("Connect a wallet first.");
  const response = await fetchJson(`/addresses/${state.walletAddress}/balances?includeClaims=true`);
  state.balances = response.data;
  renderBalances();
  writeOutput(response);
}

function toDepositClaims(claims) {
  return claims.slice(0, 10).map((claim) => ({
    epoch: BigInt(claim.epochSolved),
    requestId: BigInt(claim.requestId),
    shares: BigInt(claim.shares),
    proof: claim.proof,
  }));
}

function toWithdrawalClaims(claims) {
  return claims.slice(0, 10).map((claim) => ({
    epoch: BigInt(claim.epochSolved),
    requestId: BigInt(claim.requestId),
    assets: BigInt(claim.assets),
    proof: claim.proof,
  }));
}

async function claimDeposits() {
  requireReady();
  await ensurePolygon();
  if (!state.balances) await loadBalances();

  const entry = selectedBalanceEntry();
  const claims = entry?.claimable.deposits.claims ?? [];
  if (claims.length === 0) throw new Error("No claimable deposit shares.");

  const txHash = await state.walletClient.writeContract({
    address: entry.escrowAdapter,
    abi: escrowAdapterAbi,
    functionName: "claimDeposits",
    args: [toDepositClaims(claims)],
  });
  writeOutput({ action: "claimDeposits", txHash });
}

async function claimWithdrawals() {
  requireReady();
  await ensurePolygon();
  if (!state.balances) await loadBalances();

  const entry = selectedBalanceEntry();
  const claims = entry?.claimable.withdrawals.claims ?? [];
  if (claims.length === 0) throw new Error("No claimable withdrawal assets.");

  const txHash = await state.walletClient.writeContract({
    address: entry.escrowAdapter,
    abi: escrowAdapterAbi,
    functionName: "claimWithdrawals",
    args: [toWithdrawalClaims(claims)],
  });
  writeOutput({ action: "claimWithdrawals", txHash });
}

async function prepareClaimBridge() {
  requireReady();
  const response = await fetchBackendJson(
    `/api/vaults/public/${state.selectedVault.id}/multi-chain/claim-and-bridge`,
    {
      method: "POST",
      body: JSON.stringify({
        owner: state.walletAddress,
        destinationChainId: Number(elements.destinationChainId.value),
      }),
    },
  );
  writeOutput(response);
}

async function prepareClaimAssets() {
  requireReady();
  const response = await fetchBackendJson(
    `/api/vaults/public/${state.selectedVault.id}/multi-chain/claim-assets`,
    {
      method: "POST",
      body: JSON.stringify({
        owner: state.walletAddress,
        destinationChainId: Number(elements.destinationChainId.value),
      }),
    },
  );
  writeOutput(response);
}

function formatNullableUsd(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : "n/a";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    appendOutput("Error", error?.message ?? String(error));
  }
}

elements.environment.addEventListener("change", () => {
  state.apiBase = elements.environment.value;
  state.selectedVault = null;
  state.balances = null;
  loadVaults().catch((error) => writeOutput(error.message));
});
elements.refreshVaults.addEventListener("click", () => runAction(() => loadVaults()));
elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction(() => loadVaults(elements.searchInput.value.trim()));
});
elements.connectWallet.addEventListener("click", () => runAction(connectWallet));
elements.runDeposit.addEventListener("click", () => runAction(runDeposit));
elements.showDepositCalldata.addEventListener("click", () => runAction(showDepositCalls));
elements.loadBalances.addEventListener("click", () => runAction(loadBalances));
elements.claimDeposits.addEventListener("click", () => runAction(claimDeposits));
elements.claimWithdrawals.addEventListener("click", () => runAction(claimWithdrawals));
elements.prepareClaimBridge.addEventListener("click", () => runAction(prepareClaimBridge));
elements.prepareClaimAssets.addEventListener("click", () => runAction(prepareClaimAssets));
elements.clearOutput.addEventListener("click", () => writeOutput("Ready."));

loadVaults().catch((error) => writeOutput(error.message));
