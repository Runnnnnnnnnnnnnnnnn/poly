export type TestnetDisplayTone = "good" | "watch" | "bad" | "neutral";

export type TestnetDisplayInput = {
  installed?: boolean;
  accountConfigured?: boolean;
  apiWalletConfigured?: boolean;
  enabled?: boolean;
  verifiedReady?: boolean;
  nextStep?: string | null;
  transport?: { status?: string | null } | null;
  verification?: { status?: string | null; error?: string | null } | null;
};

export type TestnetDisplayStatus = {
  label: string;
  note: string;
  tone: TestnetDisplayTone;
};

export function deriveTestnetDisplayStatus(testnet?: TestnetDisplayInput | null): TestnetDisplayStatus {
  if (!testnet) {
    return { label: "確認中", note: "テストネットの状態を確認しています", tone: "neutral" };
  }
  if (testnet.verifiedReady) {
    return { label: "検証済み", note: "発注・取消・照合済み", tone: "good" };
  }
  if (!testnet.installed) {
    return { label: "未導入", note: testnet.nextStep ?? "テストネット接続を設定してください", tone: "bad" };
  }
  if (!testnet.apiWalletConfigured) {
    return { label: "鍵未設定", note: testnet.nextStep ?? "専用API Walletを設定してください", tone: "bad" };
  }
  if (!testnet.accountConfigured) {
    return { label: "口座未設定", note: testnet.nextStep ?? "マスター口座を登録してください", tone: "bad" };
  }
  if (!testnet.enabled) {
    return { label: "発注無効", note: testnet.nextStep ?? "検証用の発注を有効にしてください", tone: "watch" };
  }

  const verificationStatus = testnet.verification?.status?.toUpperCase();
  if (verificationStatus === "FAILED") {
    return {
      label: "検証失敗",
      note: testnet.verification?.error ?? "発注・取消・照合の再検証が必要です",
      tone: "bad",
    };
  }
  if (verificationStatus === "PARTIAL") {
    return { label: "一部検証", note: "部分約定の実測待ち", tone: "watch" };
  }

  return {
    label: "実API検証待ち",
    note: testnet.transport?.status === "healthy"
      ? "公開API疎通済み・実注文検証待ち"
      : testnet.nextStep ?? "発注・取消・照合の検証が必要です",
    tone: "watch",
  };
}
