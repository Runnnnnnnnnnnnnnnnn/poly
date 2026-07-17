export function resolveTunnelConfig(env, port) {
  const token = env.CLOUDFLARED_TUNNEL_TOKEN?.trim() || "";
  const name = env.CLOUDFLARED_TUNNEL_NAME?.trim() || "";
  const publicUrl = env.CLOUDFLARED_PUBLIC_URL?.trim() || "";
  const named = Boolean(token || name);
  if (named && !publicUrl) throw new Error("CLOUDFLARED_PUBLIC_URL is required for a named tunnel");
  if (publicUrl) normalizePublicUrl(publicUrl);

  if (token) {
    return {
      mode: "named-token",
      args: ["tunnel", "--no-autoupdate", "run", "--token", token],
      publicUrl: normalizePublicUrl(publicUrl),
      allowQuickFallback: env.CLOUDFLARED_ALLOW_QUICK_FALLBACK !== "0",
    };
  }
  if (name) {
    return {
      mode: "named-config",
      args: ["tunnel", "--no-autoupdate", "run", name],
      publicUrl: normalizePublicUrl(publicUrl),
      allowQuickFallback: env.CLOUDFLARED_ALLOW_QUICK_FALLBACK !== "0",
    };
  }
  return quickTunnelConfig(port);
}

export function quickTunnelConfig(port) {
  return {
    mode: "quick",
    args: ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
    publicUrl: "",
    allowQuickFallback: false,
  };
}

function normalizePublicUrl(value) {
  if (!value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("CLOUDFLARED_PUBLIC_URL must use HTTPS");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
