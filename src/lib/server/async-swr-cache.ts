export function createAsyncStaleWhileRevalidateCache<T>(options: {
  load: () => Promise<T>;
  ttlMs: number;
  now?: () => number;
  onBackgroundError?: (error: unknown) => void;
}) {
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(0, options.ttlMs);
  let cached: { value: T; loadedAtMs: number } | null = null;
  let refreshPromise: Promise<{ value: T; loadedAtMs: number }> | null = null;

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = options.load().then((value) => {
      cached = { value, loadedAtMs: now() };
      return cached;
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  return {
    async get() {
      if (!cached) await refresh();
      const snapshot = cached as { value: T; loadedAtMs: number };
      const ageMs = Math.max(0, now() - snapshot.loadedAtMs);
      if (ageMs >= ttlMs && !refreshPromise) {
        void refresh().catch((error) => options.onBackgroundError?.(error));
      }
      return { ...snapshot, ageMs, refreshing: Boolean(refreshPromise) };
    },
  };
}
