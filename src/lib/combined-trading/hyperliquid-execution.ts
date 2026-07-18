import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { prisma } from "@/src/lib/server/prisma";

type TestnetOrderRequest = {
  action: "open" | "close" | "rest";
  asset: "BTC" | "ETH" | "SOL" | "XRP";
  isBuy: boolean;
  size: number;
  referencePrice: number;
  clientOrderId: string;
};

type TestnetCancelRequest = Pick<TestnetOrderRequest, "asset" | "clientOrderId">;

export type HyperliquidOrderEvidence = {
  recognized: boolean;
  status: "UNKNOWN" | "ACCEPTED" | "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "REJECTED";
  exchangeStatus: string | null;
  exchangeOrderId: string | null;
  filledQuantity: number;
  averageFillPrice: number | null;
  feePaid: number;
  reason: string | null;
};

export class HyperliquidDefinitiveOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HyperliquidDefinitiveOrderError";
  }
}

export type TestnetOrderMismatch = {
  kind: "missing" | "orphan";
  asset: string | null;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
};

type ExecutorResponse = {
  ok: boolean;
  environment: "testnet";
  accountValue?: number;
  sdkVersion?: string;
  apiUrl?: string;
  availableAssets?: string[];
  result?: unknown;
  positions?: Array<{ coin?: string; size?: number; entryPrice?: number; positionValue?: number; unrealizedPnl?: number; liquidationPrice?: number }>;
  openOrders?: unknown[];
  recentFills?: unknown[];
  orderStatuses?: Array<{ clientOrderId?: string; exchangeCloid?: string; result?: unknown }>;
  cancelResults?: Array<{ asset?: string; oid?: string | number; result?: unknown }>;
  flattenResults?: Array<{ asset?: string; size?: number; clientOrderId?: string; result?: unknown }>;
  error?: string;
};

export type TestnetAccountSafety = ReturnType<typeof evaluateTestnetAccountSafety>;

type TestnetEmergencyCleanupDependencies = {
  cancelOutstanding: () => Promise<{
    verified: boolean;
    attempted: number;
    cancelled: number;
    failed: number;
    remainingOpenOrders: unknown[];
  }>;
  flattenPositions: () => Promise<{
    verified: boolean;
    attempted: number;
    flattened: number;
    failed: number;
    remainingPositions: Array<{ coin?: string; size?: number }>;
  }>;
  reconcile: () => Promise<{
    connected: boolean;
    openOrders: unknown[];
    positions: Array<{ coin?: string; size?: number }>;
    orderMismatches: unknown[];
    positionMismatches: unknown[];
  }>;
};

export function getHyperliquidExecutionReadiness() {
  const python = executorPython();
  const installed = existsSync(python) && existsSync(executorScript());
  const accountConfigured = Boolean(process.env.HYPERLIQUID_ACCOUNT_ADDRESS?.trim());
  const directApiWalletConfigured = Boolean(process.env.HYPERLIQUID_API_WALLET_PRIVATE_KEY?.trim());
  const defaultApiWalletKeyFile = resolve(homedir(), ".polymarket-watch/secrets/hyperliquid-testnet-api-wallet.key");
  const apiWalletKeyFile = process.env.HYPERLIQUID_API_WALLET_KEY_FILE?.trim()
    || (existsSync(defaultApiWalletKeyFile) ? defaultApiWalletKeyFile : null);
  const apiWalletKeyFileConfigured = apiWalletKeyFile ? securePrivateKeyFileExists(apiWalletKeyFile) : false;
  const apiWalletConfigured = directApiWalletConfigured || apiWalletKeyFileConfigured;
  const enabled = process.env.HYPERLIQUID_TESTNET_ENABLED === "1";
  const autoMirrorEnabled = process.env.HYPERLIQUID_TESTNET_AUTO_MIRROR === "1";
  const supportedAssets = supportedTestnetAssets();
  const setupBlockers = [
    ...(!installed ? ["connector_not_installed" as const] : []),
    ...(!apiWalletConfigured ? ["api_wallet_not_configured" as const] : []),
    ...(!accountConfigured ? ["master_account_not_configured" as const] : []),
    ...(!enabled ? ["execution_not_enabled" as const] : []),
  ];
  const nextStep = !installed
    ? "testnetコネクターをインストール"
    : !apiWalletConfigured
      ? "専用API Walletを作成"
      : !accountConfigured
        ? "マスター口座でAPI Walletを承認し、口座アドレスを登録"
        : !enabled
          ? "testnet残高とAPI Wallet承認を確認して検証を有効化"
          : "発注・取消・照合の検証スイートを実行";
  return {
    environment: "testnet" as const,
    installed,
    accountConfigured,
    apiWalletConfigured,
    apiWalletKeySource: directApiWalletConfigured ? "environment" as const : apiWalletKeyFileConfigured ? "file" as const : null,
    enabled,
    autoMirrorEnabled,
    supportedAssets,
    setupBlockers,
    nextStep,
    ready: installed && accountConfigured && apiWalletConfigured && enabled,
    maximumNotionalUsd: maximumTestnetNotional(),
    mainnetSupported: false,
  };
}

export async function checkHyperliquidTestnetConnection() {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.installed) return { ...readiness, transportConnected: false, connected: false };
  const transport = await checkHyperliquidTestnetTransport();
  if (!readiness.accountConfigured) return { ...readiness, ...transport, connected: false };
  const response = await runReadOnlyExecutor({ action: "readiness" });
  return { ...readiness, ...transport, connected: response.ok, accountValue: response.accountValue ?? null };
}

export async function checkHyperliquidTestnetTransport() {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.installed) {
    return { transportConnected: false, sdkVersion: null, apiUrl: null, availableAssets: [] as string[] };
  }
  const response = await runReadOnlyExecutor({ action: "diagnostics" });
  return {
    transportConnected: response.ok,
    sdkVersion: response.sdkVersion ?? null,
    apiUrl: response.apiUrl ?? null,
    availableAssets: response.availableAssets ?? [],
  };
}

export async function executeHyperliquidTestnetOrder(request: TestnetOrderRequest) {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.ready) throw new HyperliquidDefinitiveOrderError("Hyperliquid testnet execution is not armed");
  if (!readiness.supportedAssets.includes(request.asset)) {
    throw new HyperliquidDefinitiveOrderError(`${request.asset} is not available on the configured Hyperliquid testnet universe`);
  }
  if (!Number.isFinite(request.size) || request.size <= 0 || !Number.isFinite(request.referencePrice) || request.referencePrice <= 0) {
    throw new HyperliquidDefinitiveOrderError("invalid Hyperliquid testnet order size or price");
  }
  const notional = request.size * request.referencePrice;
  if (request.action !== "close" && notional > readiness.maximumNotionalUsd + 0.0001) {
    throw new HyperliquidDefinitiveOrderError(`Hyperliquid testnet order exceeds $${readiness.maximumNotionalUsd} limit`);
  }
  if (request.action !== "close") await assertRecentTestnetReconciliation();
  const response = await runExecutor({ ...request, slippage: 0.01 });
  if (!response.ok) throw new Error(response.error ?? "Hyperliquid testnet order failed");
  const evidence = normalizeHyperliquidFillAgainstRequestedQuantity(
    parseHyperliquidOrderEvidence(response.result, "order"),
    request.size,
  );
  if (evidence.status === "REJECTED") {
    throw new HyperliquidDefinitiveOrderError(evidence.reason ?? "Hyperliquid testnet order was rejected");
  }
  return { ...response, evidence };
}

