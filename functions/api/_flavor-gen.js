// functions/api/_flavor-gen.js
// スキル名・フレーバーテキストのAI生成ロジック（Gemini呼び出し・JSON抽出・ローカルフォールバック）を
// 一本化する共通モジュール（2026-08-22）。
// 従来 functions/api/skill-flavor.js（旧・クライアント駆動の単発生成・廃止済み）と
// functions/api/monster/skill-flavor.js（個別再生成API）に同じロジックが複製されていたため、
// 新規作成時のサーバー内フレーバー生成（_image-gen-core.js）を含め3箇所目の複製を避けて集約した。

export const SKILL_LOCAL_LABELS = {
  damage: "会心の一撃",
  loseToWin: "負けるが勝ち",
  heal: "再生",
  guard: "守りの構え",
};

// damage/heal/guard の効果量(2〜4)に対応する強さの副詞。app/aimon-core.js と同じ確定表現。
const EFFECT_MODIFIER_WORDS = { 2: "少し", 3: "大きく", 4: "かなり大きく" };

export function effectSentence(type, value) {
  switch (type) {
    case "damage":
      return `このターン相手に与えるダメージが${EFFECT_MODIFIER_WORDS[value] || ""}上昇する。`;
    case "heal":
      return `自身のHPを${EFFECT_MODIFIER_WORDS[value] || ""}回復する。`;
    case "guard":
      return `このターン相手から受けるダメージを${EFFECT_MODIFIER_WORDS[value] || ""}軽減する。`;
    case "loseToWin":
      return "このターンのみ、ハンドの相性が逆転する。";
    default:
      return "";
  }
}

export function localFallback(type, value) {
  return {
    name: SKILL_LOCAL_LABELS[type] || "スキル",
    flavor1: "秘めた力を静かに解き放つ。",
    flavor2: "その力の源は、まだ誰も知らないのかもしれない。",
    effect: effectSentence(type, value),
    source: "local",
  };
}

function buildFlavorPrompt(type, value, rarity, monsterName, world, hash) {
  const typeDesc = {
    damage: `攻撃力を${value}上げる攻撃強化スキル`,
    loseToWin: `このターンのみハンドの相性を逆転させ、わざと負けるハンドを出すことで勝つ「負けるが勝ち」スキル`,
    heal: `HPを${value}回復するスキル`,
    guard: `被ダメージを${value}軽減する防御スキル`,
  }[type] || "スキル";

  const effect = effectSentence(type, value);

  const worldContext = world?.species && world?.region
    ? `このメイモンは「${world.species.realm}」に属する種族「${world.species.ja}」で、` +
      `イラストにもその姿が描かれています。所属クランは「${world.region.nationJa}」、出身地域は「${world.region.ja}」、` +
      `属性は「${world.element?.ja || ""}」です。`
    : "";

  const FOCUS_VARIANTS = [
    `種族「${world?.species?.ja || ""}」とイラストの姿との関連`,
    `所属クラン「${world?.region?.nationJa || ""}」との関わり`,
    `出身地域「${world?.region?.ja || ""}」や属性「${world?.element?.ja || ""}」との関わり`,
    `①の名前や③の効果が示す力の性質そのもの（世界観の詳細説明は省略してよい）`,
  ];
  const focusIndex = hash ? parseInt(hash.slice(0, 2), 16) % FOCUS_VARIANTS.length : 0;
  const focusHint = FOCUS_VARIANTS[focusIndex];

  return (
    `あなたは日本語のカードゲームのフレーバーテキスト作家です。` +
    `回答は必ず日本語のみで書いてください。英語やローマ字は一切使用しないでください。` +
    `メイモン「${monsterName}」（レアリティ${rarity}）が持つ、対戦中1回だけ使える「${typeDesc}」について、` +
    `カード上では次の4部構成で表示されます: ` +
    `①スキルのかっこよく短い名前（10文字以内） ` +
    `②フレーバー1（そのスキルやキャラの説明、25文字以内） ` +
    `③固定の効果文（変更禁止・そのまま使用）: 「${effect}」 ` +
    `④フレーバー2（30〜35文字。この文字数に必ず収めること。1文字でも超えたり短すぎたりしてはいけません）。` +
    worldContext +
    `④フレーバー2は、①の名前・②のフレーバー1・③の効果を踏まえつつ、` +
    `特に${focusHint}を中心に、あなたが自由に一文を創作してください。言い回しや文体の制約はありませんが、` +
    `全ての世界観情報を詰め込まず、指定した観点に絞って30〜35文字でまとめてください。` +
    `出力は説明や訳文を含めず、次のJSON形式のみを1行で出力してください: {"name":"...","flavor1":"...","flavor2":"..."}` +
    `（name, flavor1, flavor2の値は全て日本語で書くこと。英単語を含めてはいけません）`
  );
}

