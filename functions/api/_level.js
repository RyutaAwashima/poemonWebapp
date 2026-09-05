// functions/api/_level.js
// 育成システム再設計（レベル・XP・願いのカケラ）の共通定義と計算ヘルパー。
// レベルは「育成（願いの力＝スロット抽選）」の消費リソース。
//   XP10でレベル+1。最大レベル99まで貯蓄可能。スロット抽選（願いの力）は1回5レベル消費。
//   願いの雫1個 = XP100（=レベル+10）。バトルでXP獲得（対人戦20・ランクは獲得LPの50%追加）。
//   レベル上限(99)到達後のあぶれXPは「願いのカケラ」に1:1変換（無駄にならない救済措置）。
//   カケラ100個 = 願いの雫1個にショップで交換。
//   一度でもレベル上限に達したアイモンは masterpiece フラグが永続する（フレーム演出用）。
// クライアント側（app/aimon-core.js 等）にも同一の計算を保持する（表示用）。
//
// 命名規約: normalizeTraining は { level, xp, masterpiece } の部分オブジェクトだけを返す。
// addXp/consumeLevels の戻り値 .aimon は引数 aimon の全フィールドを保持した完全なオブジェクトであり、
// 部分オブジェクトではない。保存時は saveAimons（./_aimon-store.js）を必ず経由する。

import { saveAimons } from "./_aimon-store.js";
import { normalizeSlots, LEVEL_SLOT_UNLOCK } from "./_slots.js";

export { LEVEL_SLOT_UNLOCK }; // 正規定義は _slots.js（スロット2=レベル50解放）

export const XP_PER_LEVEL = 10; // XP10でレベル+1
export const MAX_LEVEL = 99; // 最大レベル（貯蓄可能上限）
export const CPU_BATTLE_XP = 5; // CPU対戦の基礎XP（今回の実装では見送りのため未使用）
export const PVP_BATTLE_XP = 20; // 対人戦（通信・ランク/ルーム）の基礎XP
export const RANK_LP_XP_RATE = 0.5; // ランクマッチ: 獲得LPの50%をXPとして追加
export const WISH_XP = 100; // 願いの雫1個 = XP100（=レベル+10）
export const DRAW_LEVEL_COST = 5; // 願いの力（スロット抽選）1回 = 5レベル消費
export const FRAGMENT_PER_OVERFLOW_XP = 1; // あぶれXP1 = 願いのカケラ1
export const FRAGMENTS_PER_WISH = 100; // 願いのカケラ100 = 願いの雫1（ショップ交換）

// 特殊メイモン（ユニーク・隠し）は aimon.xpPerLevel / aimon.drawLevelCost で通常値を上書きする
// （docs/HIDDEN_AIMON_SPEC.md §2.3。育成を通常より遅くする入手難度バランス）。未指定は通常値。
export function getXpPerLevel(aimon) {
  const v = Number(aimon?.xpPerLevel);
  return Number.isFinite(v) && v > 0 ? v : XP_PER_LEVEL;
}

export function getDrawLevelCost(aimon) {
  const v = Number(aimon?.drawLevelCost);
  return Number.isFinite(v) && v > 0 ? v : DRAW_LEVEL_COST;
}

// aimon の育成データ（level/xp/masterpiece）を正規化する。
// レベルは0から始まる（願いの洞窟でレベル5を消費して0になっても正規の値）。
// 旧データ（フィールド無し）はレベル0・XP0・masterpiece:false として補完する。
export function normalizeTraining(aimon = {}) {
  const xpPerLevel = getXpPerLevel(aimon);
  const level = Number.isFinite(aimon.level)
    ? Math.min(MAX_LEVEL, Math.max(0, Math.floor(aimon.level)))
    : 0;
  const xp = Number.isFinite(aimon.xp)
    ? Math.min(xpPerLevel - 1, Math.max(0, Math.floor(aimon.xp)))
    : 0;
  const reachedMax = level >= MAX_LEVEL;
  return {
    level,
    xp,
    masterpiece: aimon.masterpiece === true || reachedMax,
  };
}

// レベル50到達時にスロット2（index1）を解放する（恒久・レベルが下がっても維持）。
// 常にスロット配列を3枠へ補完し、初回解放時のみ slotUnlocked を true にする（演出用）。
function applyLevelSlotUnlock(aimon, level) {
  const before = Array.isArray(aimon.slots) ? aimon.slots[1]?.opened === true : false;
  const slots = normalizeSlots(aimon.slots, aimon.rarity, level);
  const slotUnlocked = (Number(level) || 0) >= LEVEL_SLOT_UNLOCK && !before && slots[1]?.opened === true;
  aimon.slots = slots;
  return { aimon, slotUnlocked };
}

