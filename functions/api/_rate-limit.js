// functions/api/_rate-limit.js
// 簡易レートリミッタ（isolate 単位・メモリ内）。
// 生成・プレビューAPIの無料試算（ブルートフォース）を抑制する防御レイヤ。
// サーバーレスでは isolate が頻繁に再生成されるため厳密な上限ではないが、
// 「認証必須 + クライアントにロジック非公開 + メモリ内レート制限」の多層防御の一環。
// 注意: 厳密なグローバル上限が必要なら D1 の rate_limit テーブル等に置き換えること。

const buckets = new Map(); // `${scope}:${key}` -> number[]（タイムスタンプ）

// 制限超過なら true を返す。limit 回 / windowMs の範囲内なら記録して false。
export function isRateLimited(scope, key, limit, windowMs = 60000) {
  const now = Date.now();
  const k = `${scope}:${key}`;
  let arr = buckets.get(k);
  if (!arr) {
    arr = [];
    buckets.set(k, arr);
  }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= limit) return true;
  arr.push(now);
  // 無意味に肥大させないため上限を超えた分は捨てる（防御）。
  if (arr.length > limit * 2) arr.splice(0, arr.length - limit * 2);
  return false;
}
