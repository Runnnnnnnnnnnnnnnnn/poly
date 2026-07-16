import { readFileSync } from "node:fs";

function readEnvValue(name) {
  if (process.env[name]?.trim()) return process.env[name].trim();

  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split("\n")
      .find((value) => value.trim().startsWith(`${name}=`));
    return line?.slice(line.indexOf("=") + 1).trim().replace(/^['\"]|['\"]$/g, "");
  } catch {
    return undefined;
  }
}

const tunnelUrl = process.argv[2]?.trim();

if (!tunnelUrl) {
  console.error("Usage: node scripts/demo-link.mjs https://your-tunnel.example.com");
  process.exit(1);
}

const normalizedTunnel = tunnelUrl.replace(/\/$/, "");
const pagesBase = process.env.PAGES_BASE_URL || "https://runnnnnnnnnnnnnnnnn.github.io/poly";
const url = new URL(`${pagesBase.replace(/\/$/, "")}/onboarding/`);
url.searchParams.set("api", normalizedTunnel);
const apiToken = readEnvValue("API_ACCESS_TOKEN");
if (apiToken) url.searchParams.set("apiToken", apiToken);

console.log(url.toString());
