// functions/api/_cron-auth.js
// cron専用Worker→Pages Functions間の内部呼び出し認証（docs/TECH_SPEC_X_API_INTEGRATION.md §6）。
// ユーザー操作ではないためFirebase認証は使わず、共有シークレットヘッダで検証する。
// シークレットは `wrangler secret put X_CRON_SECRET` で設定する（コードに含めない）。

export function verifyCronSecret(env, request) {
  const secret = env.X_CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("X-Cron-Secret");
  return !!header && header === secret;
}
