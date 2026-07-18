import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const stateRoot = resolve(process.env.POLYMARKET_STATE_DIR ?? resolve(homedir(), ".polymarket-watch"));
const environmentRoot = resolve(stateRoot, "analytics-venv");
const python = resolve(environmentRoot, "bin/python");
const marker = resolve(stateRoot, "analytics-python-path");
const sourcePython = [
  process.env.ANALYTICS_BOOTSTRAP_PYTHON,
  resolve(stateRoot, "mlflow-venv/bin/python"),
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
].filter(Boolean).find((candidate) => existsSync(candidate));

if (!sourcePython) throw new Error("Python runtime was not found");

mkdirSync(stateRoot, { recursive: true });
if (existsSync(python) && !supportsCurrentAnalytics(python)) {
  rmSync(environmentRoot, { recursive: true, force: true });
}
if (!existsSync(python)) {
  execFileSync(sourcePython, ["-m", "venv", environmentRoot], { stdio: "inherit" });
}
execFileSync(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", resolve(root, "requirements-analytics.txt")], {
  cwd: root,
  stdio: "inherit",
});
execFileSync(python, ["-c", "import duckdb, pyarrow; print(f'duckdb={duckdb.__version__} pyarrow={pyarrow.__version__}')"], {
  stdio: "inherit",
});
writeFileSync(marker, `${python}\n`, { mode: 0o600 });
console.log(`analytics runtime installed: ${python}`);

function supportsCurrentAnalytics(candidate) {
  try {
    execFileSync(candidate, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
