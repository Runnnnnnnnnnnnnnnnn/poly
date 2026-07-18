import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { prisma } from "@/src/lib/server/prisma";

type TestnetOrderRequest = {
  action: "open" | "close";
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

export function getHyperliquidExecutionReadiness() {
  const python = executorPython();
  const installed = existsSync(python) && existsSync(executorScript());
  const accountConfigured = Boolean(process.env.HYPERLIQUID_ACCOUNT_ADDRESS?.trim());
  const apiWalletConfigured = Boolean(process.env.HYPERLIQUID_API_WALLET_PRIVATE_KEY?.trim());
  const enabled = process.env.HYPERLIQUID_TESTNET_ENABLED === "1";
  const autoMirrorEnabled = process.env.HYPERLIQUID_TESTNET_AUTO_MIRROR === "1";
  const supportedAssets = supportedTestnetAssets();
  return {
    environment: "testnet" as const,
    installed,
    accountConfigured,
    apiWalletConfigured,
    enabled,
    autoMirrorEnabled,
    supportedAssets,
    ready: installed && accountConfigured && apiWalletConfigured && enabled,
    maximumNotionalUsd: maximumTestnetNotional(),
    mainnetSupported: false,
  };
}

export async function checkHyperliquidTestnetConnection() {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.installed || !readiness.accountConfigured) return { ...readiness, connected: false };
  const response = await runReadOnlyExecutor({ action: "readiness" });
  return { ...readiness, connected: response.ok, accountValue: response.accountValue ?? null };
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
  if (request.action === "open" && notional > readiness.maximumNotionalUsd + 0.0001) {
    throw new HyperliquidDefinitiveOrderError(`Hyperliquid testnet order exceeds $${readiness.maximumNotionalUsd} limit`);
  }
  if (request.action === "open") await assertRecentTestnetReconciliation();
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
    take: 25,
  });
  const response = await runReadOnlyExecutor({ action: "reconcile", clientOrderIds: orders.map((order) => order.clientOrderId) });
  if (!response.ok) throw new Error(response.error ?? "Hyperliquid testnet reconciliation failed");

  const fillsByOrder = aggregateHyperliquidFills(response.recentFills ?? []);
  let updatedOrders = 0;
  for (const status of response.orderStatuses ?? []) {
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
  const previousAccount = await prisma.combinedExecutionAccountSnapshot.findFirst({
    where: { environment: "TESTNET" },
    orderBy: { capturedAt: "desc" },
  });
  const accountValue = response.accountValue ?? null;
  const safety = evaluateTestnetAccountSafety({
    accountValue,
    previousAccountValue: previousAccount?.accountValue ?? null,
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
    await cancelOutstandingHyperliquidTestnetOrders().catch(() => null);
    await flattenHyperliquidTestnetPositions().catch(() => null);
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
  action: "OPEN" | "CLOSE";
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
      action: input.action === "OPEN" ? "open" : "close",
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
  orderMismatchCount: number;
  positionMismatchCount: number;
  maximumAccountLossPct?: number;
}) {
  const maximumAccountLossPct = input.maximumAccountLossPct ?? maximumTestnetAccountLossPct();
  const accountLossPct = typeof input.accountValue === "number"
    && Number.isFinite(input.accountValue)
    && typeof input.previousAccountValue === "number"
    && Number.isFinite(input.previousAccountValue)
    && input.previousAccountValue > 0
    ? Math.max(0, (input.previousAccountValue - input.accountValue) / input.previousAccountValue)
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
    maximumAccountLossPct,
    issues,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
