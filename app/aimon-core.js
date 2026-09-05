export const RARITY_BANDS = [
  { rarity: 1, min: 0, max: 39 },
  { rarity: 2, min: 40, max: 69 },
  { rarity: 3, min: 70, max: 89 },
  { rarity: 4, min: 90, max: 99 }
];

export const STAT_SCALE = 100;

// ── 育成スロット（Phase B）・効果ラベルの表示用 ─────────────
// スロット効果の抽選は対策3によりサーバー側（functions/api/monster/preview）でのみ行う。
// ここでは保存済み効果IDの表示ラベル定義のみを保持する（抽選ロジック・重みはサーバーにのみ存在）。
export const SLOT_EFFECTS = [
  { id: "hp2", label: "HP+200", weight: 1 },
  { id: "hp1", label: "HP+100", weight: 5 },
  { id: "p1", label: "パワー+100", weight: 8 },
  { id: "s1", label: "スピード+100", weight: 8 },
  { id: "t1", label: "テクニック+100", weight: 8 },
  { id: "heal1", label: "回復量+200", weight: 5 },
  { id: "hp1p2", label: "HP-100 パワー+200", weight: 8 },
  { id: "hp1s2", label: "HP-100 スピード+200", weight: 8 },
  { id: "hp1t2", label: "HP-100 テクニック+200", weight: 8 },
  { id: "hp1ps", label: "HP-100 パワー+100 スピード+100", weight: 8 },
  { id: "hp1st", label: "HP-100 スピード+100 テクニック+100", weight: 8 },
  { id: "hp1pt", label: "HP-100 パワー+100 テクニック+100", weight: 8 },
  { id: "attrBuff", label: "属性バフ+100", weight: 9 },
  { id: "attrCancel", label: "属性デバフ軽減", weight: 8 },
];

// 旧効果IDの互換対応。
const EFFECT_ALIASES = {
  hp2ps: "hp1ps",
  hp2st: "hp1st",
  hp2pt: "hp1pt",
};

// 効果ID → 表示ラベル（カード・プレビュー表示用）。
export function slotEffectLabel(id) {
  const resolved = EFFECT_ALIASES[id] || id;
  return SLOT_EFFECTS.find((e) => e.id === resolved)?.label || "";
}

// 効果ID → ステータス変化量（HP/P/S/T）のマッピング。
// カード上の数値ハイライト用。スキル系（heal1）は数値変化が無いため空オブジェクト。
export function slotEffectDeltas(effectId) {
  const id = EFFECT_ALIASES[effectId] || effectId;
  switch (id) {
    case "hp2": return { hp: 2 * STAT_SCALE };
    case "hp1": return { hp: STAT_SCALE };
    case "p1": return { p: STAT_SCALE };
    case "s1": return { s: STAT_SCALE };
    case "t1": return { t: STAT_SCALE };
    case "heal1": return {};
    case "hp1p2": return { hp: -STAT_SCALE, p: 2 * STAT_SCALE };
    case "hp1s2": return { hp: -STAT_SCALE, s: 2 * STAT_SCALE };
    case "hp1t2": return { hp: -STAT_SCALE, t: 2 * STAT_SCALE };
    case "hp1ps": return { hp: -STAT_SCALE, p: STAT_SCALE, s: STAT_SCALE };
    case "hp1st": return { hp: -STAT_SCALE, s: STAT_SCALE, t: STAT_SCALE };
    case "hp1pt": return { hp: -STAT_SCALE, p: STAT_SCALE, t: STAT_SCALE };
    case "attrBuff":
    case "attrCancel":
      // 属性補正は aimon.baseStats との差分で決まるため、ここでは可変とする。
      // 呼び出し側で個別に判定する。
      return { dynamic: true };
    default: return {};
  }
}

