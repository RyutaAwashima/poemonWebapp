// functions/api/_registry.js
// 初発見者レジストリ（「おや」）の共通ヘルパー。D1 原子化版（設計 §9.4）。
// - getOrigin: 読み出し（D1 優先・KV aimon-origin:{baseHash} フォールバック＋遅延移行）
// - getOrCreateOrigin: first-write-wins で記録（D1 INSERT OR IGNORE がアトミックゲート）
// monster-image.js（生成時記録）と aimons.js（一覧表示時の読み出し）から使う。

// レジストリ行 → 表示用 origin オブジェクト（フル uid は返さない）。
// record.origin_rank_tier/origin_rank_group が付与されていれば、宝石ランクバッジ用のアイコンキーも返す
// （tier=7はダイヤ固定、グループ未選択ならnull=バッジ非表示）。
export function toOriginView(record, currentUid) {
  const rankTier = record?.origin_rank_tier ?? null;
  const rankGroup = record?.origin_rank_group ?? null;
  return {
    nickname: record?.nickname || "不明",
    shortUid: (record?.uid || "").slice(0, 8).toUpperCase(),
    isMine: !!record?.uid && record.uid === currentUid,
    discoveredAt: record?.discovered_at ? new Date(record.discovered_at).toISOString() : null,
    rankIconKey: rankTier === 7 ? "diamond" : rankGroup,
  };
}

// 読み出し。D1 優先。D1 に無い場合は KV（移行待ち分）をフォールバックし、
// 見つけたら D1 へ遅延移行する（冪等・読み出し時に1回だけ）。
export async function getOrigin(env, baseHash) {
  if (!baseHash) return null;
  try {
    const row = await env.AIMON_DB.prepare(
      `SELECT mr.*, u.rank_tier AS origin_rank_tier, u.rank_group AS origin_rank_group
       FROM monster_registry mr LEFT JOIN users u ON u.uid = mr.uid
       WHERE mr.base_hash = ?1`
    )
      .bind(baseHash)
      .first();
    if (row) return row;
  } catch {
    // マイグレーション未適用などの場合は KV のみで動作する。
  }

  // KV フォールバック＋D1 へ遅延移行（既存レコードをコピー。first-write-wins は保持）。
  let kv = null;
  try {
    kv = await env.AIMON_KV.get(`aimon-origin:${baseHash}`, "json");
  } catch {
    return null;
  }
  if (!kv) return null;

  try {
    const ts = kv.discoveredAt ? Date.parse(kv.discoveredAt) : Date.now();
    await env.AIMON_DB.prepare(
      `INSERT OR IGNORE INTO monster_registry (base_hash, uid, nickname, discovered_at) VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(baseHash, kv.uid || "", kv.nickname || null, ts)
      .run();
    const row = await env.AIMON_DB.prepare(
      `SELECT mr.*, u.rank_tier AS origin_rank_tier, u.rank_group AS origin_rank_group
       FROM monster_registry mr LEFT JOIN users u ON u.uid = mr.uid
       WHERE mr.base_hash = ?1`
    )
      .bind(baseHash)
      .first();
    if (row) return row;
  } catch {
    // D1 移行失敗時も表示は KV で継続する。
  }
  return {
    uid: kv.uid || "",
    nickname: kv.nickname || null,
    discovered_at: kv.discoveredAt ? Date.parse(kv.discoveredAt) : Date.now(),
  };
}

// first-write-wins で記録する（設計 §9.4）。
// 既存レコードがある場合: { record, isNewDiscovery:false }。
// 無い場合: この uid/nickname で INSERT OR IGNORE し、勝ったら isNewDiscovery:true。
// 移行期間中の読み出し互換のため KV（aimon-origin:{baseHash}）にも反映する（D1 が正）。
export async function getOrCreateOrigin(env, baseHash, uid, nickname) {
  const existing = await getOrigin(env, baseHash);
  if (existing) {
    return { record: existing, isNewDiscovery: false };
  }

  const now = Date.now();
  let record = null;
  try {
    const res = await env.AIMON_DB.prepare(
      `INSERT OR IGNORE INTO monster_registry (base_hash, uid, nickname, discovered_at) VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(baseHash, uid, nickname || null, now)
      .run();
    if (res.meta?.changes > 0) {
      record = { base_hash: baseHash, uid, nickname: nickname || null, discovered_at: now };
    } else {
      // 同時リクエストに負けた: 勝者のレコードを読み直す。
      record = await env.AIMON_DB.prepare(
        "SELECT * FROM monster_registry WHERE base_hash = ?1"
      )
        .bind(baseHash)
        .first();
    }
  } catch {
    // D1 が未適用の場合は従来の KV first-write-wins にフォールバック。
    const key = `aimon-origin:${baseHash}`;
    const kv = await env.AIMON_KV.get(key, "json").catch(() => null);
    if (kv) {
      record = {
        uid: kv.uid || "",
        nickname: kv.nickname || null,
        discovered_at: kv.discoveredAt ? Date.parse(kv.discoveredAt) : Date.now(),
      };
    } else {
      await env.AIMON_KV.put(
        key,
        JSON.stringify({ uid, nickname: nickname || null, discoveredAt: new Date(now).toISOString() })
      ).catch(() => {});
      record = { base_hash: baseHash, uid, nickname: nickname || null, discovered_at: now };
    }
  }

  // 読み出し互換のため KV にも反映（失敗しても生成は続行）。
  try {
    await env.AIMON_KV.put(
      `aimon-origin:${baseHash}`,
      JSON.stringify({
        uid: record.uid,
        nickname: record.nickname || null,
        discoveredAt: new Date(record.discovered_at).toISOString(),
      })
    );
  } catch {
    // ignore
  }

  return { record, isNewDiscovery: !!record && record.uid === uid };
}
