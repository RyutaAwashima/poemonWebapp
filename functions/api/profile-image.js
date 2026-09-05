// functions/api/profile-image.js
// プレイヤープロフィール画像（アバター）の生成・配信エンドポイント。
// モンスター画像生成（monster-image.js）と同じ Gemini→Replicate フォールバック・R2永続化の
// 仕組みを流用し、アートスタイルも同じ ART_STYLES（ethereal/moe/epic/pop）から選ぶ。
// GET  /api/profile-image?uid={uid}                              → R2に保存済みの画像をストリーム配信（公開・認証不要）
// POST /api/profile-image { styleKey, extraPrompt }（要認証）     → 画像生成＋R2保存、{ url, source, free } を返す
//   - ニックネームは users.nickname をそのまま使う（専用の入力欄は設けない）
//   - 初回生成のみ無料（users.avatar_free_used）。2回目以降・再生成は1クレジット消費

import { authFromRequest } from "./_auth.js";
import { getUser, isAccountLocked, normalizeNickname } from "./_users.js";
import { CORS, json } from "./_credits.js";
import { reportBillingIncident } from "./_alerts.js";
import { ART_STYLES } from "./monster-image.js";

const AVATAR_COST = 5; // 2回目以降の生成1回あたりのクレジット消費（monster-image.js の IMAGE_COST と同額・2026-08-14 経済改定で 1 → 5）
const EXTRA_PROMPT_MAX = 60; // 追加プロンプトの文字数上限

