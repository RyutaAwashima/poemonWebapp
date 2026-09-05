// functions/api/_monster-gen.js
// アイモン生成（名前→決定論的なレアリティ・ステータス・スキル・世界観）のサーバー側実装。
// app/aimon-core.js の generateMonster と同一ロジック（逐語移植）。クライアント側の
// 生成関数は不正なデータ（レアリティ・ステータス偽装）を防ぐためサーバーへ集約した。
// 決定論は絶対に変更しないこと（既存モンスター・フィード再表示・画像IDと整合する）。
//
// 移植元: app/aimon-core.js（generateMonster とその依存関数・テーブル）。
// 検証: scripts/verify-gen-port.mjs で 旧クライアント実装 と 本モジュール の出力一致を確認済み。

import { checkMonsterNameServer, NAME_REJECT_MESSAGES } from "./_name-check.js";
import { STAT_SCALE } from "./_stat-scale.js";

const PST_TEMPLATE = {
  combinations: [
    { rarity: 1, hp: 5, pst: [[3, 2, 1], [3, 1, 2], [2, 3, 1], [2, 1, 3], [1, 3, 2], [1, 2, 3], [2, 2, 2]] },
    { rarity: 1, hp: 6, pst: [[2, 2, 1], [2, 1, 2], [1, 2, 2]] },
    { rarity: 2, hp: 5, pst: [[4, 2, 1], [4, 1, 2], [2, 4, 1], [2, 1, 4], [1, 4, 2], [1, 2, 4], [3, 3, 1], [3, 1, 3], [1, 3, 3], [3, 2, 2], [2, 3, 2], [2, 2, 3]] },
    { rarity: 2, hp: 6, pst: [[3, 2, 1], [3, 1, 2], [2, 3, 1], [2, 1, 3], [1, 3, 2], [1, 2, 3], [2, 2, 2]] },
    { rarity: 2, hp: 7, pst: [[2, 2, 1], [2, 1, 2], [1, 2, 2]] },
    { rarity: 3, hp: 5, pst: [[5, 2, 1], [5, 1, 2], [2, 5, 1], [2, 1, 5], [1, 5, 2], [1, 2, 5], [4, 3, 1], [4, 1, 3], [3, 4, 1], [3, 1, 4], [1, 4, 3], [1, 3, 4], [4, 2, 2], [2, 4, 2], [2, 2, 4], [3, 3, 2], [3, 2, 3], [2, 3, 3]] },
    { rarity: 3, hp: 6, pst: [[4, 2, 1], [4, 1, 2], [2, 4, 1], [2, 1, 4], [1, 4, 2], [1, 2, 4], [3, 3, 1], [3, 1, 3], [1, 3, 3], [3, 2, 2], [2, 3, 2], [2, 2, 3]] },
    { rarity: 3, hp: 7, pst: [[3, 2, 1], [3, 1, 2], [2, 3, 1], [2, 1, 3], [1, 3, 2], [1, 2, 3], [2, 2, 2]] },
    { rarity: 3, hp: 8, pst: [[2, 2, 1], [2, 1, 2], [1, 2, 2]] },
    { rarity: 4, hp: 5, pst: [[5, 3, 1], [5, 1, 3], [3, 5, 1], [3, 1, 5], [1, 5, 3], [1, 3, 5], [5, 2, 2], [2, 5, 2], [2, 2, 5], [4, 4, 1], [4, 1, 4], [1, 4, 4], [4, 3, 2], [4, 2, 3], [3, 4, 2], [3, 2, 4], [2, 4, 3], [2, 3, 4], [3, 3, 3]] },
    { rarity: 4, hp: 6, pst: [[5, 2, 1], [5, 1, 2], [2, 5, 1], [2, 1, 5], [1, 5, 2], [1, 2, 5], [4, 3, 1], [4, 1, 3], [3, 4, 1], [3, 1, 4], [1, 4, 3], [1, 3, 4], [4, 2, 2], [2, 4, 2], [2, 2, 4], [3, 3, 2], [3, 2, 3], [2, 3, 3]] },
    { rarity: 4, hp: 7, pst: [[4, 2, 1], [4, 1, 2], [2, 4, 1], [2, 1, 4], [1, 4, 2], [1, 2, 4], [3, 3, 1], [3, 1, 3], [1, 3, 3], [3, 2, 2], [2, 3, 2], [2, 2, 3]] },
    { rarity: 4, hp: 8, pst: [[3, 2, 1], [3, 1, 2], [2, 3, 1], [2, 1, 3], [1, 3, 2], [1, 2, 3], [2, 2, 2]] }
  ]
};

export const RARITY_BANDS = [
  { rarity: 1, min: 0, max: 39 },
  { rarity: 2, min: 40, max: 69 },
  { rarity: 3, min: 70, max: 89 },
  { rarity: 4, min: 90, max: 99 }
];

const RARITY_POOLS = buildRarityPools(PST_TEMPLATE);

