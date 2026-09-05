// functions/api/_error-log.js
// 汎用エラーログ（未知のクラッシュ・バグ調査用・2026-08-22）。
// billing_incidents（課金インシデント）・image_gen_events（画像生成の可観測性）と役割を分け、
// こちらは「原因不明の例外」を機能を問わず広く受け止める共通の受け皿として使う。
// 肥大化防止: message/detail は truncate し、書き込みのたび低確率(1/50)で
// 30日超過分を間引き削除する（checkImageGenSpike と同じサンプリング方式・Cron常設なしで運用）。

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30日
const SWEEP_PROBABILITY = 1 / 50;

// 間引き削除対象として許可するテーブル（SQL文字列組み立てへの外部入力混入を防ぐホワイトリスト）。
const SWEEPABLE_TABLES = new Set(["app_errors", "image_gen_events"]);

// scope: 発生箇所を表す短い文字列（例: 'monster-image' | 'resume' | 'flavor-gen'）。
// detail: 診断用の追加情報（JSON化して保存。truncateされるため機密情報は含めないこと）。
export async function logError(env, { scope, uid = null, message, detail = null }) {
  try {
    await env.AIMON_DB.prepare(
      `INSERT INTO app_errors (scope, uid, message, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(
        scope,
        uid,
        String(message || "").slice(0, 500),
        detail ? JSON.stringify(detail).slice(0, 2000) : null,
        Date.now()
      )
      .run();
  } catch {
    // ログ基盤自体の失敗で本処理を止めない
  }
  sweepOldRows(env, "app_errors"); // fire-and-forget（低確率間引き）
}

// created_at ベースの古い行を低確率で間引き削除する（table は呼び出し側の固定文字列のみ許可）。
export async function sweepOldRows(env, table, retentionMs = RETENTION_MS) {
  if (!SWEEPABLE_TABLES.has(table)) return;
  if (Math.random() > SWEEP_PROBABILITY) return;
  try {
    const cutoff = Date.now() - retentionMs;
    await env.AIMON_DB.prepare(`DELETE FROM ${table} WHERE created_at < ?1`).bind(cutoff).run();
  } catch {
    // 間引き削除の失敗は無視（次回の確率抽選に任せる）
  }
}
