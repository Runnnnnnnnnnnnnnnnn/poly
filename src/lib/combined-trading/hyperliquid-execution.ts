import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import { prisma } from "@/src/lib/server/prisma";

type TestnetOrderRequest = {
  action: "open" | "close";
  asset: "BTC" | "ETH" | "SOL" | "XRP";
  isBuy: boolean;
  size: number;
  referencePrice: number;
  clientOrderId: string;
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
  error?: string;
};

export function getHyperliquidExecutionReadiness() {
  const python = executorPython();
  const installed = existsSync(python) && existsSync(executorScript());
  const accountConfigured = Boolean(process.env.HYPERLIQUID_ACCOUNT_ADDRESS?.trim());
  const apiWalletConfigured = Boolean(process.env.HYPERLIQUID_API_WALLET_PRIVATE_KEY?.trim());
  const enabled = process.env.HYPERLIQUID_TESTNET_ENABLED === "1";
  const autoMirrorEnabled = process.env.HYPERLIQUID_TESTNET_AUTO_MIRROR === "1";
  return {
    environment: "testnet" as const,
    installed,
    accountConfigured,
    apiWalletConfigured,
    enabled,
    autoMirrorEnabled,
    ready: installed && accountConfigured && apiWalletConfigured && enabled,
    maximumNotionalUsd: maximumTestnetNotional(),
    mainnetSupported: false,
  };
}

export async function checkHyperliquidTestnetConnection() {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.installed || !readiness.accountConfigured) return { ...readiness, connected: false };
  const response = await runExecutor({ action: "readiness" });
  return { ...readiness, connected: response.ok, accountValue: response.accountValue ?? null };
}

export async function executeHyperliquidTestnetOrder(request: TestnetOrderRequest) {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.ready) throw new Error("Hyperliquid testnet execution is not armed");
  if (!Number.isFinite(request.size) || request.size <= 0 || !Number.isFinite(request.referencePrice) || request.referencePrice <= 0) {
    throw new Error("invalid Hyperliquid testnet order size or price");
  }
  const notional = request.size * request.referencePrice;
  if (request.action === "open" && notional > readiness.maximumNotionalUsd + 0.0001) {
    throw new Error(`Hyperliquid testnet order exceeds $${readiness.maximumNotionalUsd} limit`);
  }
  const response = await runExecutor({ ...request, slippage: 0.01 });
  if (!response.ok) throw new Error(response.error ?? "Hyperliquid testnet order failed");
  return response;
}

export async function reconcileHyperliquidTestnetOrders() {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.installed || !readiness.accountConfigured) {
    return { ...readiness, connected: false, checkedOrders: 0, updatedOrders: 0, positions: [], openOrders: [], recentFills: [] };
  }
  const orders = await prisma.combinedExecutionOrder.findMany({
    where: { environment: "TESTNET", status: { in: ["PENDING", "ACCEPTED", "OPEN"] } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const response = await runExecutor({ action: "reconcile", clientOrderIds: orders.map((order) => order.clientOrderId) });
  if (!response.ok) throw new Error(response.error ?? "Hyperliquid testnet reconciliation failed");

  let updatedOrders = 0;
  for (const status of response.orderStatuses ?? []) {
    if (!status.clientOrderId) continue;
    const normalized = normalizeExchangeOrderStatus(status.result);
    if (!normalized) continue;
    const result = await prisma.combinedExecutionOrder.updateMany({
      where: { clientOrderId: status.clientOrderId, environment: "TESTNET" },
      data: { status: normalized, responseJson: JSON.stringify(status) },
    });
    updatedOrders += result.count;
  }

  const filledOrders = await prisma.combinedExecutionOrder.findMany({
    where: { environment: "TESTNET", status: "FILLED" },
    select: { asset: true, side: true, action: true, quantity: true },
  });
  const positionMismatches = compareTestnetPositions(response.positions ?? [], filledOrders);

  return {
    ...readiness,
    connected: true,
    accountValue: response.accountValue ?? null,
    checkedOrders: orders.length,
    updatedOrders,
    positions: response.positions ?? [],
    openOrders: response.openOrders ?? [],
    recentFills: response.recentFills ?? [],
    positionMismatches,
  };
}

export function compareTestnetPositions(
  actualPositions: Array<{ coin?: string; size?: number }>,
  filledOrders: Array<{ asset: string; side: string; action: string; quantity: number }>,
) {
  const expected = new Map<string, number>();
  for (const order of filledOrders) {
    const direction = order.side === "LONG" ? 1 : -1;
    const action = order.action === "OPEN" ? 1 : -1;
    expected.set(order.asset, (expected.get(order.asset) ?? 0) + order.quantity * direction * action);
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

export function normalizeExchangeOrderStatus(value: unknown) {
  const serialized = JSON.stringify(value ?? "").toLowerCase();
  if (/query_error|unknownoid|unknown oid|not found/.test(serialized)) return null;
  if (/\bfilled\b/.test(serialized)) return "FILLED";
  if (/\b(open|resting)\b/.test(serialized)) return "OPEN";
  if (/\b(cancelled|canceled|margin_canceled)\b/.test(serialized)) return "CANCELLED";
  if (/\b(rejected|error)\b/.test(serialized)) return "REJECTED";
  return null;
}