// ── 育成スロット（Phase B）・クライアント表示用 ─────────────
// サーバー側（functions/api/_slots.js）と同一の3スロット正規化を保持する。
// slot0=無条件（R4のみ表示）・slot1=Lv50自動解放・slot2=巻物解放。
export function defaultSlots() {
  return [
    { text: null, effect: null, opened: true },
    { text: null, effect: null, opened: false },
    { text: null, effect: null, opened: false },
  ];
}

export function normalizeSlots(slots, rarity, level) {
  const def = defaultSlots();
  let out;
  if (Array.isArray(slots)) {
    if (slots.length === 2) {
      // 旧2枠 → 3枠移行: [旧0, 新1(Lv50枠), 旧1(巻物枠)]
      out = [slots[0] || def[0], { ...def[1] }, slots[1] || def[2]];
    } else if (slots.length === 3) {
      out = [slots[0] || def[0], slots[1] || def[1], slots[2] || def[2]];
    } else {
      out = [def[0], def[1], def[2]];
    }
  } else {
    out = [def[0], def[1], def[2]];
  }
  // Lv50到達済みなら slot1 を解放（恒久・サーバー側の自動解放と同一）。
  if ((Number(level) || 0) >= LEVEL_SLOT_UNLOCK && !out[1].opened) {
    out[1].opened = true;
  }
  return out;
}

// スロット効果の対応アイコン名を返す（FontAwesome 6 Free Solid）。
export function slotEffectStatIcons(effectId) {
  const deltas = slotEffectDeltas(effectId);
  const icons = [];
  if (deltas.hp || deltas.dynamic) icons.push("fa-heart");
  if (deltas.p || deltas.dynamic) icons.push("fa-hand-fist");
  if (deltas.s || deltas.dynamic) icons.push("fa-hand-peace");
  if (deltas.t || deltas.dynamic) icons.push("fa-hand-paper");
  return icons;
}

// ── 育成レベル（Phase B）・クライアント表示用 ─────────────────
// サーバー側（functions/api/_level.js）と同じ定数・正規化を保持する。
// レベルは0〜99（レベル0から始まる）。XP はレベル内の残量（0〜XP_PER_LEVEL-1）。
// レベルアップは XP_PER_LEVEL ごとに +1。願いの洞窟でレベル5を消費して0になっても正規の値。
export const XP_PER_LEVEL = 10;
export const MAX_LEVEL = 99;
export const WISH_XP = 100;
export const DRAW_LEVEL_COST = 5;
export const LEVEL_SLOT_UNLOCK = 50;

// 特殊メイモン（ユニーク・隠し）は aimon.xpPerLevel / aimon.drawLevelCost で通常値を上書きする（サーバー _level.js と同一）。
export function getXpPerLevel(aimon) {
  const v = Number(aimon?.xpPerLevel);
  return Number.isFinite(v) && v > 0 ? v : XP_PER_LEVEL;
}

export function getDrawLevelCost(aimon) {
  const v = Number(aimon?.drawLevelCost);
  return Number.isFinite(v) && v > 0 ? v : DRAW_LEVEL_COST;
}

// 表示用にレベル/XP/masterpiece を正規化する（サーバー normalizeTraining と同一）。
export function normalizeTraining(aimon) {
  const xpPerLevel = getXpPerLevel(aimon);
  const level = Math.min(Math.max(Number(aimon?.level) || 0, 0), MAX_LEVEL);
  const xp = (Number(aimon?.xp) || 0) % xpPerLevel;
  const masterpiece = level >= MAX_LEVEL || !!aimon?.masterpiece;
  return { level, xp, masterpiece };
}

// 獲得XPを加えた場合の表示用プレビュー（バトル後のレベルアップ演出用・非同期なし）。
// 戻り値: { level, xp, leveledUp, overflow }
export function applyXpPreview(aimon, xp) {
  const xpPerLevel = getXpPerLevel(aimon);
  let { level, xp: curXp } = normalizeTraining(aimon);
  curXp += Math.max(0, Math.floor(xp) || 0);
  let leveledUp = false;
  while (curXp >= xpPerLevel && level < MAX_LEVEL) {
    curXp -= xpPerLevel;
    level += 1;
    leveledUp = true;
  }
  let overflow = 0;
  if (curXp >= xpPerLevel) {
    overflow = Math.floor(curXp / xpPerLevel);
    curXp = curXp % xpPerLevel;
  }
  return { level, xp: curXp, leveledUp, overflow };
}

