// functions/api/_alerts.js
// 課金関連の異常検知アラート共通ヘルパー。
// D1 の billing_incidents に永続記録した上で、Discord Webhook（env.DISCORD_WEBHOOK_URL）へ即時通知する。
// アラート自体の失敗が本処理（決済・生成フロー）を止めないよう、内部で例外を握りつぶす。

const DISCORD_MAX_LEN = 1900; // Discordのcontent上限(2000)に余裕を持たせる

function kindLabel(kind) {
  return (
    {
      purchase_grant_failed: "🚨 購入クレジット未付与",
      refund_failed: "🚨 返金失敗",
      user_report: "📩 ユーザー問題報告",
    }[kind] || `🚨 ${kind}`
  );
}

// kind: 'purchase_grant_failed' | 'refund_failed' | 'user_report' | 'image_gen_spike'
// uid/ref: 関連するユーザーID・参照キー（任意）
// detail: 診断用の追加情報（JSON化して保存・通知に含める）
export async function reportBillingIncident(env, { kind, uid = null, ref = null, detail = null }) {
  const now = Date.now();
  try {
    await env.AIMON_DB.prepare(
      `INSERT INTO billing_incidents (kind, uid, ref, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(kind, uid, ref, detail ? JSON.stringify(detail) : null, now)
      .run();
  } catch {
    // D1書き込み失敗時もアラート自体は試みる（後段のtry/catchで独立に処理）
  }

  try {
    if (!env.DISCORD_WEBHOOK_URL) return;
    const lines = [
      kindLabel(kind),
      uid ? `uid: \`${uid}\`` : null,
      ref ? `ref: \`${ref}\`` : null,
      detail ? "```json\n" + JSON.stringify(detail, null, 2) + "\n```" : null,
    ]
      .filter(Boolean)
      .join("\n");
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: lines.slice(0, DISCORD_MAX_LEN) }),
    });
  } catch {
    // Discord通知の失敗は無視する（D1には既に記録済みのため後から確認できる）
  }
}

// 画像生成失敗率スパイク検知（直近1hの集計を呼ぶ側で実施し、閾値超えたらこの関数を呼ぶ）。
export async function reportImageGenSpike(env, { period, total, failed, failRate, byModel, topError }) {
  const lines = [
    `⚠️ 画像生成失敗率スパイク`,
    `直近${period}: 失敗 ${failed}/${total}件 (${(failRate * 100).toFixed(1)}%)`,
    byModel || "",
    topError ? `最も頻出エラー: "${topError}"` : "",
  ].filter(Boolean).join("\n");

  try {
    if (!env.DISCORD_WEBHOOK_URL) return;
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: lines.slice(0, DISCORD_MAX_LEN) }),
    });
  } catch {
    // Discord通知の失敗は無視
  }
}
