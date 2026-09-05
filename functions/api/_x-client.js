// functions/api/_x-client.js
// X（旧Twitter）API v1.1/v2 呼び出し用の共通クライアント（OAuth 1.0a）。
// 必要な環境変数（wrangler secret putで設定・コードに含めない）:
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
//
// 署名方針:
//   - GET / JSON body の POST（v2 /2/tweets 等）: OAuthパラメータのみを署名対象にする
//     （JSON bodyはapplication/x-www-form-urlencodedではないため署名対象外というOAuth1.0a/Twitter側の慣行に従う）
//   - multipart/form-data（media/upload）: 同様にOAuthパラメータのみを署名対象にする
//     （ファイル部分をbase64で署名に含めると巨大になるため、多くのOAuth1.0a実装がこの方式を採る）

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildSignatureBaseString(method, url, params) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sorted)}`;
}

async function hmacSha1Base64(key, data) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function buildOAuthHeader(env, method, url, extraSignedParams = {}) {
  const oauthParams = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const baseString = buildSignatureBaseString(method, url, { ...oauthParams, ...extraSignedParams });
  const signingKey = `${percentEncode(env.X_API_SECRET)}&${percentEncode(env.X_ACCESS_TOKEN_SECRET)}`;
  const signature = await hmacSha1Base64(signingKey, baseString);
  const headerParams = { ...oauthParams, oauth_signature: signature };
  return "OAuth " + Object.keys(headerParams).sort().map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`).join(", ");
}

function assertCredentials(env) {
  if (!env.X_API_KEY || !env.X_API_SECRET || !env.X_ACCESS_TOKEN || !env.X_ACCESS_TOKEN_SECRET) {
    throw new Error("X API credentials not configured (X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_TOKEN_SECRET)");
  }
}

// 画像1枚をアップロードし media_id を返す（シンプルアップロード・5MB程度まで想定）。
export async function uploadMedia(env, imageBytes, contentType) {
  assertCredentials(env);
  const url = "https://upload.x.com/1.1/media/upload.json";
  const authHeader = await buildOAuthHeader(env, "POST", url);
  const form = new FormData();
  form.append("media", new Blob([imageBytes], { type: contentType || "image/png" }), "image.png");
  const res = await fetch(url, { method: "POST", headers: { Authorization: authHeader }, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`media upload failed: ${JSON.stringify(data)}`);
  return data.media_id_string;
}

// ツイートを投稿し tweet_id を返す（v2 /2/tweets）。
export async function postTweet(env, { text, mediaIds } = {}) {
  assertCredentials(env);
  const url = "https://api.x.com/2/tweets";
  const authHeader = await buildOAuthHeader(env, "POST", url);
  const body = { text };
  if (mediaIds && mediaIds.length > 0) body.media = { media_ids: mediaIds };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`tweet post failed: ${JSON.stringify(data)}`);
  return data.data?.id;
}

// 認証済みアカウント自身のユーザーID（数値文字列）を取得する。
export async function getMyUserId(env) {
  assertCredentials(env);
  const url = "https://api.x.com/2/users/me";
  const authHeader = await buildOAuthHeader(env, "GET", url);
  const res = await fetch(url, { method: "GET", headers: { Authorization: authHeader } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`users/me failed: ${JSON.stringify(data)}`);
  return data.data?.id;
}

// 指定ツイートをプロフィールに固定表示する。
export async function pinTweet(env, { tweetId, userId } = {}) {
  assertCredentials(env);
  const uid = userId || (await getMyUserId(env));
  const url = `https://api.x.com/2/users/${uid}/pinned_tweet`;
  const authHeader = await buildOAuthHeader(env, "POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ tweet_id: tweetId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`pin tweet failed: ${JSON.stringify(data)}`);
  return data.data?.pinned === true;
}