// 累計XP（レベル全体で獲得したXPの合計）: level*xpPerLevel + xp（レベル0スタート基準）
// 編成画面のミニカードやXP演出の最終結果で使用する。
export function totalXp(aimon) {
  const { level, xp } = normalizeTraining(aimon);
  return level * getXpPerLevel(aimon) + xp;
}

// ── スキル表示テーブル ───────────────────────────────────────
// スキル抽選は対策1によりサーバー側（functions/api/monster/generate）でのみ行う。
// ここでは表示用のラベル・構文のみを保持する（抽選テーブルはサーバーにのみ存在）。
export const SKILL_TYPES = ["damage", "loseToWin", "heal", "guard"];

const SKILL_LOCAL_LABELS = {
  damage: "会心の一撃",
  loseToWin: "負けるが勝ち",
  heal: "再生",
  guard: "守りの構え"
};

// damage/heal/guard の効果量(2〜4)に対応する強さの副詞。
const EFFECT_MODIFIER_WORDS = {
  2: "少し", 3: "大きく", 4: "かなり大きく",
  200: "少し", 300: "大きく", 400: "かなり大きく"
};
// スキルタイプ×効果量ごとに固定された「効果の構文」。表現は確定済みなので変更しない。
export function effectSentence(type, value) {
  switch (type) {
    case "damage":
      return `このターン相手に与えるダメージが${EFFECT_MODIFIER_WORDS[value] || ""}上昇する。`;
    case "heal":
      return `自身のHPを${EFFECT_MODIFIER_WORDS[value] || ""}回復する。`;
    case "guard":
      return `このターン相手から受けるダメージを${EFFECT_MODIFIER_WORDS[value] || ""}軽減する。`;
    case "loseToWin":
      return "このターンのみ、ハンドの相性が逆転する。";
    default:
      return "";
  }
}

// AI生成のフレーバーテキストが未取得/失敗した場合のフォールバック表示。
// 「フレーバー1（説明）＋効果の構文（固定）＋フレーバー2（世界観の匂わせ）」の3部構成。
export function localSkillFlavor(skill) {
  const name = SKILL_LOCAL_LABELS[skill.type] || "スキル";
  const effect = effectSentence(skill.type, skill.value);
  const flavor1 = "秘めた力を静かに解き放つ。";
  const flavor2 = "その力の源は、まだ誰も知らないのかもしれない。";
  return { name, effect, flavor1, flavor2 };
}

// ── 世界観データ（四界・国家/地域・属性） ──────────────────────
// world_detaild（02_実装資料・アプリ）の設定に基づく種族・地域テーブル。
// ハッシュ値から「種族」→「地域（出身国）」→「属性（地域の候補から抽選）」の順で決定し、
// 画像生成プロンプト・スキルのフレーバー生成に利用する文脈情報として持たせる。

const ELEMENT_INFO = {
  "炎": { en: "fire element, glowing orange-red flame motifs" },
  "水": { en: "water element, flowing blue aqua motifs" },
  "氷": { en: "ice element, crystalline pale-blue frost motifs" },
  "風": { en: "wind element, swirling cyan breeze motifs" },
  "草": { en: "nature element, verdant green leaf motifs" },
  "岩": { en: "earth element, rugged brown stone motifs" },
  "光": { en: "holy light element, radiant golden glow motifs" },
  "闇": { en: "shadow element, deep violet-black aura motifs" }
};