function containsJapanese(str) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(str);
}

function trimToSentence(str, maxLen) {
  const s = (str || "").trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastPunct = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("、"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
  const minAcceptable = Math.floor(maxLen * 0.6);
  if (lastPunct >= minAcceptable) return cut.slice(0, lastPunct + 1);
  return cut.slice(0, maxLen - 1).trim() + "…";
}

function extractFlavorJson(rawOutput) {
  const text = Array.isArray(rawOutput) ? rawOutput.join("") : String(rawOutput || "");
  const match = text.match(/\{[^{}]*"name"[^{}]*"flavor1"[^{}]*"flavor2"[^{}]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (
      typeof parsed.name === "string" &&
      typeof parsed.flavor1 === "string" &&
      typeof parsed.flavor2 === "string" &&
      containsJapanese(parsed.name) &&
      containsJapanese(parsed.flavor1) &&
      containsJapanese(parsed.flavor2)
    ) {
      return {
        name: parsed.name.slice(0, 20).trim(),
        flavor1: parsed.flavor1.slice(0, 60).trim(),
        flavor2: trimToSentence(parsed.flavor2, 38),
      };
    }
  } catch {
    return null;
  }
  return null;
}

const SYSTEM_PROMPT =
  "あなたは日本語のカードゲームのフレーバーテキスト作家です。" +
  "回答は必ず日本語のみで書いてください。英語やローマ字は一切使用しないでください。" +
  '出力は説明や前書きを含めず、次のJSON形式のみを1行で返してください: {"name":"...","flavor1":"...","flavor2":"..."} ' +
  "(name, flavor1, flavor2の値は全て日本語で書くこと。英単語を含めてはいけません)";

async function callGeminiFlash(env, prompt) {
  const token = env.GEMINI_API_TOKEN;
  if (!token) throw new Error("GEMINI_API_TOKEN not configured");
  const model = env.GEMINI_FLAVOR_MODEL || "gemini-2.5-flash";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING", description: "スキルのかっこよく短い名前（10文字以内・日本語）" },
              flavor1: { type: "STRING", description: "フレーバー1（25文字以内・日本語）" },
              flavor2: { type: "STRING", description: "フレーバー2（30〜35文字・日本語）" },
            },
            required: ["name", "flavor1", "flavor2"],
          },
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`gemini error: ${res.status}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  if (!text) throw new Error("empty gemini output");
  return text;
}

// AIでのフレーバー生成を試みる。失敗時（API障害・JSON不正・非日本語混入等）は null を返す
// （フォールバック要否は呼び出し側の文脈による＝自動生成なら localFallback、有償の個別再生成なら
//  課金せずエラー表示、という判断を委ねるため、ここでは例外を握りつぶし null 統一で返す）。
export async function tryGenerateAiFlavor(env, { type, value, rarity, monsterName, world, hash }) {
  try {
    const prompt = buildFlavorPrompt(type, value, rarity, monsterName, world, hash);
    const raw = await callGeminiFlash(env, prompt);
    return extractFlavorJson(raw);
  } catch {
    return null;
  }
}
