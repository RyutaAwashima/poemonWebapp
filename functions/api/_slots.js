// functions/api/_slots.js
// 育成スロット（Phase B）の共通定義。効果テーブル・ハッシュ抽選・ステータス適用。
// 決定論的ハッシュ SHA-256(monsterId + ":" + text) の重み付き抽選で効果を決める。
// アイモン1体につき結果は1つ（スロットは登録先を選ぶだけなのでハッシュには含めない）。
// クライアント側（app/aimon-core.js）にも同一テーブルと抽選ロジックを保持する（願いの洞窟のプレビュー用）。

import { STAT_SCALE } from "./_stat-scale.js";

// 強化効果テーブル（15種）。weight は出現率（合計100）。
// attrCancel は属性デバフを「-1→0 / -2→-1」と1段階軽減する（闇属性に効きすぎない調整）。
export const SLOT_EFFECTS = [
  { id: "hp2", weight: 1 },       // HP+2（最高レア）
  { id: "hp1", weight: 5 },       // HP+1
  { id: "p1", weight: 8 },        // パワー+1
  { id: "s1", weight: 8 },        // スピード+1
  { id: "t1", weight: 8 },        // テクニック+1
  { id: "heal1", weight: 5 },     // 回復量+2（スキル heal のみ有効）
  { id: "hp1p2", weight: 8 },     // HP-1, パワー+2
  { id: "hp1s2", weight: 8 },     // HP-1, スピード+2
  { id: "hp1t2", weight: 8 },     // HP-1, テクニック+2
  { id: "hp1ps", weight: 8 },     // HP-1, パワー+1, スピード+1
  { id: "hp1st", weight: 8 },     // HP-1, スピード+1, テクニック+1
  { id: "hp1pt", weight: 8 },     // HP-1, パワー+1, テクニック+1
  { id: "attrBuff", weight: 9 },  // 属性効果のバフ+1
  { id: "attrCancel", weight: 8 } // 属性デバフ軽減（-1→0 / -2→-1）
];

// 旧効果IDの互換対応（2026-08-13 リバランス前に登録されたスロットも表示・効果適用できるよう）。
const EFFECT_ALIASES = {
  hp2ps: "hp1ps",
  hp2st: "hp1st",
  hp2pt: "hp1pt",
};

export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ハッシュのバイト列から重み付き抽選で効果を決定する（決定論的）。
export function rollEffect(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  const total = SLOT_EFFECTS.reduce((s, e) => s + e.weight, 0);
  const value = (bytes[0] || 0) * 256 + (bytes[1] || 0);
  const r = value % total;
  let acc = 0;
  for (const e of SLOT_EFFECTS) {
    acc += e.weight;
    if (r < acc) return e.id;
  }
  return SLOT_EFFECTS[SLOT_EFFECTS.length - 1].id;
}

// スロット解放レベル（レベル50以上に初めて到達した時にスロット2（index1）を解放する）。
// サーバー側の正規定義。クライアント（app/aimon-core.js）にも同一の定数を持つ。
export const LEVEL_SLOT_UNLOCK = 50;

// スロット初期化（aimon に slots が無い場合の補完・normalize で使用）。
// 3スロット構成（2026-08-12 新仕様・確定）:
//   slot0(スロット1)=無条件解放（レア4のみ表示・レア1〜3は非表示）
//   slot1(スロット2)=レベル50で解放（LEVEL_SLOT_UNLOCK）
//   slot2(スロット3)=伝承の巻物で解放
// レア4も slot1・slot2 は同じ解放条件。
export function defaultSlots(rarity) {
  return [
    { text: null, effect: null, opened: true },
    { text: null, effect: null, opened: false },
    { text: null, effect: null, opened: false },
  ];
}