// 四界の種族（自然界・文明界・幻界・魔界）。rare:true は各界に1体だけ存在するレア種族
// （出現率のみ低い。ステータス/レアリティ（PST・スキル）とは完全に独立した別軸）。
export const WORLD_SPECIES = [
  { id: "ryu", ja: "リュウ", realm: "自然界", en: "a noble dragon-kin, scaled body, small horns, regal draconic aura" },
  { id: "suisei", ja: "水棲", realm: "自然界", en: "an aquatic beastfolk, sleek fins and gills, glistening scales" },
  { id: "kemono", ja: "けもの", realm: "自然界", en: "a beastfolk with animal ears and tail, fur-covered, tribal ornaments" },
  { id: "tsubasa", ja: "つばさ", realm: "自然界", en: "a small winged-folk, feathered wings, delicate avian features" },
  { id: "dragoon", ja: "ドラグーン", realm: "自然界", rare: true, en: "a humanoid dragoon, half-dragon diplomat in ornate ceremonial armor, small dragon horns and tail" },
  { id: "yuusha", ja: "ゆうしゃ", realm: "文明界", en: "a young hero-kin in polished armor, determined bright eyes" },
  { id: "ningyou", ja: "人形", realm: "文明界", en: "a magical living puppet doll, porcelain joints, stitched seams, glowing runes" },
  { id: "machine", ja: "マシーン", realm: "文明界", en: "a small steampunk clockwork machine, brass gears, glowing core" },
  { id: "wizard", ja: "ウィザード", realm: "文明界", en: "a robed wizard-kin, pointed hat, floating arcane runes" },
  { id: "ark-golem", ja: "アーク・ゴーレム", realm: "文明界", rare: true, en: "an ancient archive golem, carved stone body inscribed with glowing hash-code runes, guardian of forgotten records" },
  { id: "genjuu", ja: "幻獣", realm: "幻界", en: "a mythical spirit beast, translucent glowing fur, ethereal aura" },
  { id: "yousei", ja: "妖精", realm: "幻界", en: "a tiny fairy-kin, gossamer wings, glittering dust trail" },
  { id: "tenshi", ja: "てんし", realm: "幻界", en: "a small angelic being, soft halo, feathered white wings" },
  { id: "ghost", ja: "ゴースト", realm: "幻界", en: "a playful ghost spirit, semi-transparent wisp body, wavy trailing form" },
  { id: "mystic", ja: "ミスティック", realm: "幻界", rare: true, en: "a hooded mystic spirit, veiled face, arcane sigils floating around" },
  { id: "maou", ja: "まおう", realm: "魔界", en: "a regal demon lord-kin, small ornate horns, dark royal cape" },
  { id: "mazoku", ja: "魔族", realm: "魔界", en: "a proud demonkin, sharp horns, elegant dark armor" },
  { id: "youkai", ja: "ヨウカイ", realm: "魔界", en: "a mischievous yokai spirit, traditional Japanese motifs, playful mask" },
  { id: "kyojin", ja: "きょじん", realm: "魔界", en: "a small stout giant-kin, sturdy build, stone-carved ornaments" },
  { id: "ancestor-demon", ja: "始祖鬼", realm: "魔界", rare: true, en: "an ancient primordial demon ancestor, weathered dark horns, faded royal regalia predating the twelve demon lords" }
];

