// 全 API で共通利用する Firebase ID token 検証モジュール（Pages Functions の共有コード）。
// Authorization: Bearer <idToken> を受け取り、RS256 署名と claims を検証して { uid } を返す。
// ファイル名の先頭が "_" のため、ルートとしては公開されない共有モジュール扱いになる。

// TODO: 新プロジェクトの Firebase projectId に差し替えること（sangyoufare2026 の実値は除去済み）
const PROJECT_ID = "YOUR_PROJECT_ID"; // app/firebase-config.js の projectId と一致
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;
const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1時間（Google は約1週間で鍵をローテーション）

// モジュールスコープのキャッシュ（isolate ごと。1時間で再取得）。
let cachedJwks = null;
let cachedAt = 0;

async function getJwks(env) {
  const now = Date.now();
  if (cachedJwks && now - cachedAt < CACHE_TTL_MS) return cachedJwks;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  cachedJwks = await res.json();
  cachedAt = now;
  return cachedJwks;
}

function base64UrlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function parseJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  return { header, payload, signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
}

export async function verifyFirebaseToken(env, token) {
  const { header, payload, signature, signingInput } = parseJwt(token);
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  if (payload.aud !== PROJECT_ID) throw new Error("bad aud");
  if (payload.iss !== ISSUER) throw new Error("bad iss");

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > payload.exp) throw new Error("token expired");
  if (nowSec < payload.iat - 300) throw new Error("token not yet valid");

  const jwks = await getJwks(env);
  const key = jwks.keys?.find((k) => k.kid === header.kid);
  if (!key) throw new Error("unknown kid");

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: key.n, e: key.e, alg: "RS256" },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    base64UrlDecode(signature),
    new TextEncoder().encode(signingInput)
  );
  if (!ok) throw new Error("bad signature");

  return { uid: payload.sub || payload.user_id, email: payload.email || null };
}

// リクエストから Bearer トークンを取り出して検証する。失敗時は null。
export async function authFromRequest(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  try {
    return await verifyFirebaseToken(env, match[1]);
  } catch {
    return null;
  }
}

// authFromRequest と同じ検証を行い、{ uid, email, token } も返す。
// RTDB REST API を呼び出し元ユーザーとして叩く場合（rank/forfeit.js 等）に使う。
export async function authTokenFromRequest(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  try {
    const user = await verifyFirebaseToken(env, match[1]);
    return { ...user, token: match[1] };
  } catch {
    return null;
  }
}
