// functions/api/_image-gen-core.js
// メイモン画像生成の共通コア（2026-08-22 抽出）。
// 従来 monster-image.js に一枚岩で実装されていた「プロンプト構築→画像生成(フォールバック込み)→
// R2/コレクション保存→履歴・レジストリ記録」を再利用可能な形に切り出した。
// 通常の新規生成フロー（monster-image.js）と、クラッシュ復旧の再開フロー（monster/resume.js）の
// 両方から呼ばれる。課金・返金・所有権チェックは呼び出し側の責務（このモジュールは課金を行わない）。

import { getOrCreateOrigin, toOriginView } from "./_registry.js";
import { saveAimons } from "./_aimon-store.js";
import { tryGenerateAiFlavor } from "./_flavor-gen.js";
import { sweepOldRows } from "./_error-log.js";

export const IMAGE_COST = 5; // 新規生成1枚あたりのクレジット消費（設計 §5.3・2026-08-14 経済改定で 1 → 5）

export function r2Key(monsterId) {
  return `monsters/${monsterId}.jpg`;
}

// P/S/Tの最大値から属性・配色を決める（world未設定の旧データ向けフォールバック）。
function dominantElement({ p, s, t }) {
  if (p >= s && p >= t) return { ja: "炎", en: "fire, glowing red and orange scales" };
  if (s >= p && s >= t) return { ja: "風", en: "wind, glowing blue and cyan aura" };
  return { ja: "雷・光", en: "lightning, glowing yellow and purple sparks" };
}

// レアリティが高いほど豪華な演出にする（可愛いアニメ風アートワーク向け）。
function rarityFlourish(rarity) {
  const table = {
    1: "a quiet, adorable magical presence, the faintest sparkle of wonder",
    2: "a cute magical aura with a few drifting sparkles and motes of light",
    3: "a gentle glowing aura, intricately detailed cute ornamentation",
    4: "a radiant, majestic and enchanting aura with elaborate sparkly detailing, an awe-inspiring legendary presence",
  };
  return table[rarity] || table[1];
}

// クール系スタイル（epic / pop）用のレアリティ演出。威圧感・迫力を演出する（2026-08-10）。
function rarityFlourishCool(rarity) {
  const table = {
    1: "a faintly menacing presence with a subtle ominous undertone",
    2: "a focused, confident battle aura with faint crackling energy wisps",
    3: "an imposing high-tension battle aura radiating fierce, intimidating energy",
    4: "an overwhelming, awe-inspiring presence of a legendary apex creature radiating catastrophic power",
  };
  return table[rarity] || table[1];
}

// 絵柄（アートスタイル）定義。各値は buildImagePrompt の Art style 節に差し込む説明文（文末ピリオド不要）。
// 特定の作家・作品名・商標に依存しないよう、様式・雰囲気・特徴の一般的な言葉で表現する（2026-08-10）。
// export: functions/api/profile-image.js（プレイヤーアバター生成）でも同じスタイル選択肢を流用する。
export const ART_STYLES = {
  ethereal:
    "fantasy illustration with a melancholic, ennui-laden, ethereal atmosphere evoking classic 1990s Japanese fantasy paintings — " +
    "flowing hair and elegant robes, delicate ornamental details, dreamlike painterly lighting, " +
    "muted jewel-tone color palette with deep shadows, wistful and introspective mood — " +
    "while the character's face is sculpted in a clean modern anime illustration style: " +
    "large expressive eyes with refined detailed irises, softly defined nose and mouth, smooth clear linework on the face, " +
    "polished high-quality digital painting that blends a painterly, melancholy atmosphere with modern anime facial features",
  moe:
    "cute moe anime style illustration with large sparkling colorful eyes, " +
    "soft rounded faces and chibi-friendly proportions, colorful hair with gentle shiny highlights, " +
    "soft pastel color palette, clean crisp cel shading with smooth gradients and glossy highlights, " +
    "charming, approachable, kawaii mood, polished high-quality digital anime illustration",
  epic:
    "epic collectible trading card game monster artwork of a fierce and imposing creature with a sharp angular silhouette and intricate detailed armor, scales or plating, " +
    "dramatic dynamic lighting with strong contrast, rich saturated colors, deep shadows and glowing accent lights, " +
    "intense battle-ready pose radiating power and menace, crisp high-detail rendering, " +
    "bold heroic composition, polished high-quality digital painting",
  pop:
    "dynamic anime creature card artwork of a bold and vibrant monster with exaggerated heroic proportions and wild spiky design, " +
    "high-contrast vibrant colors, punchy cel-style shading with glossy highlights, " +
    "explosive motion and energy effects, fierce confident expression, " +
    "playful yet powerful anime-style fantasy creature, clean crisp linework, polished high-quality digital illustration",
};

