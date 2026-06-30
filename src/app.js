import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
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
  snapshots: null,
  apyHistory: null,
  positions: null,
  walletAddress: null,
  walletClient: null,
  publicClient: createPublicClient({
    chain: polygon,
    transport: http("https://polygon-rpc.com"),
  }),
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
  loadAnalytics: $("loadAnalytics"),
  performanceSummary: $("performanceSummary"),
  snapshotTrigger: $("snapshotTrigger"),
  loadSnapshots: $("loadSnapshots"),
  snapshotHistory: $("snapshotHistory"),
  apyPeriod: $("apyPeriod"),
  loadApyHistory: $("loadApyHistory"),
  apyHistory: $("apyHistory"),
  loadPositions: $("loadPositions"),
  positionBasket: $("positionBasket"),
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
  status: $("status"),
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

function getErrorMessage(error) {
  return (
    error?.shortMessage ??
    error?.details ??
    error?.cause?.shortMessage ??
    error?.cause?.message ??
    error?.message ??
    String(error)
  );
}

function setStatus(message, tone = "info") {
  elements.status.textContent = message;
  elements.status.className = `status-line ${tone}`;
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

function rawTokenAmount(value, decimals, suffix = "", maximumFractionDigits = 4) {
  if (value === null || value === undefined || value === "") return "n/a";
  try {
    const formatted = formatUnits(BigInt(value), decimals);
    const numeric = Number(formatted);
    const display = Number.isFinite(numeric)
      ? numeric.toLocaleString(undefined, { maximumFractionDigits })
      : formatted;
    return suffix ? `${display} ${suffix}` : display;
  } catch {
    return "n/a";
  }
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  const maximumFractionDigits = Math.abs(value) >= 100 ? 1 : 2;
  return `${value.toLocaleString(undefined, { maximumFractionDigits })}%`;
}

function formatUsdNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : "n/a";
}

