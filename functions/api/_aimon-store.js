// functions/api/_aimon-store.js
// aimons:{uid} コレクション（ユーザーが時間をかけて育てたアイモン資産）への書き込みを
// 一本化する「関所」。各エンドポイントが直接 env.AIMON_KV.put(`aimons:${uid}`, ...) を
// 呼ぶのをやめ、必ずこの saveAimons を経由させることで、部分オブジェクトの誤代入等で
// レコードが壊れた場合に「サイレントなデータ破損」ではなく「保存前の例外」として検出する。
// （2026-08 grantBattleXp が addXp の戻り値を丸ごと代入し、レベルアップの度に
//  hp/p/s/t/name/skill 等が失われていた事故の再発防止）

// 必須フィールド。育成（level/xp/masterpiece/slots）はレベル1・XP0等で復元可能だが、
// これらが欠けたレコードは「別のモンスター」として扱えないほど壊れているとみなす。
const REQUIRED_FIELDS = ["id", "name", "hp", "p", "s", "t", "rarity"];

export function assertValidAimon(aimon, index = 0) {
  if (!aimon || typeof aimon !== "object") {
    throw new Error(`aimon record corrupted at index ${index}: not an object`);
  }
  for (const key of REQUIRED_FIELDS) {
    if (aimon[key] === undefined || aimon[key] === null) {
      throw new Error(
        `aimon record corrupted at index ${index} (id=${aimon.id ?? "?"}): missing "${key}"`
      );
    }
  }
}

// data: aimons:{uid} に保存する配列全体。保存前に全件検証するが、失敗しても保存はブロック
// しない（ログのみ）。
// 注意（2026-08-11 教訓）: 以前はここで例外を投げて保存自体を中止していたが、それだと
// 「過去に別の原因で壊れた無関係な1件」が居るだけで、そのユーザーの以後の全ての保存
// （レベルアップ・育成・XP付与等）が永久にブロックされてしまう事故があった
// （3ユーザーが影響を受け、ランクマッチのXP/演出が一切出なくなった）。
// 検出はしたいが、無関係な操作を道連れにしないよう非致命的なログ止まりにする。
// 直前の値は aimons:{uid}:prev に1世代だけ退避する（全履歴ではなく最新1件のみの保険）。
export async function saveAimons(env, uid, data) {
  data.forEach((aimon, i) => {
    try {
      assertValidAimon(aimon, i);
    } catch (err) {
      console.error(`[saveAimons] uid=${uid}: ${err.message}`);
    }
  });
  const kvKey = `aimons:${uid}`;
  try {
    const prev = await env.AIMON_KV.get(kvKey);
    if (prev != null) await env.AIMON_KV.put(`${kvKey}:prev`, prev);
  } catch {
    // 退避の失敗は保存自体を妨げない（あくまで保険なので握りつぶす）。
  }
  await env.AIMON_KV.put(kvKey, JSON.stringify(data));
}