// スロット配列を補完する（旧データ・slots なし・null 要素混在のアイモン対策）。
// 常に3要素の配列を返す。旧2枠データは「巻物=スロット3」の意味を保つため
// 旧 slots[1] の内容を new slots[2] へ移動する（slot0・slot1 は新規枠扱い）。
// level が LEVEL_SLOT_UNLOCK 以上なら slot1 を解放済みにする（レベル50解放・恒久）。
export function normalizeSlots(slots, rarity, level) {
  const def = defaultSlots(rarity);
  let out;
  if (Array.isArray(slots)) {
    if (slots.length === 2) {
      // 旧2枠 → 3枠移行: [旧0, 新1(レベル50枠), 旧1(巻物枠)]
      out = [slots[0] || def[0], { ...def[1] }, slots[1] || def[2]];
    } else if (slots.length === 3) {
      out = [slots[0] || def[0], slots[1] || def[1], slots[2] || def[2]];
    } else {
      out = [def[0], def[1], def[2]];
    }
  } else {
    out = [def[0], def[1], def[2]];
  }
  // レベル50到達済みなら slot1 を解放（恒久・レベルが下がっても維持）。
  // slots が無い未訓練モンスターでも、レベル50以上なら必ず解放する。
  if ((Number(level) || 0) >= LEVEL_SLOT_UNLOCK && !out[1].opened) {
    out[1].opened = true;
  }
  return out;
}

// effect を aimon の素のステータス（属性補正込み）へ適用した結果を返す（normalize で使用）。
// 属性補正分（hp/p/s/t - baseStats）を参照する属性系効果もここで扱う。
// aimon の hp/p/s/t を上書きし、skill.value も更新する。baseStats は素のまま（差分表示用）。
export function applyEffects(aimon) {
  const base = aimon.baseStats || { hp: aimon.hp, p: aimon.p, s: aimon.s, t: aimon.t };
  const stats = { hp: aimon.hp, p: aimon.p, s: aimon.s, t: aimon.t };
  // 属性補正分（生成時の applyElementModifier による増減。差分で再現）。
  const delta = {
    hp: stats.hp - (base.hp ?? stats.hp),
    p: stats.p - (base.p ?? stats.p),
    s: stats.s - (base.s ?? stats.s),
    t: stats.t - (base.t ?? stats.t),
  };
  let skillValueBoost = 0;
  const skill = aimon.skill;

  const slots = aimon.slots || [];
  for (const slot of slots) {
    if (!slot?.opened || !slot?.effect) continue;
    const effectId = EFFECT_ALIASES[slot.effect] || slot.effect;
    switch (effectId) {
      case "hp2": stats.hp += 2 * STAT_SCALE; break;
      case "hp1": stats.hp += STAT_SCALE; break;
      case "p1": stats.p += STAT_SCALE; break;
      case "s1": stats.s += STAT_SCALE; break;
      case "t1": stats.t += STAT_SCALE; break;
      case "heal1": if (skill?.type === "heal") skillValueBoost += 2 * STAT_SCALE; break;
      case "hp1p2": stats.hp -= STAT_SCALE; stats.p += 2 * STAT_SCALE; break;
      case "hp1s2": stats.hp -= STAT_SCALE; stats.s += 2 * STAT_SCALE; break;
      case "hp1t2": stats.hp -= STAT_SCALE; stats.t += 2 * STAT_SCALE; break;
      case "hp1ps": stats.hp -= STAT_SCALE; stats.p += STAT_SCALE; stats.s += STAT_SCALE; break;
      case "hp1st": stats.hp -= STAT_SCALE; stats.s += STAT_SCALE; stats.t += STAT_SCALE; break;
      case "hp1pt": stats.hp -= STAT_SCALE; stats.p += STAT_SCALE; stats.t += STAT_SCALE; break;
      case "attrBuff":
        // 属性補正でプラスされたステータスをさらに+1。
        if (delta.hp > 0) stats.hp += STAT_SCALE;
        if (delta.p > 0) stats.p += STAT_SCALE;
        if (delta.s > 0) stats.s += STAT_SCALE;
        if (delta.t > 0) stats.t += STAT_SCALE;
        break;
      case "attrCancel":
        // 属性デバフを1段階軽減（-1→0・-2→-1）。マイナスがあるステータスを+1。
        if (delta.hp < 0) stats.hp += STAT_SCALE;
        if (delta.p < 0) stats.p += STAT_SCALE;
        if (delta.s < 0) stats.s += STAT_SCALE;
        if (delta.t < 0) stats.t += STAT_SCALE;
        break;
    }
  }

  aimon.hp = Math.max(STAT_SCALE, stats.hp);
  aimon.p = Math.max(STAT_SCALE, stats.p);
  aimon.s = Math.max(STAT_SCALE, stats.s);
  aimon.t = Math.max(STAT_SCALE, stats.t);
  aimon.total = aimon.hp + aimon.p + aimon.s + aimon.t;
  if (skillValueBoost > 0 && skill) {
    skill.value = (skill.value ?? 0) + skillValueBoost;
  }
  return aimon;
}