export async function cancelHyperliquidTestnetOrder(request: TestnetCancelRequest) {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.ready) throw new Error("Hyperliquid testnet execution is not armed");
  const response = await runExecutor({ action: "cancel", ...request });
  if (!response.ok) throw new Error(response.error ?? "Hyperliquid testnet cancellation failed");
  const evidence = parseHyperliquidOrderEvidence(response.result, "cancel");
  if (evidence.status === "REJECTED") throw new Error(evidence.reason ?? "Hyperliquid testnet cancellation was rejected");
  await prisma.combinedExecutionOrder.updateMany({
    where: { environment: "TESTNET", clientOrderId: request.clientOrderId },
    data: {
      status: evidence.status,
      exchangeStatus: evidence.exchangeStatus,
      ...(evidence.exchangeOrderId ? { exchangeOrderId: evidence.exchangeOrderId } : {}),
      responseJson: JSON.stringify(response.result ?? null),
      lastReconciledAt: new Date(),
    },
  });
  return { ...response, evidence };
}

export async function cancelOutstandingHyperliquidTestnetOrders() {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.ready) {
    return { ...readiness, verified: false, attempted: 0, cancelled: 0, failed: 0, remainingOpenOrders: [] };
  }
  const response = await runExecutor({ action: "cancel_all" });
  if (!response.ok) throw new Error(response.error ?? "Hyperliquid testnet cancellation failed");

  let cancelled = 0;
  let failed = 0;
  for (const item of response.cancelResults ?? []) {
    const evidence = parseHyperliquidOrderEvidence(item.result, "cancel");
    if (evidence.status === "CANCELLED") cancelled += 1;
    else failed += 1;
  }

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  const reconciliation = await reconcileHyperliquidTestnetOrders();
  return {
    ...readiness,
    verified: reconciliation.connected
      && reconciliation.openOrders.length === 0
      && reconciliation.orderMismatches.length === 0,
    attempted: response.cancelResults?.length ?? 0,
    cancelled,
    failed,
    remainingOpenOrders: reconciliation.openOrders,
  };
}

export async function flattenHyperliquidTestnetPositions() {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.ready) {
    return { ...readiness, verified: false, attempted: 0, flattened: 0, failed: 0, remainingPositions: [] };
  }
  const response = await runExecutor({
    action: "flatten",
    clientOrderPrefix: crypto.randomUUID(),
    slippage: 0.01,
  });
  if (!response.ok) throw new Error(response.error ?? "Hyperliquid testnet position flatten failed");

  const run = await prisma.combinedShadowRun.findFirst({ orderBy: { startedAt: "desc" } });
  let flattened = 0;
  let failed = 0;
  for (const item of response.flattenResults ?? []) {
    if (!item.asset || !item.clientOrderId || typeof item.size !== "number" || item.size === 0) {
      failed += 1;
      continue;
    }
    const evidence = parseHyperliquidOrderEvidence(item.result, "order");
    if (evidence.status === "FILLED") flattened += 1;
    else failed += 1;
    if (run) {
      await prisma.combinedExecutionOrder.create({
        data: {
          id: crypto.randomUUID(),
          runId: run.id,
          environment: "TESTNET",
          clientOrderId: item.clientOrderId,
          exchangeOrderId: evidence.exchangeOrderId,
          exchangeStatus: evidence.exchangeStatus,
          asset: item.asset,
          side: item.size > 0 ? "LONG" : "SHORT",
          action: "FLATTEN",
          quantity: Math.abs(item.size),
          filledQuantity: evidence.filledQuantity,
          averageFillPrice: evidence.averageFillPrice,
          feePaid: evidence.feePaid,
          referencePrice: evidence.averageFillPrice,
          status: evidence.status,
          reason: evidence.reason ?? "emergency position flatten",
          responseJson: JSON.stringify(item.result ?? null),
          lastReconciledAt: new Date(),
        },
      });
    }
  }

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  const reconciliation = await reconcileHyperliquidTestnetOrders();
  const remainingPositions = reconciliation.positions.filter((position) => (
    position.coin
    && Math.abs(position.size ?? 0) > 1e-8
  ));
  return {
    ...readiness,
    verified: reconciliation.connected
      && remainingPositions.length === 0
      && reconciliation.positionMismatches.length === 0,
    attempted: response.flattenResults?.length ?? 0,
    flattened,
    failed,
    remainingPositions,
  };
}

export async function performHyperliquidTestnetEmergencyCleanup(
  dependencies: Partial<TestnetEmergencyCleanupDependencies> = {},
) {
  const cancelOutstanding = dependencies.cancelOutstanding ?? cancelOutstandingHyperliquidTestnetOrders;
  const flattenPositions = dependencies.flattenPositions ?? flattenHyperliquidTestnetPositions;
  const reconcile = dependencies.reconcile ?? reconcileHyperliquidTestnetOrders;
  const issues: string[] = [];
  let cancellation: Awaited<ReturnType<TestnetEmergencyCleanupDependencies["cancelOutstanding"]>> | null = null;
  let flatten: Awaited<ReturnType<TestnetEmergencyCleanupDependencies["flattenPositions"]>> | null = null;

  try {
    cancellation = await cancelOutstanding();
    if (!cancellation.verified || cancellation.failed > 0 || cancellation.remainingOpenOrders.length > 0) {
      issues.push(`cancel-unverified:${cancellation.failed}:${cancellation.remainingOpenOrders.length}`);
    }
  } catch (error) {
    issues.push(`cancel-error:${errorMessage(error)}`);
  }

  try {
    flatten = await flattenPositions();
    if (!flatten.verified || flatten.failed > 0 || flatten.remainingPositions.length > 0) {
      issues.push(`flatten-unverified:${flatten.failed}:${flatten.remainingPositions.length}`);
    }
  } catch (error) {
    issues.push(`flatten-error:${errorMessage(error)}`);
  }

  try {
    const finalReconciliation = await reconcile();
    const remainingPositions = finalReconciliation.positions.filter((position) => Math.abs(position.size ?? 0) > 1e-8);
    const verified = finalReconciliation.connected
      && finalReconciliation.openOrders.length === 0
      && remainingPositions.length === 0
      && finalReconciliation.orderMismatches.length === 0
      && finalReconciliation.positionMismatches.length === 0;
    if (!verified) issues.push("final-reconciliation-unverified");
    return {
      verified,
      cancellation,
      flatten,
      final: {
        connected: finalReconciliation.connected,
        openOrders: finalReconciliation.openOrders.length,
        positions: remainingPositions.length,
        orderMismatches: finalReconciliation.orderMismatches.length,
        positionMismatches: finalReconciliation.positionMismatches.length,
      },
      issues,
    };
  } catch (error) {
    issues.push(`reconcile-error:${errorMessage(error)}`);
    return {
      verified: false,
      cancellation,
      flatten,
      final: null,
      issues,
    };
  }
}

