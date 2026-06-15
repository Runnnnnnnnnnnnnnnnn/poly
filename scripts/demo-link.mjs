const tunnelUrl = process.argv[2]?.trim();

if (!tunnelUrl) {
  console.error("Usage: node scripts/demo-link.mjs https://your-tunnel.example.com");
  process.exit(1);
}

const normalizedTunnel = tunnelUrl.replace(/\/$/, "");
const pagesBase = process.env.PAGES_BASE_URL || "https://runnnnnnnnnnnnnnnnn.github.io/poly";
const url = new URL(`${pagesBase.replace(/\/$/, "")}/onboarding/`);
url.searchParams.set("api", normalizedTunnel);

console.log(url.toString());
