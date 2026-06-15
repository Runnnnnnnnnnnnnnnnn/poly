import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "true";
const githubPagesRepo = process.env.GITHUB_PAGES_REPO || "poly";
const basePath = isGitHubPages ? `/${githubPagesRepo}` : "";

const nextConfig: NextConfig = {
  output: isGitHubPages ? "export" : undefined,
  basePath: basePath || undefined,
  assetPrefix: basePath ? `${basePath}/` : undefined,
  trailingSlash: isGitHubPages ? true : undefined,
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "polymarket-upload.s3.us-east-2.amazonaws.com" },
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
  outputFileTracingRoot: process.cwd(),
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts"],
  },
};

export default nextConfig;