function r2Key(uid) {
  return `profiles/${uid}.jpg`;
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// バストアップ（胸上）の人物ポートレート・正方形のプロンプトを組み立てる。
// モンスターと異なり実在の人物を描くため、ニックネームは「〜という名の人物」程度の軽い記述に留める。
// 円形アバターとして表示するため、被写体の顔が正方形キャンバスの中心に来ることが特に重要
// （2026-08-11: 生成結果が左右どちらかに寄ってしまい、丸くトリミングすると顔が切れる不具合の対策で
//  中央配置の指示を強化・繰り返している）。
function buildPrompt({ nickname, artStyle, extraPrompt }) {
  return (
    `A symmetrical, centered close-up headshot portrait illustration of a fictional character/avatar known by the handle "${nickname}", ` +
    `face and eyes exactly in the middle of the frame both horizontally and vertically, head-on symmetrical pose facing directly at the viewer, ` +
    `head and shoulders framing (bust-up), confident and friendly expression. ` +
    `Art style: ${artStyle}. ` +
    (extraPrompt ? `Additional details: ${extraPrompt}. ` : "") +
    `No card border, no frame, plain simple background. ` +
    `Do not include any text, letters, numbers, words, titles, captions, watermark, signature, or logo anywhere in the image. ` +
    `IMPORTANT: The image MUST be a perfect square (1:1 aspect ratio, equal width and height), with the character's face centered dead in the middle of the square — not shifted left, right, up, or down. This image will be cropped into a circle around its exact center, so keep the whole head safely within the middle of the frame with even margin on all four sides.`
  );
}

async function callGeminiImage(env, prompt) {
  const token = env.GEMINI_API_TOKEN;
  if (!token) throw new Error("GEMINI_API_TOKEN not configured");

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
    {
      method: "POST",
      headers: {
        "x-goog-api-key": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          imageConfig: { aspectRatio: "1:1" },
        },
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
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        input: {
          prompt,
          num_outputs: 1,
          aspect_ratio: "1:1",
          output_format: "jpg",
          output_quality: 90,
        },
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

// NGワード／版権名リストはユーザー一覧API(users.js)と同じJSONを読む（追加プロンプトの簡易モデレーション用）。
let cachedNgWords = null;
async function loadNgWords(request) {
  if (cachedNgWords) return cachedNgWords;
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(`${origin}/app/data/ng-words-ja.json`);
    const data = res.ok ? await res.json() : { words: [] };
    cachedNgWords = (data.words || []).map(normalizeNickname).filter(Boolean);
  } catch {
    cachedNgWords = cachedNgWords || [];
  }
  return cachedNgWords;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);

  if (request.method === "GET") {
    const uid = url.searchParams.get("uid");
    if (!uid) return json({ error: "missing uid" }, 400);

    const object = await env.AIMON_IMAGES.get(r2Key(uid));
    if (!object) return json({ error: "not found" }, 404);

    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
        "Cache-Control": "public, max-age=300", // 再生成で同じキーを上書きするため短めのTTL
        ...CORS,
      },
    });
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const user = await authFromRequest(env, request);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (await isAccountLocked(env, user.uid)) {
    return json({ error: "account_locked" }, 403);
  }

  const row = await getUser(env, user.uid);
  const nickname = row?.nickname;
  if (!nickname) {
    return json({ error: "nickname_required", message: "先にニックネームを設定してください" }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const styleKey = body?.styleKey;
  if (!styleKey || !ART_STYLES[styleKey]) {
    return json({ error: "invalid styleKey" }, 400);
  }
  const extraPromptRaw = typeof body?.extraPrompt === "string" ? body.extraPrompt.trim() : "";
  if (extraPromptRaw.length > EXTRA_PROMPT_MAX) {
    return json({ error: "extraPrompt too long", max: EXTRA_PROMPT_MAX }, 400);
  }
  const ngWords = await loadNgWords(request);
  const normExtra = normalizeNickname(extraPromptRaw);
  if (normExtra && ngWords.some((w) => w && normExtra.includes(w))) {
    return json({ error: "追加プロンプトに使用できない単語が含まれています" }, 400);
  }

  const now = Date.now();
  const isFree = !row.avatar_free_used;
  let charged = false;
  let chargeRef = null;

  try {
    if (!isFree) {
      const charge = await env.AIMON_DB.prepare(
        "UPDATE users SET credits = credits - ?1, updated_at = ?2 WHERE uid = ?3 AND credits >= ?1"
      )
        .bind(AVATAR_COST, now, user.uid)
        .run();
      if (charge.meta?.changes === 0) {
        return json(
          { error: "insufficient_credits", message: "クレジットが不足しています" },
          403
        );
      }
      charged = true;
      chargeRef = `avatar-${user.uid}-${crypto.randomUUID()}`;
      await env.AIMON_DB.prepare(
        "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'avatar', ?3, ?4)"
      )
        .bind(user.uid, -AVATAR_COST, chargeRef, now)
        .run();
    }

    const prompt = buildPrompt({
      nickname,
      artStyle: ART_STYLES[styleKey],
      extraPrompt: extraPromptRaw,
    });

    let imageBytes;
    let contentType = "image/jpeg";
    let source = "gemini";
    try {
      const gemini = await callGeminiImage(env, prompt);
      imageBytes = gemini.bytes;
      contentType = gemini.contentType;
    } catch {
      source = "replicate-fallback";
      const imageUrl = await callReplicateImage(env, prompt);
      const imageRes = await fetch(imageUrl);
      if (!imageRes.ok) throw new Error(`image fetch failed: ${imageRes.status}`);
      imageBytes = await imageRes.arrayBuffer();
      contentType = "image/jpeg";
    }

    await env.AIMON_IMAGES.put(r2Key(user.uid), imageBytes, {
      httpMetadata: { contentType },
    });

    await env.AIMON_DB.prepare(
      "UPDATE users SET avatar_updated_at = ?1, avatar_free_used = 1, updated_at = ?1 WHERE uid = ?2"
    )
      .bind(now, user.uid)
      .run();

    return json({ url: `/api/profile-image?uid=${user.uid}&v=${now}`, source, free: isFree });
  } catch (e) {
    if (charged) {
      try {
        await env.AIMON_DB.prepare(
          "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'refund', ?3, ?4)"
        )
          .bind(user.uid, AVATAR_COST, chargeRef, now)
          .run();
        await env.AIMON_DB.prepare("UPDATE users SET credits = credits + ?1 WHERE uid = ?2")
          .bind(AVATAR_COST, user.uid)
          .run();
      } catch (refundErr) {
        await reportBillingIncident(env, {
          kind: "refund_failed",
          uid: user.uid,
          ref: chargeRef,
          detail: { cost: AVATAR_COST, context: "avatar_generate_failed", error: refundErr?.message },
        });
      }
    }
    return json({ error: e.message || "image generation failed" }, 502);
  }
}