// 四大主権国＋辺境の国々の地域一覧。elements は各地域で抽選対象となる属性候補。
// realm: 四界のいずれかに属する地域は種族もその界に固定される。"outsider" は辺境の国々＝
// アウトサイダー・ドメインで、種族は四界どこからでも均等に抽選される（多様性の坩堝）。
export const WORLD_REGIONS = [
  { id: "yggdrasil-cradle", ja: "世界樹の揺り籠", nationJa: "神樹と巨竜の連邦：ギルガ・ナチュラ", realm: "自然界", elements: ["草", "風"], en: "atop a colossal world tree canopy, floating nests, lush green light filtering through leaves" },
  { id: "dragon-volcano", ja: "竜帝の逆鱗火山", nationJa: "神樹と巨竜の連邦：ギルガ・ナチュラ", realm: "自然界", elements: ["炎", "岩"], en: "a jet-black volcanic mountain range, flowing lava rivers, jagged obsidian rock" },
  { id: "thousand-falls", ja: "千の瀑布と大密林", nationJa: "神樹と巨竜の連邦：ギルガ・ナチュラ", realm: "自然界", elements: ["水", "草"], en: "a labyrinthine tropical jungle with countless waterfalls, misty emerald foliage" },
  { id: "grand-library", ja: "大魔導図書館都市", nationJa: "蒸気と魔導の帝国：アルカニア・メテオラ", realm: "文明界", elements: ["光", "氷"], en: "a grand marble library city of eternal ice crystal, glowing arcane light" },
  { id: "scrap-valley", ja: "鉄鋼のスクラップ・バレー", nationJa: "蒸気と魔導の帝国：アルカニア・メテオラ", realm: "文明界", elements: ["岩", "水"], en: "a dark rain-soaked scrapyard canyon, rusted machinery, murky steam" },
  { id: "grand-arena", ja: "王都グランド・アリーナ", nationJa: "蒸気と魔導の帝国：アルカニア・メテオラ", realm: "文明界", elements: ["光"], en: "a golden royal arena, silver armor and radiant banners" },
  { id: "eternal-glacier", ja: "星屑と結晶の永久氷河", nationJa: "泡沫 of 常冬郷：ファンタズマ・エルフェン", realm: "幻界", elements: ["氷", "光"], en: "an eternal glacier plain glittering with star-dust crystals, diamond dust in the air" },
  { id: "twilight-mist", ja: "トワイライト・ミスト", nationJa: "泡沫 of 常冬郷：ファンタズマ・エルフェン", realm: "幻界", elements: ["風", "闇"], en: "a misty twilight forest bathed in pink and purple fog, glowing bioluminescent plants" },
  { id: "sky-eden", ja: "天空の浮島：エデン", nationJa: "泡沫 of 常冬郷：ファンタズマ・エルフェン", realm: "幻界", elements: ["光", "風"], en: "a floating sky island with Greek-temple ruins, clear springs, drifting clouds" },
  { id: "black-iron-castle", ja: "深淵の黒鉄城", nationJa: "常闇の冥帝国：ゲヘナ・ヴォルテクス", realm: "魔界", elements: ["闇", "炎"], en: "an ominous black iron castle wreathed in dark flame, jagged obsidian towers" },
  { id: "hyakki-street", ja: "百鬼夜行の逢魔街", nationJa: "常闇の冥帝国：ゲヘナ・ヴォルテクス", realm: "魔界", elements: ["闇", "風"], en: "an old Japanese night street lit by eerie lanterns, drifting spirit mist" },
  { id: "giants-valley", ja: "巨人の嘆き谷", nationJa: "常闇の冥帝国：ゲヘナ・ヴォルテクス", realm: "魔界", elements: ["岩", "氷"], en: "a vast frozen canyon carved by ancient giants, echoing icy winds" },
  { id: "sweets-desert", ja: "スイーツ大砂漠", nationJa: "大おもちゃ箱共和国：トイ・パッパ", realm: "outsider", elements: ["草", "炎", "氷"], en: "a whimsical candy desert of sugar dunes and cookie rocks, pastel colors" },
  { id: "toy-railway", ja: "ドタバタ大鉄道ループ", nationJa: "大おもちゃ箱共和国：トイ・パッパ", realm: "outsider", elements: ["風"], en: "a colorful toy city with looping roller-coaster train tracks" },
  { id: "sacred-peak", ja: "万物注連縄の霊峰", nationJa: "八百万の神州：日出処", realm: "outsider", elements: ["岩", "光", "風"], en: "a sacred misty mountain wrapped in a giant sacred rope, ink-wash clouds" },
  { id: "lantern-town", ja: "からくり提灯街", nationJa: "八百万の神州：日出処", realm: "outsider", elements: ["水", "闇", "炎"], en: "a nostalgic Japanese night town lined with willows and lanterns along a river" },
  { id: "neon-slum", ja: "スラム・ネオン迷宮", nationJa: "無国籍浮遊都市：ネオ・バビロン", realm: "outsider", elements: ["闇", "光"], en: "a cyberpunk neon-lit back alley slum, holographic signs, endless night" },
  { id: "junk-deep", ja: "忘却のジャンク・ディープ", nationJa: "無国籍浮遊都市：ネオ・バビロン", realm: "outsider", elements: ["岩", "氷"], en: "a forgotten underground junk depths, cold mist and heat vents" }
];

