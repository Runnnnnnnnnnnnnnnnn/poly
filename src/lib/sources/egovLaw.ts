export async function fetchEgovLawUpdates() {
  return {
    status: "fallback" as const,
    items: [],
    message: "e-Gov法令API v2はsource adapter境界のみ用意。画面投入は未実装です。",
  };
}
