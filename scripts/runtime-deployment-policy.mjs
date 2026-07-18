export const runtimeDatabaseRelativePath = "prisma/dev.db";
export const runtimeDatabaseRsyncExcludes = Object.freeze([
  "--exclude=prisma/dev.db*",
]);

export function isProtectedRuntimeDatabasePath(path) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === runtimeDatabaseRelativePath
    || normalized.startsWith(`${runtimeDatabaseRelativePath}-`);
}

export function untrackedRuntimeSourceRsyncExcludes(paths) {
  return paths.map((path) => {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.includes("\0")) {
      throw new Error(`unsafe untracked runtime source path: ${path}`);
    }
    const escaped = normalized.replace(/[?*\[\\]/g, "\\$&");
    return `--exclude=/${escaped}`;
  });
}