// 90年代ジャパニメーション風のダイナミックなカメラワーク・構図候補。
// 画像生成プロンプトの構図指定に使う（ハッシュから抽選し、アイモンごとに個性を出す）。
export const CAMERA_ANGLES = [
  { id: "low-angle-hero", en: "dramatic low-angle hero shot looking up at the creature, exaggerated perspective" },
  { id: "dutch-angle", en: "dynamic Dutch angle (tilted frame), diagonal composition, high tension" },
  { id: "action-closeup", en: "dynamic close-up action shot with motion lines and speed lines, mid-attack pose" },
  { id: "wide-establishing", en: "cinematic wide establishing shot, the creature small against a vast dramatic backdrop" },
  { id: "over-the-shoulder", en: "over-the-shoulder power stance shot, foreground silhouette framing the creature" },
  { id: "impact-frame", en: "explosive impact freeze-frame moment, energy shockwave radiating outward, dramatic foreshortening" },
  { id: "silhouette-burst", en: "backlit silhouette pose against a radiant burst of elemental energy" },
  { id: "upward-heroic", en: "upward heroic angle, wind-blown cape and hair, sky and clouds swirling behind" }
];

export function choicePower(monster, choice) {
  if (choice === "P") return monster.p;
  if (choice === "S") return monster.s;
  if (choice === "T") return monster.t;
  throw new Error(`未知の選択: ${choice}`);
}

export function compareChoices(a, b) {
  if (a === b) return 0;
  if (
    (a === "P" && b === "S") ||
    (a === "S" && b === "T") ||
    (a === "T" && b === "P")
  ) {
    return 1;
  }
  return -1;
}