function buildRarityPools(template) {
  const pools = { 1: [], 2: [], 3: [], 4: [] };
  for (const combo of template.combinations) {
    for (const stat of combo.pst) {
      pools[combo.rarity].push({
        rarity: combo.rarity,
        hp: combo.hp,
        p: stat[0],
        s: stat[1],
        t: stat[2]
      });
    }
  }
  return pools;
}

export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── スキル抽選テーブル ──────────────────────────────────────
// レアリティ(1〜4)が高いほど強力なスキル種別・数値を抽選しやすくする。
export const SKILL_TYPES = ["damage", "loseToWin", "heal", "guard"];

// カテゴリ抽選の重み（数値が大きいほど当たりやすい）。
const SKILL_CATEGORY_WEIGHTS = {
  1: [["damage", 40], ["loseToWin", 5], ["heal", 30], ["guard", 25]],
  2: [["damage", 35], ["loseToWin", 10], ["heal", 30], ["guard", 25]],
  3: [["damage", 30], ["loseToWin", 20], ["heal", 25], ["guard", 25]],
  4: [["damage", 25], ["loseToWin", 30], ["heal", 20], ["guard", 25]]
};

// damage / heal / guard 共通の数値（2〜4）抽選重み。
const TIER_VALUE_WEIGHTS = {
  1: [[2, 70], [3, 25], [4, 5]],
  2: [[2, 55], [3, 35], [4, 10]],
  3: [[2, 35], [3, 45], [4, 20]],
  4: [[2, 20], [3, 40], [4, 40]]
};

const SKILL_LOCAL_LABELS = {
  damage: "会心の一撃",
  loseToWin: "負けるが勝ち",
  heal: "再生",
  guard: "守りの構え"
};

// damage/heal/guard の効果量(2〜4)に対応する強さの副詞。
const EFFECT_MODIFIER_WORDS = { 2: "少し", 3: "大きく", 4: "かなり大きく" };
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

// 界ごとの通常種族／レア種族の抽選重み。レア種族は界内で約5%の出現率。
const REALM_SPECIES_WEIGHTS = ["自然界", "文明界", "幻界", "魔界"].reduce((acc, realm) => {
  const members = WORLD_SPECIES.filter((s) => s.realm === realm);
  const common = members.filter((s) => !s.rare);
  const rare = members.filter((s) => s.rare);
  const commonWeights = common.map((s, i) => [s, i < 2 ? 24 : 23]); // 24+24+23+23=94
  const rareWeights = rare.map((s) => [s, 6]); // 約5〜6%（今は界ごとに1体のみ）
  acc[realm] = [...commonWeights, ...rareWeights];
  return acc;
}, {});

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

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

async function createByteStream(seed) {
  let blockHex = await sha256Hex(seed);
  let bytes = hexToBytes(blockHex);
  let idx = 0;

  return {
    hashHex: blockHex,
    async nextByte() {
      if (idx >= bytes.length) {
        blockHex = await sha256Hex(blockHex);
        bytes = hexToBytes(blockHex);
        idx = 0;
      }
      const value = bytes[idx];
      idx += 1;
      return value;
    }
  };
}

async function uniformInt(stream, maxExclusive) {
  if (maxExclusive <= 0 || maxExclusive > 256) {
    throw new Error("uniformInt supports 1..256");
  }
  const bucket = Math.floor(256 / maxExclusive) * maxExclusive;
  while (true) {
    const b = await stream.nextByte();
    if (b < bucket) return b % maxExclusive;
  }
}

async function rarityRoll(stream) {
  const value = await uniformInt(stream, 100);
  const band = RARITY_BANDS.find((b) => value >= b.min && value <= b.max);
  return { rarity: band.rarity, roll: value };
}

async function weightedRoll(stream, weightEntries) {
  const total = weightEntries.reduce((sum, [, w]) => sum + w, 0);
  const roll = await uniformInt(stream, total);
  let acc = 0;
  for (const [key, weight] of weightEntries) {
    acc += weight;
    if (roll < acc) return key;
  }
  return weightEntries[weightEntries.length - 1][0];
}

async function rollSkill(stream, rarity) {
  const type = await weightedRoll(stream, SKILL_CATEGORY_WEIGHTS[rarity]);
  // loseToWin（負けるが勝ち）は相性逆転なので強さ（value）を持たない（固定1）。
  const value = type === "loseToWin"
    ? 1
    : await weightedRoll(stream, TIER_VALUE_WEIGHTS[rarity]);
  return { type, value };
}

async function rollWorld(stream) {
  const region = WORLD_REGIONS[await uniformInt(stream, WORLD_REGIONS.length)];
  const species = region.realm === "outsider"
    ? WORLD_SPECIES[await uniformInt(stream, WORLD_SPECIES.length)]
    : await weightedRoll(stream, REALM_SPECIES_WEIGHTS[region.realm]);
  const elementJa = region.elements[await uniformInt(stream, region.elements.length)];
  const element = { ja: elementJa, en: ELEMENT_INFO[elementJa].en };
  const camera = CAMERA_ANGLES[await uniformInt(stream, CAMERA_ANGLES.length)];
  return { species, region, element, camera };
}

