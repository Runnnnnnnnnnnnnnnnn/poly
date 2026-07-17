import { Resolver } from "node:dns/promises";
import { get } from "node:https";

export async function checkPublicHealth(baseUrl, timeoutMs = 20_000) {
  const url = new URL("/api/health", baseUrl);
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) return true;
  } catch {}

  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const addresses = await resolver.resolve4(url.hostname);
  let lastError;
  for (const address of addresses) {
    try {
      await requestWithAddress(url, address, timeoutMs);
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("public health hostname did not resolve");
}

function requestWithAddress(url, address, timeoutMs, redirectCount = 0) {
  return new Promise((resolvePromise, reject) => {
    const request = get(url, {
      headers: { accept: "application/json", "user-agent": "Polymarket-Watch-Healthcheck/1.0" },
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolvePromise();
        else if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirectCount < 3) {
          const redirectUrl = new URL(response.headers.location, url);
          if (redirectUrl.hostname !== url.hostname) reject(new Error("public health redirect changed hostname"));
          else requestWithAddress(redirectUrl, address, timeoutMs, redirectCount + 1).then(resolvePromise, reject);
        }
        else reject(new Error(`public health check returned ${response.statusCode ?? "unknown"}`));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("public health check timed out")));
    request.once("error", reject);
  });
}
