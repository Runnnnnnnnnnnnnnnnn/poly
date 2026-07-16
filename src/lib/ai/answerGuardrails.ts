const tradeAdvicePattern = /(買うべき|売るべき|購入すべき|売却すべき|確実に儲かる|必ず儲かる)/;
const unsafeHowToPattern = /(自動売買|注文送信|ウォレット接続|秘密鍵|VPN回避|地理制限回避).*(手順|方法|設定|実装|入力|送信|回避|接続)/;
const safeNegativePattern = /(できません|ありません|しません|禁止|範囲外|扱いません|実装していません)/;
const decorativeEmojiPattern = /[\p{Extended_Pictographic}\uFE0F\u20E3]/gu;
const markdownDividerPattern = /^\s*[-*_]{3,}\s*$/gm;
const inlineDividerPattern = /\s+[-*_]{3,}\s+/g;
const markdownHeadingPattern = /^\s{0,3}#{1,6}\s*/gm;
const markdownEmphasisPattern = /(\*\*|__)/g;

const tradeAdviceReplacement =
  "このダッシュボードでは売買判断の推奨はできません。市場価格、公式情報、未確定要素を分けて確認してください。";

const unsafeHowToReplacement =
  "この読み取り専用ダッシュボードでは、自動売買、注文送信、ウォレット接続、秘密鍵、VPN回避、地理制限回避の手順は案内できません。";

export function applyAnswerGuardrails(answer: string) {
  let guarded = answer
    .replace(decorativeEmojiPattern, "")
    .replace(markdownDividerPattern, "")
    .replace(inlineDividerPattern, " ")
    .replace(markdownHeadingPattern, "")
    .replace(markdownEmphasisPattern, "")
    .split("\n")
    .map((line) => {
      if (tradeAdvicePattern.test(line)) return tradeAdviceReplacement;
      if (unsafeHowToPattern.test(line) && !safeNegativePattern.test(line)) return unsafeHowToReplacement;
      return line;
    })
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n");

  if (!guarded.includes("投資助言")) {
    guarded = `${guarded.trim()}\n\nこれは投資助言ではありません。`;
  }

  return guarded;
}

export function refusalForUnsafeRequest() {
  return "その内容はこの読み取り専用ダッシュボードの範囲外です。自動売買、注文、ウォレット接続、秘密鍵、VPN回避、地理制限回避の案内はできません。市場の意味、確率の見方、公式情報の整理であれば説明できます。これは投資助言ではありません。";
}

export function isUnsafeRequest(input: string) {
  return /注文(する|方法|手順|送信)|取引方法|買い方|売り方|ウォレット|秘密鍵|自動売買|VPN|地域制限|地理制限|買うべき|売るべき|儲かる/.test(
    input,
  );
}