// ── 属性補正 ─────────────────────────────────────────────
// ハッシュで決まった基礎ステータス(hp/p/s/t)に、属性ごとの固定意味づけ補正をかける。
// HP/各ステータスは最低1を下回らないようクランプする。
async function applyElementModifier(stream, elementJa, base) {
  const stats = { hp: base.hp, p: base.p, s: base.s, t: base.t };
  const clamp = (v) => Math.max(1, v);
  const pstKeys = ["p", "s", "t"];

  const pickExtreme = (keys, mode) => {
    // 同値がある場合はハッシュ由来のバイト値で決定的にどれか1つを選ぶ。
    let bestKey = keys[0];
    for (const k of keys) {
      if (mode === "min" ? stats[k] < stats[bestKey] : stats[k] > stats[bestKey]) bestKey = k;
    }
    return bestKey;
  };

  switch (elementJa) {
    case "炎":
      stats.p += 1;
      break;
    case "水":
      stats.s += 1;
      break;
    case "氷":
      stats.t += 1;
      break;
    case "草":
      stats.hp += 1;
      break;
    case "風": {
      stats.hp = clamp(stats.hp - 1);
      const lowestTies = pstKeys.filter((k) => stats[k] === Math.min(...pstKeys.map((kk) => stats[kk])));
      const key = lowestTies.length > 1 ? lowestTies[await uniformInt(stream, lowestTies.length)] : lowestTies[0];
      stats[key] += 1;
      break;
    }
    case "岩": {
      stats.hp += 1;
      const highestTies = pstKeys.filter((k) => stats[k] === Math.max(...pstKeys.map((kk) => stats[kk])));
      const key = highestTies.length > 1 ? highestTies[await uniformInt(stream, highestTies.length)] : highestTies[0];
      stats[key] = clamp(stats[key] - 1);
      break;
    }
    case "光": {
      stats.hp = clamp(stats.hp - 1);
      const key = pstKeys[await uniformInt(stream, pstKeys.length)];
      stats[key] += 1;
      break;
    }
    case "闇":
      stats.hp = clamp(stats.hp - 2);
      stats.p += 1;
      stats.s += 1;
      stats.t += 1;
      break;
    default:
      break;
  }
  return stats;
}

// 名前の検証（空白除去・NGワード/版権名チェック）。問題があれば throw。
// サーバー側の _name-check.js（クライアント name-filter.js と同一ルール）を使う。
// origin: NGワードリスト取得用の同一オリジン（例: new URL(request.url).origin）。
async function normalizeName(inputName, origin) {
  const name = inputName.trim();
  if (!name) throw new Error("名前が未入力です");
  const check = await checkMonsterNameServer(name, origin);
  if (!check.ok) throw new Error(NAME_REJECT_MESSAGES[check.reason]);
  return name;
}

// 生成本体（NGチェック済みの名前を渡す純粋関数。決定論テスト用に分離）。
// nameInput: 検証済み・trim 済みの名前。空やNGワードを含む名前は呼び出し側で弾くこと。
export async function generateMonsterFromName(nameInput) {
  const name = nameInput.trim();
  const seed = name;
  const stream = await createByteStream(seed);
  const baseHash = stream.hashHex;

  const rarityInfo = await rarityRoll(stream);
  const pool = RARITY_POOLS[rarityInfo.rarity];
  const pickIndex = await uniformInt(stream, pool.length);
  const picked = pool[pickIndex];
  const skillRoll = await rollSkill(stream, picked.rarity);
  const skillFallback = localSkillFlavor(skillRoll);
  const world = await rollWorld(stream);
  const adjusted = await applyElementModifier(stream, world.element.ja, picked);
  const scaleStats = ({ hp, p, s, t }) => ({
    hp: hp * STAT_SCALE,
    p: p * STAT_SCALE,
    s: s * STAT_SCALE,
    t: t * STAT_SCALE
  });
  const scaledAdjusted = scaleStats(adjusted);
  const scaledBase = scaleStats(picked);

  return {
    id: `${baseHash.slice(0, 12)}-R${picked.rarity}`,
    name,
    seed,
    hash: baseHash,
    rarityRoll: rarityInfo.roll,
    rarity: picked.rarity,
    skill: {
      type: skillRoll.type,
      value: skillRoll.value * STAT_SCALE,
      used: false,
      name: skillFallback.name,
      effect: skillFallback.effect,
      flavor1: skillFallback.flavor1,
      flavor2: skillFallback.flavor2
    },
    world,
    hp: scaledAdjusted.hp,
    p: scaledAdjusted.p,
    s: scaledAdjusted.s,
    t: scaledAdjusted.t,
    total: scaledAdjusted.hp + scaledAdjusted.p + scaledAdjusted.s + scaledAdjusted.t,
    baseStats: scaledBase
  };
}

// 名前からアイモンを生成する（名前検証込み）。
// origin: NGワードリスト取得用の同一オリジン。
export async function generateMonster(nameInput, origin) {
  const name = await normalizeName(nameInput, origin);
  return generateMonsterFromName(name);
}