export async function reconcileHyperliquidTestnetOrders() {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.installed || !readiness.accountConfigured) {
    return {
      ...readiness,
      connected: false,
      accountValue: null,
      capturedAt: null,
      checkedOrders: 0,
      updatedOrders: 0,
      positions: [],
      openOrders: [],
      recentFills: [],
      orderMismatches: [],
      positionMismatches: [],
      safety: evaluateTestnetAccountSafety({
        accountValue: null,
        previousAccountValue: null,
        orderMismatchCount: 0,
        positionMismatchCount: 0,
      }),
    };
  }
  const orders = await prisma.combinedExecutionOrder.findMany({
    where: { environment: "TESTNET", status: { in: ["SUBMITTED", "PENDING", "UNKNOWN", "ACCEPTED", "OPEN", "PARTIALLY_FILLED"] } },
    orderBy: [{ lastReconciledAt: "asc" }, { createdAt: "asc" }],
  });
  const responses: ExecutorResponse[] = [];
  for (const clientOrderIds of planTestnetReconciliationBatches(orders.map((order) => order.clientOrderId))) {
    responses.push(await runReadOnlyExecutor({ action: "reconcile", clientOrderIds }));
  }
  const response = responses.at(-1);
  if (!response) throw new Error("Hyperliquid testnet reconciliation returned no account state");
  const orderStatuses = responses.flatMap((item) => item.orderStatuses ?? []);

  const fillsByOrder = aggregateHyperliquidFills(response.recentFills ?? []);
  let updatedOrders = 0;
  for (const status of orderStatuses) {
    if (!status.clientOrderId) continue;
    const evidence = parseHyperliquidOrderEvidence(status.result, "query");
    if (!evidence.recognized) continue;
    const fills = evidence.exchangeOrderId ? fillsByOrder.get(evidence.exchangeOrderId) : null;
    const filledQuantity = fills?.filledQuantity ?? evidence.filledQuantity;
    const normalized = evidence.status === "OPEN" && filledQuantity > 0 ? "PARTIALLY_FILLED" : evidence.status;
    const result = await prisma.combinedExecutionOrder.updateMany({
      where: { clientOrderId: status.clientOrderId, environment: "TESTNET" },
      data: {
        status: normalized,
        exchangeStatus: evidence.exchangeStatus,
        ...(evidence.exchangeOrderId ? { exchangeOrderId: evidence.exchangeOrderId } : {}),
        ...(filledQuantity > 0 ? { filledQuantity } : {}),
        ...((fills?.averageFillPrice ?? evidence.averageFillPrice) !== null
          ? { averageFillPrice: fills?.averageFillPrice ?? evidence.averageFillPrice }
          : {}),
        ...((fills?.feePaid ?? evidence.feePaid) > 0 ? { feePaid: fills?.feePaid ?? evidence.feePaid } : {}),
        ...(evidence.reason ? { reason: evidence.reason } : {}),
        responseJson: JSON.stringify(status),
        lastReconciledAt: new Date(),
      },
    });
    updatedOrders += result.count;
  }

  const activeOrders = await prisma.combinedExecutionOrder.findMany({
    where: { environment: "TESTNET", status: { in: ["SUBMITTED", "PENDING", "UNKNOWN", "ACCEPTED", "OPEN", "PARTIALLY_FILLED"] } },
    select: { asset: true, clientOrderId: true, exchangeOrderId: true, status: true, createdAt: true },
  });
  const orderMismatches = compareTestnetOpenOrders(response.openOrders ?? [], activeOrders);

  const filledOrders = await prisma.combinedExecutionOrder.findMany({
    where: {
      environment: "TESTNET",
      OR: [{ filledQuantity: { gt: 0 } }, { status: "FILLED" }],
    },
    orderBy: { createdAt: "asc" },
    select: { asset: true, side: true, action: true, quantity: true, filledQuantity: true, status: true },
  });
  const positionMismatches = compareTestnetPositions(response.positions ?? [], filledOrders);
  const highWaterWindowStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const [previousAccount, recentHighWater] = await Promise.all([
    prisma.combinedExecutionAccountSnapshot.findFirst({
      where: { environment: "TESTNET" },
      orderBy: { capturedAt: "desc" },
    }),
    prisma.combinedExecutionAccountSnapshot.aggregate({
      where: { environment: "TESTNET", capturedAt: { gte: highWaterWindowStartedAt } },
      _max: { accountValue: true },
    }),
  ]);
  const accountValue = response.accountValue ?? null;
  const safety = evaluateTestnetAccountSafety({
    accountValue,
    previousAccountValue: previousAccount?.accountValue ?? null,
    highWaterAccountValue: recentHighWater._max.accountValue ?? null,
    orderMismatchCount: orderMismatches.length,
    positionMismatchCount: positionMismatches.length,
  });
  const capturedAt = new Date();
  if (accountValue !== null && Number.isFinite(accountValue)) {
    await prisma.combinedExecutionAccountSnapshot.create({
      data: {
        id: crypto.randomUUID(),
        environment: "TESTNET",
        accountValue,
        accountLossPct: safety.accountLossPct,
        openOrderCount: response.openOrders?.length ?? 0,
        positionCount: response.positions?.length ?? 0,
        orderMismatchCount: orderMismatches.length,
        positionMismatchCount: positionMismatches.length,
        healthy: safety.healthy,
        issuesJson: JSON.stringify(safety.issues),
        capturedAt,
      },
    });
  }

  return {
    ...readiness,
    connected: true,
    accountValue,
    capturedAt: capturedAt.toISOString(),
    checkedOrders: orders.length,
    updatedOrders,
    positions: response.positions ?? [],
    openOrders: response.openOrders ?? [],
    recentFills: response.recentFills ?? [],
    orderMismatches,
    positionMismatches,
    safety,
  };
}