// XPを加算する。レベルアップ・上限超過時のカケラ変換・masterpiece 永続化・レベル50解放を処理する。
// 戻り値: { aimon, overflowFragments, leveledUp, reachedMax, slotUnlocked }
//   - overflowFragments: 上限到達後のあぶれXPが変換された願いのカケラ数（users.fragments へ加算する）
//   - reachedMax: 今回の加算で初めてレベル上限(99)に到達した（masterpiece が新たに立つ）
//   - slotUnlocked: 今回の加算で初めてレベル50に到達しスロット2が解放された（演出用）
// 注意: 戻り値の aimon は必ず引数 aimon の全フィールド（hp/p/s/t/name/skill等）を保持したまま返す（level/xp/masterpiece/slotsのみ上書き）。
// normalizeTraining はトレーニング部分だけを返すため、ここで { ...aimon, ...t } で必ず元データと合成する。
export function addXp(aimon, xp) {
  const t = normalizeTraining(aimon);
  const xpPerLevel = getXpPerLevel(aimon);
  const gain = Math.max(0, Math.floor(xp || 0));
  if (gain === 0) {
    const unlock = applyLevelSlotUnlock({ ...aimon, ...t }, t.level);
    return { aimon: unlock.aimon, overflowFragments: 0, leveledUp: false, reachedMax: false, slotUnlocked: unlock.slotUnlocked };
  }

  // 既に上限到達済み: 獲得XPは全額カケラに変換（XPは貯まらない）。
  if (t.level >= MAX_LEVEL) {
    const unlock = applyLevelSlotUnlock({ ...aimon, ...t, masterpiece: true }, t.level);
    return {
      aimon: unlock.aimon,
      overflowFragments: Math.floor(gain / FRAGMENT_PER_OVERFLOW_XP),
      leveledUp: false,
      reachedMax: false,
      slotUnlocked: unlock.slotUnlocked,
    };
  }

  const totalXp = t.xp + gain;
  const addLevels = Math.floor(totalXp / xpPerLevel);
  let newLevel = t.level + addLevels;
  let remainder = totalXp % xpPerLevel;
  let overflowFragments = 0;

  // レベル上限を超えた分はカケラに変換する。
  if (newLevel > MAX_LEVEL) {
    const excessLevels = newLevel - MAX_LEVEL;
    overflowFragments = Math.floor((excessLevels * xpPerLevel + remainder) / FRAGMENT_PER_OVERFLOW_XP);
    newLevel = MAX_LEVEL;
    remainder = 0;
  }

  const reachedMax = newLevel >= MAX_LEVEL && t.level < MAX_LEVEL;
  const merged = { ...aimon, ...t, level: newLevel, xp: remainder, masterpiece: t.masterpiece || reachedMax };

  // 特殊メイモン（ユニーク・隠し）限定: レベル99到達で永続HP+100（docs/HIDDEN_AIMON_SPEC.md §2.3）。
  // reachedMax は「今回初めて上限に到達した」場合のみ true になるため、この分岐は生涯で一度だけ通る。
  if (reachedMax && aimon.isUnique === true && aimon.hpBonusApplied !== true) {
    merged.hp = (Number(merged.hp) || 0) + 100;
    merged.baseStats = { ...(merged.baseStats || {}), hp: (Number(merged.baseStats?.hp) || 0) + 100 };
    merged.hpBonusApplied = true;
  }

  const unlock = applyLevelSlotUnlock(merged, newLevel);
  return {
    aimon: unlock.aimon,
    overflowFragments,
    leveledUp: newLevel > t.level,
    reachedMax,
    slotUnlocked: unlock.slotUnlocked,
  };
}

// レベルを消費する（願いの力＝スロット抽選）。
// levels 省略時は aimon.drawLevelCost（特殊メイモンは3）/ DRAW_LEVEL_COST（通常5）を使う。
// 戻り値: { ok: true, aimon } / { ok: false, reason: "not_enough_levels", aimon }
// レベルは下がるが masterpiece フラグは維持される（一度でも上限到達なら永続）。
export function consumeLevels(aimon, levels) {
  const t = normalizeTraining(aimon);
  const cost = Math.max(0, Math.floor(levels ?? getDrawLevelCost(aimon)));
  if (t.level < cost) {
    return { ok: false, reason: "not_enough_levels", aimon: { ...aimon, ...t } };
  }
  return { ok: true, aimon: { ...aimon, ...t, level: t.level - cost } };
}

// 願いの雫1個分のXP（100 = レベル+10）を付与する。
export function grantWishXp(aimon) {
  return addXp(aimon, WISH_XP);
}

// 複数アイモン（バトル参加メンバー）にXPを付与し、あぶれ分の願いのカケラを
// users.fragments に加算する。バトルXPの共通付与処理（rank/report ・ monster/xp で使用）。
// 戻り値: { overflowFragments, leveledUpCount, reachedMaxCount, slotUnlockedCount }
//   - slotUnlockedCount: 今回の付与で初めてレベル50に到達しスロット2が解放された数（演出用）
export async function grantBattleXp(env, uid, monsterIds, xp) {
  const ids = Array.isArray(monsterIds) ? monsterIds.filter((v) => typeof v === "string") : [];
  if (ids.length === 0) {
    return { overflowFragments: 0, leveledUpCount: 0, reachedMaxCount: 0, slotUnlockedCount: 0 };
  }

  const kvKey = `aimons:${uid}`;
  const data = (await env.AIMON_KV.get(kvKey, "json")) || [];
  const idSet = new Set(ids);
  let overflowFragments = 0;
  let leveledUpCount = 0;
  let reachedMaxCount = 0;
  let slotUnlockedCount = 0;
  let changed = false;

  for (let i = 0; i < data.length; i += 1) {
    const a = data[i];
    if (!idSet.has(a.id)) continue;
    const res = addXp(a, xp);
    data[i] = res.aimon;
    overflowFragments += res.overflowFragments;
    if (res.leveledUp) leveledUpCount += 1;
    if (res.reachedMax) reachedMaxCount += 1;
    if (res.slotUnlocked) slotUnlockedCount += 1;
    changed = true;
  }

  if (changed) {
    await saveAimons(env, uid, data);
  }
  if (overflowFragments > 0) {
    await env.AIMON_DB.prepare(
      "UPDATE users SET fragments = fragments + ?1, updated_at = ?2 WHERE uid = ?3"
    )
      .bind(overflowFragments, Date.now(), uid)
      .run();
  }
  return { overflowFragments, leveledUpCount, reachedMaxCount, slotUnlockedCount };
}