// 絵柄の選択。env.IMAGE_STYLE で明示指定があればそれを優先（不明値は ethereal にフォールバック）。
// 未指定の場合は名前のsha256ハッシュ（baseHash）から重み付き抽選で決定的に選ぶ（同じ名前は常に同じスタイル）。
// 比率: ethereal:epic:pop:moe = 45:25:15:5（2026-08-10）。
const STYLE_WEIGHTS = [
  ["ethereal", 45],
  ["epic", 25],
  ["pop", 15],
  ["moe", 5],
];

function pickArtStyleKey(env, baseHash) {
  const explicit = env?.IMAGE_STYLE;
  if (explicit && ART_STYLES[explicit]) return explicit;
  const total = STYLE_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  const seed = baseHash ? parseInt(baseHash.slice(0, 8), 16) : Math.floor(Math.random() * total);
  let roll = seed % total;
  for (const [key, weight] of STYLE_WEIGHTS) {
    if (roll < weight) return key;
    roll -= weight;
  }
  return STYLE_WEIGHTS[0][0];
}

function buildImagePrompt({ name, rarity, p, s, t, world, env, baseHash }) {
  const artStyleKey = pickArtStyleKey(env, baseHash);
  const artStyle = ART_STYLES[artStyleKey];
  const isCool = artStyleKey === "epic" || artStyleKey === "pop";
  const flourish = isCool ? rarityFlourishCool(rarity) : rarityFlourish(rarity);
  const species = world?.species;
  const region = world?.region;
  const element = world?.element || dominantElement({ p, s, t });
  const camera = world?.camera?.en || "dynamic dramatic camera angle";

  const creatureDesc = species
    ? `${species.en}, ${element.en}`
    : `a fantastical monster creature, ${element.en}`;
  const sceneDesc = region
    ? `Set within a scene of ${region.en}. `
    : `Set within a mystical, storybook fantasy realm. `;

  return (
    `A fantasy illustration of a monster creature named "${name}" for a collectible trading card game. ` +
    `${creatureDesc}, ${flourish}. ` +
    `Composition and camera work: ${camera}. ` +
    sceneDesc +
    `Art style: ${artStyle}. ` +
    `No card border, no frame. ` +
    `Do not include any text, letters, numbers, words, titles, captions, watermark, signature, or logo anywhere in the image. ` +
    `IMPORTANT: The image MUST be a perfect square (1:1 aspect ratio, equal width and height). Compose the subject centered and fully framed within this square canvas, with no letterboxing, no black bars, and no cropped or extended canvas of any other aspect ratio.`
  );
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Gemini (gemini-2.5-flash-image, 通称 Nano Banana) で画像を生成する。
async function callGeminiImage(env, prompt) {
  const token = env.GEMINI_API_TOKEN;
  if (!token) throw new Error("GEMINI_API_TOKEN not configured");

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
    {
      method: "POST",
      headers: { "x-goog-api-key": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { imageConfig: { aspectRatio: "1:1" } },
      }),
    }
  );

  if (!res.ok) throw new Error(`gemini error: ${res.status}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) throw new Error("no image output from gemini");

  return {
    bytes: base64ToArrayBuffer(imagePart.inlineData.data),
    contentType: imagePart.inlineData.mimeType || "image/png",
  };
}

async function callReplicateImage(env, prompt) {
  const token = env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN not configured");

  const res = await fetch(
    "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
      body: JSON.stringify({
        input: { prompt, num_outputs: 1, aspect_ratio: "1:1", output_format: "jpg", output_quality: 90 },
      }),
    }
  );

  if (!res.ok) throw new Error(`replicate error: ${res.status}`);
  const data = await res.json();
  if (data.status && data.status !== "succeeded") {
    throw new Error(`replicate status: ${data.status}`);
  }
  const output = data.output;
  const imageUrl = Array.isArray(output) ? output[0] : output;
  if (!imageUrl) throw new Error("no image output from replicate");
  return imageUrl;
}

// 画像生成モデルの選択方針（既定は全レア度 Gemini・env.IMAGE_MODEL_POLICY で試験的に切替可能）。
export function pickImageModel(rarity, env) {
  const policy = env.IMAGE_MODEL_POLICY || "gemini";
  if (policy === "gemini") return "gemini";
  if (policy === "replicate") return "replicate";
  return rarity >= 3 ? "gemini" : "replicate"; // tiered
}

async function generateWithModel(env, model, prompt) {
  if (model === "gemini") {
    const gemini = await callGeminiImage(env, prompt);
    return { bytes: gemini.bytes, contentType: gemini.contentType };
  }
  const imageUrl = await callReplicateImage(env, prompt);
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`image fetch failed: ${imageRes.status}`);
  return { bytes: await imageRes.arrayBuffer(), contentType: "image/jpeg" };
}

// 生成/召喚履歴を gen_history に記録する（失敗しても生成自体は妨げない）。
export async function logHistory(env, uid, monsterId, name, rarity, kind, cost, now) {
  try {
    await env.AIMON_DB.prepare(
      "INSERT INTO gen_history (uid, monster_id, name, rarity, kind, cost, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
    )
      .bind(uid, monsterId, name, rarity, kind, cost, now)
      .run();
  } catch {
    // 履歴記録の失敗は致命的ではない（クレジット・所有権は既に確定済み）。
  }
}

// 画像生成の全件ログ（成功/失敗/フォールバック追跡）。低確率間引きで30日超過分を自動削除。
export async function logImageGenEvent(env, event) {
  try {
    await env.AIMON_DB.prepare(
      `INSERT INTO image_gen_events
       (uid, monster_id, name, rarity, model, fallback, success, error_code, error_msg, duration_ms, source, charged, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
    ).bind(
      event.uid, event.monsterId, event.name, event.rarity,
      event.model, event.fallback ? 1 : 0, event.success ? 1 : 0,
      event.errorCode || null, (event.errorMsg || "").slice(0, 500),
      event.durationMs, event.source, event.charged ? 1 : 0,
      Date.now()
    ).run();
  } catch {
    // ログ記録失敗は本処理を止めない
  }
  sweepOldRows(env, "image_gen_events"); // fire-and-forget（低確率間引き・従来「30日自動掃除」の実体化）
}