// options.aUseSkill / options.bUseSkill: そのターンにスキルを発動するか（未使用スキルがある場合のみ有効）。
export function resolveBattleTurn(state, aChoice, bChoice, options = {}) {
  const aSkill = options.aUseSkill && state.a.skill && !state.a.skill.used ? state.a.skill : null;
  const bSkill = options.bUseSkill && state.b.skill && !state.b.skill.used ? state.b.skill : null;

  let relation = compareChoices(aChoice, bChoice);
  let aStat = choicePower(state.a, aChoice);
  let bStat = choicePower(state.b, bChoice);

  // damage: 自分の攻撃力に+valueして今ターンの計算に使う。
  // 注意: このボーナスは「自分が勝利する/あいこになる」場合のみダメージに反映される。
  // 負けた場合はそもそも相手にダメージを与えないため、ボーナスは不発になる（仕様通り）。
  if (aSkill?.type === "damage") aStat += aSkill.value;
  if (bSkill?.type === "damage") bStat += bSkill.value;

  const aLoseToWin = aSkill?.type === "loseToWin";
  const bLoseToWin = bSkill?.type === "loseToWin";
  // 負けるが勝ち: いずれかが発動していれば今ターンの相性を逆転する。
  // 同時発動しても重複しない（逆の逆にはならない）。
  const invertRelation = aLoseToWin || bLoseToWin;

  let damageToA = 0;
  let damageToB = 0;
  let resultLabel;
  // damage skill のボーナスが実際にダメージへ反映されたか（不発判定に使用）。
  let aDamageBonusApplied = false;
  let bDamageBonusApplied = false;

  // 相性の逆転（負けるが勝ち）。あいこは反転してもあいこのまま。
  if (invertRelation && relation !== 0) {
    relation = -relation;
  }

  if (relation > 0) {
    damageToB = aStat;
    resultLabel = "a-win";
    if (aSkill?.type === "damage") aDamageBonusApplied = true;
  } else if (relation < 0) {
    damageToA = bStat;
    resultLabel = "b-win";
    if (bSkill?.type === "damage") bDamageBonusApplied = true;
  } else {
    // あいこ（relation === 0）はお互いに自分の手の威力の半分（切り捨て・最低1）を受ける。
    damageToB = Math.max(STAT_SCALE, Math.floor(aStat / 2));
    damageToA = Math.max(STAT_SCALE, Math.floor(bStat / 2));
    resultLabel = "draw";
    if (aSkill?.type === "damage") aDamageBonusApplied = true;
    if (bSkill?.type === "damage") bDamageBonusApplied = true;
  }

  // guard: 被ダメージを軽減（最低0）。実際に軽減できた量を記録。
  let aGuardReduced = 0;
  let bGuardReduced = 0;
  if (aSkill?.type === "guard") {
    const before = damageToA;
    damageToA = Math.max(0, damageToA - aSkill.value);
    aGuardReduced = before - damageToA;
  }
  if (bSkill?.type === "guard") {
    const before = damageToB;
    damageToB = Math.max(0, damageToB - bSkill.value);
    bGuardReduced = before - damageToB;
  }

  // heal/バフは「ハンドを出す前」に確定している効果という設計のため、
  // 回復はダメージ判定前の現在HPに対して適用し、その後にダメージを引く。
  // （HPが満タンなら回復は不発になり、以降のダメージ計算にも影響しない。）
  let aHealApplied = 0;
  let bHealApplied = 0;
  let aHpBeforeDamage = state.aCurrentHp;
  let bHpBeforeDamage = state.bCurrentHp;
  if (aSkill?.type === "heal") {
    const healedHp = Math.min(state.a.hp, aHpBeforeDamage + aSkill.value);
    aHealApplied = healedHp - aHpBeforeDamage;
    aHpBeforeDamage = healedHp;
  }
  if (bSkill?.type === "heal") {
    const healedHp = Math.min(state.b.hp, bHpBeforeDamage + bSkill.value);
    bHealApplied = healedHp - bHpBeforeDamage;
    bHpBeforeDamage = healedHp;
  }

  let nextAHP = Math.max(0, aHpBeforeDamage - damageToA);
  let nextBHP = Math.max(0, bHpBeforeDamage - damageToB);

  const finished = nextAHP <= 0 || nextBHP <= 0;
  const drawKO = finished && nextAHP <= 0 && nextBHP <= 0;

  // スキルの種類ごとに「実際に効果が発揮されたか」「その効果量」をまとめる。
  // UI側はこれを見るだけで結果メッセージを組み立てられる（判定ロジックの二重実装を避ける）。
  function buildEffect(skill, bonusApplied, guardReduced, healApplied) {
    if (!skill) return null;
    switch (skill.type) {
      case "damage":
        return { type: "damage", applied: bonusApplied, amount: bonusApplied ? skill.value : 0 };
      case "guard":
        return { type: "guard", applied: guardReduced > 0, amount: guardReduced };
      case "heal":
        return { type: "heal", applied: healApplied > 0, amount: healApplied };
      case "loseToWin":
        // 相性逆転はあいこ以外なら効果発揮（勝敗が反転）。あいこは不発。
        return { type: "loseToWin", applied: !!invertRelation && relation !== 0, amount: 0 };
      default:
        return null;
    }
  }
  const aSkillEffect = buildEffect(aSkill, aDamageBonusApplied, aGuardReduced, aHealApplied);
  const bSkillEffect = buildEffect(bSkill, bDamageBonusApplied, bGuardReduced, bHealApplied);

  return {
    relation,
    resultLabel,
    aChoice,
    bChoice,
    aStat,
    bStat,
    damageToA,
    damageToB,
    nextAHP,
    nextBHP,
    finished,
    drawKO,
    aSkillUsed: !!aSkill,
    bSkillUsed: !!bSkill,
    aSkillEffect,
    bSkillEffect
  };
}