export async function runHyperliquidTestnetSmokeTest(input: {
  asset: "BTC" | "ETH" | "SOL" | "XRP";
  notionalUsd: number;
  referencePrice: number;
}) {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.ready) throw new HyperliquidDefinitiveOrderError("Hyperliquid testnet execution is not armed");
  if (!readiness.supportedAssets.includes(input.asset)) {
    throw new HyperliquidDefinitiveOrderError(`${input.asset} is not available on the configured Hyperliquid testnet universe`);
  }
  const before = await reconcileHyperliquidTestnetOrders();
  const hasExistingExposure = before.openOrders.length > 0
    || before.positions.some((position) => Math.abs(position.size ?? 0) > 1e-8)
    || before.orderMismatches.length > 0
    || before.positionMismatches.length > 0;
  if (!before.safety.healthy || hasExistingExposure) {
    throw new HyperliquidDefinitiveOrderError("testnet smoke test requires a reconciled account with no orders or positions");
  }
  const run = await prisma.combinedShadowRun.findFirst({ where: { status: "running" }, orderBy: { startedAt: "desc" } });
  if (!run) throw new HyperliquidDefinitiveOrderError("testnet smoke test requires an active shadow run");
  const quantity = normalizeTestnetSmokeOrderSize(
    input.asset,
    input.notionalUsd,
    input.referencePrice,
    readiness.maximumNotionalUsd,
  );
  let openEvidence: HyperliquidOrderEvidence | null = null;
  let closeEvidence: HyperliquidOrderEvidence | null = null;
  try {
    openEvidence = await executeTrackedTestnetOrder({
      runId: run.id,
      asset: input.asset,
      side: "LONG",
      action: "OPEN",
      isBuy: true,
      quantity,
      referencePrice: input.referencePrice,
      reason: "manual testnet smoke open",
    });
    if (openEvidence.filledQuantity <= 0) {
      throw new Error("testnet smoke open did not produce a verified fill");
    }
    closeEvidence = await executeTrackedTestnetOrder({
      runId: run.id,
      asset: input.asset,
      side: "LONG",
      action: "CLOSE",
      isBuy: false,
      quantity: openEvidence.filledQuantity,
      referencePrice: input.referencePrice,
      reason: "manual testnet smoke close",
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    const after = await reconcileHyperliquidTestnetOrders();
    const verified = after.safety.healthy
      && after.openOrders.length === 0
      && after.positions.every((position) => Math.abs(position.size ?? 0) <= 1e-8)
      && after.orderMismatches.length === 0
      && after.positionMismatches.length === 0;
    if (!verified) throw new Error("testnet smoke test ended with unresolved exchange exposure");
    return {
      verified,
      asset: input.asset,
      requestedNotionalUsd: input.notionalUsd,
      quantity,
      openEvidence,
      closeEvidence,
      accountValue: after.accountValue,
      reconciledAt: after.capturedAt,
    };
  } catch (error) {
    const cleanup = await performHyperliquidTestnetEmergencyCleanup();
    if (!cleanup.verified) {
      throw new Error(`testnet smoke test failed and exposure cleanup is unverified: ${cleanup.issues.join(", ")}`, { cause: error });
    }
    throw error;
  }
}

export async function runHyperliquidTestnetVerificationSuite(input: {
  asset: "BTC" | "ETH" | "SOL" | "XRP";
  notionalUsd: number;
  referencePrice: number;
}) {
  const recentRunning = await prisma.hyperliquidTestnetVerificationRun.findFirst({
    where: {
      status: "RUNNING",
      startedAt: { gte: new Date(Date.now() - 15 * 60_000) },
    },
    orderBy: { startedAt: "desc" },
  });
  if (recentRunning) throw new HyperliquidDefinitiveOrderError("a Hyperliquid testnet verification is already running");

  const verification = await prisma.hyperliquidTestnetVerificationRun.create({
    data: {
      id: crypto.randomUUID(),
      status: "RUNNING",
      asset: input.asset,
      requestedNotionalUsd: input.notionalUsd,
    },
  });
  const checks = {
    connectivityPassed: false,
    openFillPassed: false,
    closeFillPassed: false,
    restingOrderPassed: false,
    cancelPassed: false,
    partialFillObserved: false,
    reconnectPassed: false,
    reconciliationPassed: false,
    emergencyCleanupPassed: false,
    orphanOrderCount: 0,
    positionMismatchCount: 0,
  };
  let sdkVersion: string | null = null;
  let verificationExposureMayExist = false;
  const evidence: Record<string, unknown> = {};

  try {
    const readiness = getHyperliquidExecutionReadiness();
    const firstTransport = await checkHyperliquidTestnetTransport();
    sdkVersion = firstTransport.sdkVersion;
    checks.connectivityPassed = firstTransport.transportConnected;
    if (!checks.connectivityPassed) throw new Error("Hyperliquid testnet transport check failed");
    if (!readiness.ready) throw new HyperliquidDefinitiveOrderError("Hyperliquid testnet account and dedicated API wallet are not armed");

    const before = await reconcileHyperliquidTestnetOrders();
    const beforePositions = before.positions.filter((position) => Math.abs(position.size ?? 0) > 1e-8);
    if (!before.safety.healthy
      || before.openOrders.length > 0
      || beforePositions.length > 0
      || before.orderMismatches.length > 0
      || before.positionMismatches.length > 0) {
      throw new HyperliquidDefinitiveOrderError("testnet verification requires a clean reconciled account");
    }

    const secondTransport = await checkHyperliquidTestnetTransport();
    checks.reconnectPassed = secondTransport.transportConnected
      && firstTransport.apiUrl === secondTransport.apiUrl
      && firstTransport.sdkVersion === secondTransport.sdkVersion;
    if (!checks.reconnectPassed) throw new Error("Hyperliquid testnet reconnect check failed");

    const smoke = await runHyperliquidTestnetSmokeTest(input);
    checks.openFillPassed = ["FILLED", "PARTIALLY_FILLED"].includes(smoke.openEvidence.status)
      && smoke.openEvidence.filledQuantity > 0;
    checks.closeFillPassed = ["FILLED", "PARTIALLY_FILLED"].includes(smoke.closeEvidence.status)
      && smoke.closeEvidence.filledQuantity >= smoke.openEvidence.filledQuantity * 0.99;
    checks.partialFillObserved = smoke.openEvidence.status === "PARTIALLY_FILLED"
      || smoke.closeEvidence.status === "PARTIALLY_FILLED";
    if (!checks.openFillPassed || !checks.closeFillPassed) throw new Error("testnet open/close fill verification failed");
    evidence.smoke = smoke;

    const run = await prisma.combinedShadowRun.findFirst({ where: { status: "running" }, orderBy: { startedAt: "desc" } });
    if (!run) throw new HyperliquidDefinitiveOrderError("testnet verification requires an active shadow run");
    const quantity = normalizeTestnetSmokeOrderSize(
      input.asset,
      input.notionalUsd,
      input.referencePrice,
      readiness.maximumNotionalUsd,
    );
    verificationExposureMayExist = true;
    const resting = await executeTrackedTestnetOrder({
      runId: run.id,
      asset: input.asset,
      side: "LONG",
      action: "VERIFY_REST",
      isBuy: true,
      quantity,
      referencePrice: input.referencePrice,
      reason: "manual testnet resting-order verification",
    });
    checks.restingOrderPassed = resting.status === "OPEN";
    checks.partialFillObserved ||= resting.status === "PARTIALLY_FILLED";
    if (!checks.restingOrderPassed) throw new Error("testnet post-only order did not rest on the book");
    const restingOrder = await prisma.combinedExecutionOrder.findFirst({
      where: { runId: run.id, environment: "TESTNET", action: "VERIFY_REST" },
      orderBy: { createdAt: "desc" },
    });
    if (!restingOrder) throw new Error("testnet resting order was not persisted");
    const cancellation = await cancelHyperliquidTestnetOrder({
      asset: input.asset,
      clientOrderId: restingOrder.clientOrderId,
    });
    checks.cancelPassed = cancellation.evidence.status === "CANCELLED";
    if (!checks.cancelPassed) throw new Error("testnet order cancellation was not verified");
    evidence.restingOrder = { resting, cancellation: cancellation.evidence };

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    const afterCancellation = await reconcileHyperliquidTestnetOrders();
    const positionsAfterCancellation = afterCancellation.positions.filter((position) => Math.abs(position.size ?? 0) > 1e-8);
    if (afterCancellation.openOrders.length > 0
      || positionsAfterCancellation.length > 0
      || afterCancellation.orderMismatches.length > 0
      || afterCancellation.positionMismatches.length > 0) {
      throw new Error("testnet cancellation did not reconcile to zero exposure");
    }
    verificationExposureMayExist = true;
    const emergencyResting = await executeTrackedTestnetOrder({
      runId: run.id,
      asset: input.asset,
      side: "LONG",
      action: "VERIFY_REST",
      isBuy: true,
      quantity,
      referencePrice: input.referencePrice,
      reason: "manual testnet emergency-cleanup verification",
    });
    checks.partialFillObserved ||= emergencyResting.status === "PARTIALLY_FILLED";
    if (emergencyResting.status !== "OPEN") throw new Error("testnet emergency-cleanup order did not rest on the book");
    const cleanup = await performHyperliquidTestnetEmergencyCleanup();
    checks.emergencyCleanupPassed = cleanup.verified
      && (cleanup.cancellation?.attempted ?? 0) >= 1
      && cleanup.final?.openOrders === 0
      && cleanup.final?.positions === 0;
    if (!checks.emergencyCleanupPassed) throw new Error("testnet emergency cleanup was not verified");
    verificationExposureMayExist = !cleanup.verified;
    evidence.emergencyCleanup = cleanup;

    const finalReconciliation = await reconcileHyperliquidTestnetOrders();
    const remainingPositions = finalReconciliation.positions.filter((position) => Math.abs(position.size ?? 0) > 1e-8);
    checks.orphanOrderCount = finalReconciliation.orderMismatches.length;
    checks.positionMismatchCount = finalReconciliation.positionMismatches.length;
    checks.reconciliationPassed = finalReconciliation.safety.healthy
      && finalReconciliation.openOrders.length === 0
      && remainingPositions.length === 0
      && checks.orphanOrderCount === 0
      && checks.positionMismatchCount === 0;
    if (!checks.reconciliationPassed) throw new Error("testnet final account reconciliation failed");
    evidence.finalReconciliation = {
      capturedAt: finalReconciliation.capturedAt,
      accountValue: finalReconciliation.accountValue,
      openOrders: finalReconciliation.openOrders.length,
      positions: remainingPositions.length,
      orderMismatches: checks.orphanOrderCount,
      positionMismatches: checks.positionMismatchCount,
    };

    const operationalChecksPassed = checks.connectivityPassed
      && checks.openFillPassed
      && checks.closeFillPassed
      && checks.restingOrderPassed
      && checks.cancelPassed
      && checks.reconnectPassed
      && checks.reconciliationPassed
      && checks.emergencyCleanupPassed;
    const status = operationalChecksPassed && checks.partialFillObserved ? "PASSED" : operationalChecksPassed ? "PARTIAL" : "FAILED";
    const completedAt = new Date();
    await prisma.hyperliquidTestnetVerificationRun.update({
      where: { id: verification.id },
      data: {
        status,
        sdkVersion,
        ...checks,
        resultJson: JSON.stringify(evidence),
        completedAt,
      },
    });
    return {
      id: verification.id,
      status,
      sdkVersion,
      ...checks,
      completedAt: completedAt.toISOString(),
      partialFillNote: checks.partialFillObserved
        ? "an actual partial fill was observed"
        : "all operational checks passed, but an actual partial fill has not been observed",
    };
  } catch (error) {
    const readiness = getHyperliquidExecutionReadiness();
    let cleanup: Awaited<ReturnType<typeof performHyperliquidTestnetEmergencyCleanup>> | null = null;
    if (readiness.ready && verificationExposureMayExist) {
      cleanup = await performHyperliquidTestnetEmergencyCleanup().catch(() => null);
    }
    const message = errorMessage(error);
    await prisma.hyperliquidTestnetVerificationRun.update({
      where: { id: verification.id },
      data: {
        status: "FAILED",
        sdkVersion,
        ...checks,
        emergencyCleanupPassed: checks.emergencyCleanupPassed || cleanup?.verified === true,
        resultJson: JSON.stringify({ ...evidence, failureCleanup: cleanup }),
        error: message,
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

export function normalizeTestnetSmokeOrderSize(
  asset: "BTC" | "ETH" | "SOL" | "XRP",
  notionalUsd: number,
  referencePrice: number,
  maximumNotionalUsd: number,
) {
  if (!Number.isFinite(notionalUsd) || notionalUsd < 10 || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new HyperliquidDefinitiveOrderError("invalid testnet smoke order notional or reference price");
  }
  const decimals = { BTC: 5, ETH: 4, SOL: 2, XRP: 1 }[asset];
  const factor = 10 ** decimals;
  const requested = Math.ceil((notionalUsd / referencePrice) * factor) / factor;
  const maximum = Math.floor((maximumNotionalUsd / referencePrice) * factor) / factor;
  const quantity = Math.min(requested, maximum);
  if (quantity <= 0 || quantity * referencePrice < 10) {
    throw new HyperliquidDefinitiveOrderError("testnet smoke order cannot satisfy the minimum notional within the safety limit");
  }
  return quantity;
}

async function executeTrackedTestnetOrder(input: {
  runId: string;
  asset: "BTC" | "ETH" | "SOL" | "XRP";
  side: "LONG" | "SHORT";
  action: "OPEN" | "CLOSE" | "VERIFY_REST";
  isBuy: boolean;
  quantity: number;
  referencePrice: number;
  reason: string;
}) {
  const clientOrderId = crypto.randomUUID();
  const order = await prisma.combinedExecutionOrder.create({
    data: {
      id: crypto.randomUUID(),
      runId: input.runId,
      environment: "TESTNET",
      clientOrderId,
      asset: input.asset,
      side: input.side,
      action: input.action,
      quantity: input.quantity,
      referencePrice: input.referencePrice,
      status: "SUBMITTED",
      reason: input.reason,
    },
  });
  try {
    const response = await executeHyperliquidTestnetOrder({
      action: input.action === "OPEN" ? "open" : input.action === "CLOSE" ? "close" : "rest",
      asset: input.asset,
      isBuy: input.isBuy,
      size: input.quantity,
      referencePrice: input.referencePrice,
      clientOrderId,
    });
    await prisma.combinedExecutionOrder.update({
      where: { id: order.id },
      data: {
        status: response.evidence.status,
        exchangeOrderId: response.evidence.exchangeOrderId,
        exchangeStatus: response.evidence.exchangeStatus,
        filledQuantity: response.evidence.filledQuantity,
        averageFillPrice: response.evidence.averageFillPrice,
        feePaid: response.evidence.feePaid,
        reason: response.evidence.reason ?? input.reason,
        responseJson: JSON.stringify(response.result ?? null),
        lastReconciledAt: new Date(),
      },
    });
    return response.evidence;
  } catch (error) {
    const definitive = error instanceof HyperliquidDefinitiveOrderError;
    await prisma.combinedExecutionOrder.update({
      where: { id: order.id },
      data: {
        status: definitive ? "REJECTED" : "UNKNOWN",
        reason: error instanceof Error ? error.message : "testnet smoke order result is unknown",
        lastReconciledAt: definitive ? new Date() : null,
      },
    });
    throw error;
  }
}

export function evaluateTestnetAccountSafety(input: {
  accountValue: number | null;
  previousAccountValue: number | null;
  highWaterAccountValue?: number | null;
  orderMismatchCount: number;
  positionMismatchCount: number;
  maximumAccountLossPct?: number;
}) {
  const maximumAccountLossPct = input.maximumAccountLossPct ?? maximumTestnetAccountLossPct();
  const referenceAccountValue = Math.max(
    validPositiveNumber(input.previousAccountValue) ?? 0,
    validPositiveNumber(input.highWaterAccountValue) ?? 0,
  ) || null;
  const accountLossPct = typeof input.accountValue === "number"
    && Number.isFinite(input.accountValue)
    && referenceAccountValue !== null
    ? Math.max(0, (referenceAccountValue - input.accountValue) / referenceAccountValue)
    : null;
  const issues: string[] = [];
  if (typeof input.accountValue !== "number" || !Number.isFinite(input.accountValue) || input.accountValue <= 0) {
    issues.push("account-value-unavailable");
  }
  if (accountLossPct !== null && accountLossPct > maximumAccountLossPct) issues.push("account-loss-limit");
  if (input.orderMismatchCount > 0) issues.push("order-mismatch");
  if (input.positionMismatchCount > 0) issues.push("position-mismatch");
  return {
    healthy: issues.length === 0,
    accountLossPct,
    referenceAccountValue,
    maximumAccountLossPct,
    issues,
  };
}

export function evaluateHyperliquidTestnetVerificationReadiness(input: {
  executionReady: boolean;
  verification: {
    status: string;
    connectivityPassed: boolean;
    openFillPassed: boolean;
    closeFillPassed: boolean;
    restingOrderPassed: boolean;
    cancelPassed: boolean;
    partialFillObserved: boolean;
    reconnectPassed: boolean;
    reconciliationPassed: boolean;
    emergencyCleanupPassed: boolean;
    orphanOrderCount: number;
    positionMismatchCount: number;
    completedAt: Date | null;
  } | null;
  account: {
    healthy: boolean;
    openOrderCount: number;
    positionCount: number;
    orderMismatchCount: number;
    positionMismatchCount: number;
    capturedAt: Date;
  } | null;
  now?: Date;
  maximumVerificationAgeMs?: number;
  maximumReconciliationAgeMs?: number;
}) {
  const now = input.now ?? new Date();
  const maximumVerificationAgeMs = input.maximumVerificationAgeMs ?? 7 * 24 * 60 * 60_000;
  const maximumReconciliationAgeMs = input.maximumReconciliationAgeMs ?? 3 * 60_000;
  const verification = input.verification;
  const account = input.account;
  const verificationAgeMs = verification?.completedAt
    ? now.getTime() - verification.completedAt.getTime()
    : Number.POSITIVE_INFINITY;
  const reconciliationAgeMs = account
    ? now.getTime() - account.capturedAt.getTime()
    : Number.POSITIVE_INFINITY;
  const checks = {
    executionArmed: input.executionReady,
    verificationPassed: verification?.status === "PASSED",
    connectivity: verification?.connectivityPassed === true,
    openFill: verification?.openFillPassed === true,
    closeFill: verification?.closeFillPassed === true,
    restingOrder: verification?.restingOrderPassed === true,
    cancellation: verification?.cancelPassed === true,
    partialFill: verification?.partialFillObserved === true,
    reconnect: verification?.reconnectPassed === true,
    finalReconciliation: verification?.reconciliationPassed === true,
    emergencyCleanup: verification?.emergencyCleanupPassed === true,
    noVerificationMismatch: verification?.orphanOrderCount === 0 && verification?.positionMismatchCount === 0,
    verificationFresh: verificationAgeMs >= 0 && verificationAgeMs <= maximumVerificationAgeMs,
    accountHealthy: account?.healthy === true,
    zeroExposure: account?.openOrderCount === 0 && account?.positionCount === 0,
    noAccountMismatch: account?.orderMismatchCount === 0 && account?.positionMismatchCount === 0,
    reconciliationFresh: reconciliationAgeMs >= 0 && reconciliationAgeMs <= maximumReconciliationAgeMs,
  };
  const failedChecks = Object.entries(checks).flatMap(([key, passed]) => passed ? [] : [key]);
  return { ready: failedChecks.length === 0, checks, failedChecks };
}

async function assertRecentTestnetReconciliation(now = new Date()) {
  const snapshot = await prisma.combinedExecutionAccountSnapshot.findFirst({
    where: { environment: "TESTNET" },
    orderBy: { capturedAt: "desc" },
  });
  if (!snapshot) throw new HyperliquidDefinitiveOrderError("testnet order blocked: account reconciliation has not completed");
  const ageMs = now.getTime() - snapshot.capturedAt.getTime();
  if (ageMs < 0 || ageMs > maximumTestnetReconciliationAgeMs()) {
    throw new HyperliquidDefinitiveOrderError("testnet order blocked: account reconciliation is stale");
  }
  if (!snapshot.healthy) throw new HyperliquidDefinitiveOrderError("testnet order blocked: account reconciliation is unsafe");
}

export function deriveHyperliquidCloid(clientOrderId: string) {
  return `0x${createHash("sha256").update(clientOrderId).digest("hex").slice(0, 32)}`;
}

export function planTestnetReconciliationBatches(clientOrderIds: string[], batchSize = 25) {
  const size = Math.max(1, Math.min(25, Math.floor(batchSize)));
  const uniqueIds = Array.from(new Set(clientOrderIds));
  if (!uniqueIds.length) return [[]];
  const batches: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += size) {
    batches.push(uniqueIds.slice(index, index + size));
  }
  return batches;
}

export function compareTestnetOpenOrders(
  actualOpenOrders: unknown[],
  databaseOrders: Array<{ asset: string; clientOrderId: string; exchangeOrderId?: string | null; status: string; createdAt?: Date }>,
  now = new Date(),
) {
  const actual = actualOpenOrders.flatMap((value) => {
    if (!isRecord(value)) return [];
    return [{
      asset: typeof value.coin === "string" ? value.coin : null,
      cloid: typeof value.cloid === "string" ? value.cloid.toLowerCase() : null,
      exchangeOrderId: stringIdentifier(value.oid),
    }];
  });
  const matchedActual = new Set<number>();
  const missing: TestnetOrderMismatch[] = [];

  for (const order of databaseOrders) {
    const expectedCloid = deriveHyperliquidCloid(order.clientOrderId).toLowerCase();
    const matchIndex = actual.findIndex((candidate, index) => (
      !matchedActual.has(index)
      && ((order.exchangeOrderId && candidate.exchangeOrderId === order.exchangeOrderId)
        || candidate.cloid === expectedCloid)
    ));
    if (matchIndex >= 0) {
      matchedActual.add(matchIndex);
      continue;
    }
    const unresolvedAgeMs = order.createdAt instanceof Date ? now.getTime() - order.createdAt.getTime() : 0;
    const shouldExistOnExchange = order.status === "OPEN"
      || order.status === "PARTIALLY_FILLED"
      || unresolvedAgeMs >= 30_000;
    if (shouldExistOnExchange) {
      missing.push({
        kind: "missing",
        asset: order.asset,
        clientOrderId: order.clientOrderId,
        exchangeOrderId: order.exchangeOrderId ?? null,
      });
    }
  }

  const orphan: TestnetOrderMismatch[] = actual.flatMap((order, index) => matchedActual.has(index) ? [] : [{
    kind: "orphan" as const,
    asset: order.asset,
    clientOrderId: null,
    exchangeOrderId: order.exchangeOrderId,
  }]);
  return [...missing, ...orphan];
}

export function compareTestnetPositions(
  actualPositions: Array<{ coin?: string; size?: number }>,
  filledOrders: Array<{ asset: string; side: string; action: string; quantity: number; filledQuantity?: number | null; status?: string }>,
) {
  const expected = new Map<string, number>();
  for (const order of filledOrders) {
    if (order.action === "FLATTEN") {
      expected.set(order.asset, 0);
      continue;
    }
    const direction = order.side === "LONG" ? 1 : -1;
    const action = order.action === "OPEN" ? 1 : -1;
    const quantity = typeof order.filledQuantity === "number" && order.filledQuantity > 0
      ? order.filledQuantity
      : order.status === "FILLED" || order.status === undefined ? order.quantity : 0;
    expected.set(order.asset, (expected.get(order.asset) ?? 0) + quantity * direction * action);
  }
  const actual = new Map(actualPositions.flatMap((position) => (
    position.coin && typeof position.size === "number" ? [[position.coin, position.size] as const] : []
  )));
  const assets = new Set([...expected.keys(), ...actual.keys()]);
  return Array.from(assets).flatMap((asset) => {
    const expectedSize = expected.get(asset) ?? 0;
    const actualSize = actual.get(asset) ?? 0;
    const tolerance = Math.max(1e-8, Math.abs(expectedSize) * 0.01);
    if (Math.abs(expectedSize - actualSize) <= tolerance) return [];
    return [{
      asset,
      expectedSize,
      actualSize,
      kind: Math.abs(expectedSize) <= tolerance ? "orphan" as const : Math.abs(actualSize) <= tolerance ? "missing" as const : "quantity" as const,
    }];
  });
}

function runExecutor(payload: Record<string, unknown>) {
  return new Promise<ExecutorResponse>((resolvePromise, reject) => {
    const child = spawn(executorPython(), [executorScript()], {
      cwd: process.env.POLYMARKET_PROJECT_ROOT ?? process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-100_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      try {
        const response = JSON.parse(stdout.trim()) as ExecutorResponse;
        if (code !== 0 && response.ok) return reject(new Error(stderr || "Hyperliquid executor failed"));
        resolvePromise(response);
      } catch {
        reject(new Error(stderr || "Hyperliquid executor returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function runReadOnlyExecutor(payload: Record<string, unknown>, attempts = 3) {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await runExecutor(payload);
      if (response.ok) return response;
      lastError = new Error(response.error ?? "Hyperliquid testnet read request failed");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Hyperliquid testnet read request failed");
    }
    if (attempt < attempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastError ?? new Error("Hyperliquid testnet read request failed");
}

function executorPython() {
  return process.env.HYPERLIQUID_EXECUTOR_PYTHON?.trim()
    || resolve(homedir(), ".polymarket-watch/hyperliquid-venv/bin/python");
}

function executorScript() {
  return resolve(process.env.POLYMARKET_PROJECT_ROOT ?? process.cwd(), "scripts/hyperliquid-testnet-executor.py");
}

function securePrivateKeyFileExists(configuredPath: string) {
  try {
    const expanded = configuredPath.startsWith("~/")
      ? resolve(homedir(), configuredPath.slice(2))
      : configuredPath;
    if (!existsSync(expanded)) return false;
    return (statSync(expanded).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function maximumTestnetNotional() {
  const configured = Number(process.env.HYPERLIQUID_TESTNET_MAX_NOTIONAL_USD ?? 25);
  return Number.isFinite(configured) ? Math.max(1, Math.min(100, configured)) : 25;
}

function maximumTestnetAccountLossPct() {
  const configured = Number(process.env.HYPERLIQUID_TESTNET_MAX_ACCOUNT_LOSS_PCT ?? 0.05);
  return Number.isFinite(configured) ? Math.max(0.001, Math.min(0.5, configured)) : 0.05;
}

function maximumTestnetReconciliationAgeMs() {
  const configuredSeconds = Number(process.env.HYPERLIQUID_TESTNET_RECONCILIATION_MAX_AGE_SECONDS ?? 180);
  const seconds = Number.isFinite(configuredSeconds) ? Math.max(30, Math.min(900, configuredSeconds)) : 180;
  return seconds * 1_000;
}

function supportedTestnetAssets() {
  const configured = process.env.HYPERLIQUID_TESTNET_ASSETS ?? "BTC,ETH,SOL";
  return Array.from(new Set(configured.split(",").map((asset) => asset.trim().toUpperCase()).filter(Boolean)));
}

export function normalizeExchangeOrderStatus(value: unknown) {
  const evidence = parseHyperliquidOrderEvidence(value, "query");
  return evidence.recognized ? evidence.status : null;
}

export function parseHyperliquidOrderEvidence(
  value: unknown,
  action: "order" | "cancel" | "query" = "query",
): HyperliquidOrderEvidence {
  const objects = collectObjects(value);
  const statusValues = objects.flatMap((item) => typeof item.status === "string" ? [item.status] : []);
  const normalizedStatuses = statusValues.map(normalizeStatusToken);
  const serialized = JSON.stringify(value ?? "").toLowerCase();
  const retryableQueryMiss = action === "query" && (
    normalizedStatuses.includes("queryerror")
    || normalizedStatuses.includes("unknownoid")
    || /unknown oid|not found/.test(serialized)
  );
  if (retryableQueryMiss) return emptyEvidence(false);

  const error = objects.flatMap((item) => typeof item.error === "string" ? [item.error] : [])[0] ?? null;
  const filled = objects.flatMap((item) => isRecord(item.filled) ? [item.filled] : [])[0] ?? null;
  const resting = objects.flatMap((item) => isRecord(item.resting) ? [item.resting] : [])[0] ?? null;
  const order = objects.find((item) => numberValue(item.oid) !== null)
    ?? objects.find((item) => numberValue(item.origSz) !== null || numberValue(item.sz) !== null)
    ?? null;
  const exchangeStatus = statusValues.find((item) => {
    const token = normalizeStatusToken(item);
    return token !== "ok" && token !== "order" && token !== "default";
  }) ?? (filled ? "filled" : resting ? "resting" : action === "cancel" && serialized.includes("success") ? "canceled" : null);
  const normalizedExchangeStatus = normalizeStatusToken(exchangeStatus ?? "");
  const originalQuantity = firstNumber(objects, ["origSz", "totalSz"]);
  const remainingQuantity = firstNumber(objects, ["sz"]);
  const explicitFilledQuantity = filled ? firstNumber([filled], ["totalSz", "sz"]) : null;
  const derivedFilledQuantity = originalQuantity !== null && remainingQuantity !== null
    ? Math.max(0, originalQuantity - remainingQuantity)
    : null;
  const filledQuantity = explicitFilledQuantity ?? derivedFilledQuantity
    ?? (normalizedExchangeStatus === "filled" ? originalQuantity : null)
    ?? 0;
  const averageFillPrice = filled ? firstNumber([filled], ["avgPx", "px"]) : firstNumber(objects, ["avgPx"]);
  const exchangeOrderId = stringIdentifier(filled?.oid)
    ?? stringIdentifier(resting?.oid)
    ?? stringIdentifier(order?.oid)
    ?? null;
  const feePaid = firstNumber(objects, ["fee"]) ?? 0;
  const rejectedStatus = normalizedExchangeStatus.endsWith("rejected") || normalizedExchangeStatus === "rejected";
  const cancelledStatus = normalizedExchangeStatus === "canceled"
    || normalizedExchangeStatus === "cancelled"
    || normalizedExchangeStatus.endsWith("canceled")
    || normalizedExchangeStatus === "scheduledcancel";
  const filledStatus = normalizedExchangeStatus === "filled" || Boolean(filled);
  const openStatus = normalizedExchangeStatus === "open" || normalizedExchangeStatus === "resting" || Boolean(resting);

  let status: HyperliquidOrderEvidence["status"] = "ACCEPTED";
  if (error || rejectedStatus) status = "REJECTED";
  else if (filledStatus) status = "FILLED";
  else if (cancelledStatus || (action === "cancel" && serialized.includes("success"))) status = "CANCELLED";
  else if (openStatus && filledQuantity > 0) status = "PARTIALLY_FILLED";
  else if (openStatus) status = "OPEN";

  return {
    recognized: Boolean(error || exchangeStatus || exchangeOrderId || action !== "query"),
    status,
    exchangeStatus,
    exchangeOrderId,
    filledQuantity,
    averageFillPrice,
    feePaid,
    reason: error ?? (rejectedStatus ? exchangeStatus : null),
  };
}

export function aggregateHyperliquidFills(fills: unknown[]) {
  const grouped = new Map<string, { filledQuantity: number; averageFillPrice: number | null; feePaid: number }>();
  for (const value of fills) {
    if (!isRecord(value)) continue;
    const orderId = stringIdentifier(value.oid);
    const quantity = numberValue(value.sz);
    const price = numberValue(value.px);
    const fee = numberValue(value.fee) ?? 0;
    if (!orderId || quantity === null || quantity <= 0) continue;
    const previous = grouped.get(orderId) ?? { filledQuantity: 0, averageFillPrice: null, feePaid: 0 };
    const previousNotional = previous.averageFillPrice === null ? 0 : previous.averageFillPrice * previous.filledQuantity;
    const nextQuantity = previous.filledQuantity + quantity;
    grouped.set(orderId, {
      filledQuantity: nextQuantity,
      averageFillPrice: price === null ? previous.averageFillPrice : (previousNotional + price * quantity) / nextQuantity,
      feePaid: previous.feePaid + fee,
    });
  }
  return grouped;
}

export function normalizeHyperliquidFillAgainstRequestedQuantity(
  evidence: HyperliquidOrderEvidence,
  requestedQuantity: number,
) {
  if (
    evidence.status !== "FILLED"
    || !Number.isFinite(requestedQuantity)
    || requestedQuantity <= 0
    || evidence.filledQuantity <= 0
  ) return evidence;
  const tolerance = Math.max(1e-10, requestedQuantity * 1e-6);
  return evidence.filledQuantity + tolerance < requestedQuantity
    ? { ...evidence, status: "PARTIALLY_FILLED" as const }
    : evidence;
}

function emptyEvidence(recognized: boolean): HyperliquidOrderEvidence {
  return {
    recognized,
    status: "ACCEPTED",
    exchangeStatus: null,
    exchangeOrderId: null,
    filledQuantity: 0,
    averageFillPrice: null,
    feePaid: 0,
    reason: null,
  };
}

function collectObjects(value: unknown) {
  const objects: Record<string, unknown>[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!isRecord(item)) return;
    objects.push(item);
    Object.values(item).forEach(visit);
  };
  visit(value);
  return objects;
}

function firstNumber(objects: Record<string, unknown>[], keys: string[]) {
  for (const object of objects) {
    for (const key of keys) {
      const value = numberValue(object[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function numberValue(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function stringIdentifier(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeStatusToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function validPositiveNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
