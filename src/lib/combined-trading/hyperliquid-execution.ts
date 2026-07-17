import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

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