// ── 失敗率スパイク検知（1時間に1回まで） ──────────────
let _lastSpikeCheck = 0;
const SPIKE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const SPIKE_MIN_ATTEMPTS = 5;
const SPIKE_THRESHOLD = 0.20;

export async function checkImageGenSpike(env) {
  const now = Date.now();
  if (now - _lastSpikeCheck < SPIKE_CHECK_INTERVAL_MS) return;
  _lastSpikeCheck = now;
  try {
    const since = now - SPIKE_CHECK_INTERVAL_MS;
    const row = await env.AIMON_DB.prepare(`
      SELECT COUNT(*) as total, COUNT(*) - SUM(success) as failed
      FROM image_gen_events WHERE created_at >= ?1
    `).bind(since).first();
    const total = row?.total || 0;
    const failed = row?.failed || 0;
    if (total < SPIKE_MIN_ATTEMPTS || failed / total < SPIKE_THRESHOLD) return;

    const modelRows = await env.AIMON_DB.prepare(`
      SELECT model, COUNT(*) as total, COUNT(*) - SUM(success) as failed
      FROM image_gen_events WHERE created_at >= ?1 GROUP BY model
    `).bind(since).all();
    const byModel = (modelRows.results || [])
      .map((r) => `${r.model}: ${r.failed}/${r.total}件失敗`).join(" / ");

    const topErr = await env.AIMON_DB.prepare(`
      SELECT error_msg, COUNT(*) as cnt
      FROM image_gen_events WHERE success = 0 AND created_at >= ?1 AND error_msg IS NOT NULL
      GROUP BY error_msg ORDER BY cnt DESC LIMIT 1
    `).bind(since).first();

    const { reportImageGenSpike } = await import("./_alerts.js");
    await reportImageGenSpike(env, {
      period: "1h", total, failed,
      failRate: failed / total,
      byModel,
      topError: topErr?.error_msg || null,
    });
  } catch {
    // スパイク検知の失敗は無視
  }
}

