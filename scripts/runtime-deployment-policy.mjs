export const runtimeDatabaseRelativePath = "prisma/dev.db";
export const runtimeDatabaseRsyncExcludes = Object.freeze([
  "--exclude=prisma/dev.db*",
]);

export function isProtectedRuntimeDatabasePath(path) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === runtimeDatabaseRelativePath
    || normalized.startsWith(`${runtimeDatabaseRelativePath}-`);
}