function formatDateTime(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function requireSelectedVault() {
  if (!state.selectedVault) throw new Error("Select a vault first.");
  return state.selectedVault;
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
  state.snapshots = null;
  state.apyHistory = null;
  state.positions = null;
  renderVaultList();
  renderVaultDetail();
  renderAnalytics();
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
			<div><dt>Headline APY</dt><dd>${escapeHtml(formatPercent(vault.metrics?.apy ?? vault.performance?.apy))}</dd></div>
			<div><dt>Realizable NAV</dt><dd>${escapeHtml(rawTokenAmount(vault.latestSnapshot?.realizableNavRaw, 6, "USD", 2))}</dd></div>
			<div><dt>Realizable PPS</dt><dd>${escapeHtml(rawTokenAmount(vault.latestSnapshot?.realizablePpsRaw, 18))}</dd></div>
			<div><dt>Capacity remaining</dt><dd>${rawUsd(vault.capacity?.remainingRaw ?? "0")}</dd></div>
		</dl>
	`;
}

function renderAnalytics() {
  renderPerformanceSummary();
  renderSnapshots();
  renderApyHistory();
  renderPositions();
}

function renderPerformanceSummary() {
  const vault = state.selectedVault;
  if (!vault) {
    elements.performanceSummary.innerHTML = "";
    return;
  }

  const latest = vault.latestSnapshot ?? {};
  const performance = vault.performance ?? {};
  const metrics = [
    ["Headline APY", formatPercent(vault.metrics?.apy ?? performance.apy)],
    ["Projected APY", formatPercent(performance.projectedApy)],
    ["24h APY", formatPercent(latest.apy24h ?? performance.apy24h)],
    ["7d APY", formatPercent(latest.apy7d ?? performance.apy7d)],
    ["30d APY", formatPercent(latest.apy30d ?? performance.apy30d)],
    ["PPS 24h", formatPercent(performance.ppsChange24h)],
    ["Projected NAV", rawTokenAmount(latest.projectedNavRaw, 6, "USD", 2)],
    ["Snapshot", formatDateTime(latest.snapshotAt)],
  ];

  elements.performanceSummary.innerHTML = metrics
    .map(
      ([label, value]) => `
				<div class="metric compact-metric">
					<span>${escapeHtml(label)}</span>
					<strong>${escapeHtml(value)}</strong>
				</div>
			`,
    )
    .join("");
}

function renderSnapshots() {
  const rows = state.snapshots?.data ?? null;
  if (!state.selectedVault) {
    elements.snapshotHistory.className = "empty-state";
    elements.snapshotHistory.textContent = "Select a vault.";
    return;
  }
  if (!rows) {
    elements.snapshotHistory.className = "empty-state";
    elements.snapshotHistory.textContent = "Load snapshot history.";
    return;
  }
  if (rows.length === 0) {
    elements.snapshotHistory.className = "empty-state";
    elements.snapshotHistory.textContent = "No snapshots returned.";
    return;
  }

  elements.snapshotHistory.className = "table-wrap";
  elements.snapshotHistory.innerHTML = `
		<table>
			<thead>
				<tr>
					<th>Time</th>
					<th>Type</th>
					<th>Epoch</th>
					<th>NAV</th>
					<th>PPS</th>
					<th>APY 30d</th>
				</tr>
			</thead>
			<tbody>
				${rows
          .map(
            (row) => `
					<tr>
						<td>${escapeHtml(formatDateTime(row.snapshotAt))}</td>
						<td>${escapeHtml(row.triggerType ?? "n/a")}</td>
						<td>${escapeHtml(row.epoch ?? "n/a")}</td>
						<td>${escapeHtml(rawTokenAmount(row.realizableNavRaw, 6, "USD", 2))}</td>
						<td>${escapeHtml(rawTokenAmount(row.realizablePpsRaw, 18))}</td>
						<td>${escapeHtml(formatPercent(row.apy30d))}</td>
					</tr>
				`,
          )
          .join("")}
			</tbody>
		</table>
	`;
}

function renderApyHistory() {
  const rows = state.apyHistory?.data ?? null;
  if (!state.selectedVault) {
    elements.apyHistory.className = "empty-state";
    elements.apyHistory.textContent = "Select a vault.";
    return;
  }
  if (!rows) {
    elements.apyHistory.className = "empty-state";
    elements.apyHistory.textContent = "Load APY history.";
    return;
  }
  if (rows.length === 0) {
    elements.apyHistory.className = "empty-state";
    elements.apyHistory.textContent = "No APY history returned.";
    return;
  }

  elements.apyHistory.className = "table-wrap";
  elements.apyHistory.innerHTML = `
		<table>
			<thead>
				<tr>
					<th>Time</th>
					<th>APY</th>
					<th>Projected</th>
					<th>Annualized</th>
					<th>Epoch</th>
				</tr>
			</thead>
			<tbody>
				${rows
          .map(
            (row) => `
					<tr>
						<td>${escapeHtml(formatDateTime(row.timestamp))}</td>
						<td>${escapeHtml(formatPercent(row.apy))}</td>
						<td>${escapeHtml(formatPercent(row.projectedApy))}</td>
						<td>${escapeHtml(formatPercent(row.annualizedApy))}</td>
						<td>${escapeHtml(row.epoch ?? "n/a")}</td>
					</tr>
				`,
          )
          .join("")}
			</tbody>
		</table>
	`;
}

function renderPositions() {
  const rows = state.positions?.data ?? null;
  if (!state.selectedVault) {
    elements.positionBasket.className = "empty-state";
    elements.positionBasket.textContent = "Select a vault.";
    return;
  }
  if (!rows) {
    elements.positionBasket.className = "empty-state";
    elements.positionBasket.textContent = "Load positions.";
    return;
  }
  if (rows.length === 0) {
    elements.positionBasket.className = "empty-state";
    elements.positionBasket.textContent = "No positions returned.";
    return;
  }

  elements.positionBasket.className = "table-wrap";
  elements.positionBasket.innerHTML = `
		<table>
			<thead>
				<tr>
					<th>Market</th>
					<th>Outcome</th>
					<th>Size</th>
					<th>Price</th>
					<th>Value</th>
				</tr>
			</thead>
			<tbody>
				${rows
          .map(
            (row) => `
					<tr>
						<td>
							${
                row.polymarketUrl
                  ? `<a href="${escapeHtml(row.polymarketUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.marketQuestion ?? row.conditionId ?? "Market")}</a>`
                  : escapeHtml(row.marketQuestion ?? row.conditionId ?? "Market")
              }
						</td>
						<td>${escapeHtml(row.outcome ?? "n/a")}</td>
						<td>${escapeHtml(formatPositionNumber(row.size))}</td>
						<td>${escapeHtml(formatPositionNumber(row.curPrice))}</td>
						<td>${escapeHtml(formatUsdNumber(row.currentValue))}</td>
					</tr>
				`,
          )
          .join("")}
			</tbody>
		</table>
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

function formatPositionNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

async function loadSnapshots({ silent = false } = {}) {
  const vault = requireSelectedVault();
  const params = new URLSearchParams({ limit: "50", offset: "0" });
  if (elements.snapshotTrigger.value) {
    params.set("triggerType", elements.snapshotTrigger.value);
  }

  const response = await fetchJson(`/vaults/${encodeURIComponent(vault.id)}/snapshots?${params}`);
  state.snapshots = response;
  renderSnapshots();
  if (!silent) writeOutput(response);
  return response;
}

async function loadApyHistory({ silent = false } = {}) {
  const vault = requireSelectedVault();
  const params = new URLSearchParams({
    period: elements.apyPeriod.value || "30d",
    limit: "100",
  });

  const response = await fetchJson(`/vaults/${encodeURIComponent(vault.id)}/apy-history?${params}`);
  state.apyHistory = response;
  renderApyHistory();
  if (!silent) writeOutput(response);
  return response;
}

async function loadPositions({ silent = false } = {}) {
  const vault = requireSelectedVault();
  const response = await fetchJson(`/vaults/${encodeURIComponent(vault.id)}/positions?limit=25`);
  state.positions = response;
  renderPositions();
  if (!silent) writeOutput(response);
  return response;
}

async function loadAnalytics() {
  requireSelectedVault();
  const results = await Promise.allSettled([
    loadSnapshots({ silent: true }),
    loadApyHistory({ silent: true }),
    loadPositions({ silent: true }),
  ]);

  const summary = {
    action: "load-analytics",
    snapshots: settledSummary(results[0]),
    apyHistory: settledSummary(results[1]),
    positions: settledSummary(results[2]),
  };
  writeOutput(summary);

  const failures = Object.entries(summary)
    .filter(([, value]) => value?.ok === false)
    .map(([key, value]) => `${key}: ${value.error}`);
  if (failures.length > 0) {
    setStatus(`Loaded analytics with ${failures.length} warning(s).`, "success");
    appendOutput("Warnings", failures);
  }
}

function settledSummary(result) {
  if (result.status === "fulfilled") {
    return {
      ok: true,
      count: Array.isArray(result.value?.data)
        ? result.value.data.length
        : (result.value?.count ?? result.value?.totalCount ?? 0),
    };
  }
  return { ok: false, error: getErrorMessage(result.reason) };
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
  state.publicClient = createPublicClient({
    chain: polygon,
    transport: custom(window.ethereum),
  });
  elements.connectWallet.textContent = shortAddress(address);
  setStatus(`Connected ${shortAddress(address)}.`, "success");
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

async function writeContractStep(label, request) {
  setStatus(`Waiting for wallet confirmation: ${label}.`, "pending");
  appendOutput("Wallet prompt", label);

  const txHash = await state.walletClient.writeContract({
    account: state.walletAddress,
    chain: polygon,
    ...request,
  });

  appendOutput("Submitted", { label, txHash });
  setStatus(`Waiting for Polygon confirmation: ${label}.`, "pending");

  const receipt = await state.publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  if (receipt.status !== "success") {
    throw new Error(`${label} reverted: ${txHash}`);
  }

  appendOutput("Confirmed", { label, txHash, blockNumber: receipt.blockNumber.toString() });
  return txHash;
}

async function runDeposit() {
  requireReady();
  setStatus("Switching wallet to Polygon.", "pending");
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
      await writeContractStep("Approve USDC.e wrapper", {
        address: usdce.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [usdce.wrapper, amount],
      }),
    );
    txs.push(
      await writeContractStep("Wrap USDC.e to pUSD", {
        address: usdce.wrapper,
        abi: collateralOnrampAbi,
        functionName: "wrap",
        args: [usdce.address, state.walletAddress, amount],
      }),
    );
  }

  txs.push(
    await writeContractStep("Approve pUSD deposit", {
      address: pUSD,
      abi: erc20Abi,
      functionName: "approve",
      args: [escrowAdapter, amount],
    }),
  );
  txs.push(
    await writeContractStep("Deposit into vault", {
      address: escrowAdapter,
      abi: escrowAdapterAbi,
      functionName: "depositAsset",
      args: [amount],
    }),
  );

  setStatus("Deposit submitted and confirmed.", "success");
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
    account: state.walletAddress,
    chain: polygon,
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
    account: state.walletAddress,
    chain: polygon,
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

async function runAction(action, label, button) {
  const previousDisabled = button?.disabled ?? false;
  if (button) button.disabled = true;
  setStatus(label, "pending");
  appendOutput("Status", label);

  try {
    await action();
    if (!elements.status.classList.contains("error")) {
      setStatus("Done.", "success");
    }
  } catch (error) {
    const message = getErrorMessage(error);
    setStatus(message, "error");
    appendOutput("Error", message);
  } finally {
    if (button) button.disabled = previousDisabled;
  }
}

elements.environment.addEventListener("change", () => {
  state.apiBase = elements.environment.value;
  state.selectedVault = null;
  state.balances = null;
  state.snapshots = null;
  state.apyHistory = null;
  state.positions = null;
  renderVaultDetail();
  renderAnalytics();
  renderBalances();
  loadVaults().catch((error) => writeOutput(error.message));
});
elements.refreshVaults.addEventListener("click", (event) =>
  runAction(() => loadVaults(), "Loading vaults.", event.currentTarget),
);
elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction(() => loadVaults(elements.searchInput.value.trim()), "Searching vaults.");
});
elements.connectWallet.addEventListener("click", (event) =>
  runAction(connectWallet, "Connecting wallet.", event.currentTarget),
);
elements.loadAnalytics.addEventListener("click", (event) =>
  runAction(loadAnalytics, "Loading analytics.", event.currentTarget),
);
elements.loadSnapshots.addEventListener("click", (event) =>
  runAction(loadSnapshots, "Loading snapshot history.", event.currentTarget),
);
elements.loadApyHistory.addEventListener("click", (event) =>
  runAction(loadApyHistory, "Loading APY history.", event.currentTarget),
);
elements.loadPositions.addEventListener("click", (event) =>
  runAction(loadPositions, "Loading position basket.", event.currentTarget),
);
elements.runDeposit.addEventListener("click", (event) =>
  runAction(runDeposit, "Starting deposit. Watch your wallet for prompts.", event.currentTarget),
);
elements.showDepositCalldata.addEventListener("click", (event) =>
  runAction(showDepositCalls, "Building deposit call preview.", event.currentTarget),
);
elements.loadBalances.addEventListener("click", (event) =>
  runAction(loadBalances, "Loading balances and claims.", event.currentTarget),
);
elements.claimDeposits.addEventListener("click", (event) =>
  runAction(claimDeposits, "Claiming vault shares.", event.currentTarget),
);
elements.claimWithdrawals.addEventListener("click", (event) =>
  runAction(claimWithdrawals, "Claiming withdrawal assets.", event.currentTarget),
);
elements.prepareClaimBridge.addEventListener("click", (event) =>
  runAction(prepareClaimBridge, "Preparing multi-chain share claim.", event.currentTarget),
);
elements.prepareClaimAssets.addEventListener("click", (event) =>
  runAction(prepareClaimAssets, "Preparing multi-chain asset claim.", event.currentTarget),
);
elements.clearOutput.addEventListener("click", () => writeOutput("Ready."));

loadVaults().catch((error) => writeOutput(error.message));