// ── 新規メイモン作成のコア処理 ──────────────────────────────
// 画像生成（フォールバック込み）とAIフレーバー生成を並列実行し、R2/コレクションへ保存、
// 履歴・初発見者レジストリを記録する。課金・返金・所有権チェックは呼び出し側の責務。
// aimon: _monster-gen.js が生成したカード情報一式（id/name/rarity/p/s/t/world/skill/hash等）。
// source: image_gen_events.source に記録する文字列（'generate' | 'resume' 等）。
// cost: gen_history に記録する額面（実際の課金額。resume等の無課金再開時は0を渡す）。
export async function generateAndSaveNewMonster(env, { user, aimon, nickname, source, cost }) {
  const monsterId = aimon.id;
  const baseHash = monsterId.slice(0, 12);
  const { name, rarity, p, s, t, world, skill } = aimon;

  const prompt = buildImagePrompt({ name, rarity, p, s, t, world, env, baseHash });
  const primary = pickImageModel(rarity, env);
  const fallback = primary === "gemini" ? "replicate" : "gemini";
  const imgStart = Date.now();

  let image;
  let usedSource = primary;
  let isFallback = false;
  let aiFlavor;
  try {
    // 画像生成とAIフレーバー生成を並列実行（レイテンシ削減・フレーバーはクライアント往復せず確定保存）。
    [image, aiFlavor] = await Promise.all([
      generateWithModel(env, primary, prompt).catch(async () => {
        isFallback = true;
        usedSource = `${fallback}-fallback`;
        return generateWithModel(env, fallback, prompt);
      }),
      tryGenerateAiFlavor(env, {
        type: skill.type, value: skill.value, rarity, monsterName: name, world, hash: aimon.hash,
      }),
    ]);

    await logImageGenEvent(env, {
      uid: user.uid, monsterId, name, rarity,
      model: primary, fallback: isFallback, success: true,
      durationMs: Date.now() - imgStart, source, charged: true,
    });
    checkImageGenSpike(env);

    await env.AIMON_IMAGES.put(r2Key(monsterId), image.bytes, {
      httpMetadata: { contentType: image.contentType },
    });

    const finalSkill = aiFlavor
      ? { ...skill, name: aiFlavor.name, flavor1: aiFlavor.flavor1, flavor2: aiFlavor.flavor2 }
      : skill;

    const freshCollection = (await env.AIMON_KV.get(`aimons:${user.uid}`, "json")) || [];
    const aimonToStore = {
      ...aimon,
      skill: finalSkill,
      id: monsterId,
      imageUrl: `/api/monster-image?id=${monsterId}`,
      savedAt: new Date().toISOString(),
    };
    const existIdx = freshCollection.findIndex((a) => a.id === monsterId);
    if (existIdx >= 0) freshCollection[existIdx] = aimonToStore;
    else freshCollection.push(aimonToStore);
    await saveAimons(env, user.uid, freshCollection);

    await logHistory(env, user.uid, monsterId, name, rarity, "generate", cost ?? 0, Date.now());

    const { record, isNewDiscovery } = await getOrCreateOrigin(env, baseHash, user.uid, nickname);

    return {
      url: `/api/monster-image?id=${monsterId}`,
      source: usedSource,
      origin: toOriginView(record, user.uid),
      isNewDiscovery,
      collectionCount: freshCollection.length,
      // クライアントの初回描画は generate.js が返した仮のスキル(AIフレーバー未反映)を使っているため、
      // 確定フレーバーを持ち帰らせてカードを更新できるようにする（フォールバック表示バグの修正・2026-08-22）。
      skill: finalSkill,
    };
  } catch (e) {
    await logImageGenEvent(env, {
      uid: user.uid, monsterId, name, rarity,
      model: "unknown", fallback: false, success: false,
      errorCode: e?.code || "generation_failed",
      errorMsg: e?.message || String(e),
      durationMs: Date.now() - imgStart, source, charged: true,
    });
    checkImageGenSpike(env);
    throw e;
  }
}
