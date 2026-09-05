// メンテナンスモード判定（各APIの入口から呼ばれる共有モジュール。ファイル名先頭"_"のため公開ルートにはならない）。
// KV(AIMON_KV) の "maintenance:enabled" が "1" の間、developer/admin 以外のリクエストを503で止める。
// フラグ未設定時は常にバイパス（既存動作を変えない安全なデフォルト）。
import { authFromRequest } from "./_auth.js";
import { getUser } from "./_users.js";
import { json } from "./_credits.js";

const STAFF_ROLES = new Set(["developer", "admin"]);

export async function checkMaintenance(context) {
  const { request, env } = context;
  const enabled = await env.AIMON_KV.get("maintenance:enabled");
  if (enabled !== "1") return null;

  const user = await authFromRequest(env, request);
  if (user) {
    const row = await getUser(env, user.uid);
    if (row && STAFF_ROLES.has(row.role)) return null;
  }

  const message = (await env.AIMON_KV.get("maintenance:message")) || "只今メンテナンス中です。しばらくお待ちください。";
  return { response: json({ error: "maintenance", message }, 503) };
}
