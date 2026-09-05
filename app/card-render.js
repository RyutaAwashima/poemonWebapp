// トレーディングカード風のビジュアルカードをDOMとして構築し、PNG画像として書き出す。
// レイアウト:
//  header: 名前（左詰め・KuroHanaMincho）/ HPバッジ
//  art: 属性アイコン（左上）/ アートワーク（上詰め） / レアリティアイコン（右下・中央寄せ）
//  world band: クラン情報（左に[界]の固定パネル、右に「種族：」「所属クラン：」の2行・KuroHanaMincho）
//  body: スキル（左・BIZUDPMincho）/ P・S・T（右・ラベル左詰め数字中央）
//  footer: おや・初発見者バッジのみ（IDは非表示・既定フォントのまま）
//
//  光沢(ホロ)の適用範囲・色味はレアリティで変化する:
//   ★1〜2: 名前欄＋イラストエリアだけを光らせ、それ以外はマット。色は属性ごとのグロー。
//   ★3  : ★4と同じ範囲（body除く全体）を光らせるが、色は属性ごとのグロー・文字はシルバー。
//   ★4  : body除く全体を虹色ホロで光らせ、名前・クラン文字はゴールド。
//   イラスト部分は常に他エリアより1段階暗めの光沢にする（ART_HOLO_OPACITY_BY_RARITY）。
//   実際の各エリアの高さはcomputeGlossyRegions()でDOM計測して決める（可変長テキストに追従するため）。
// --- シール印刷用の物理サイズ定義 ---------------------------------------
// 画面表示用のPNG保存(downloadCardAsPng)とは別に、ラベルプリンターでの
// シール印刷を見据えた「物理サイズ基準」の書き出し(exportCardForPrint)を用意する。
// 一般的なトレーディングカード(ポーカーカード)サイズ 63.5mm×88.9mm を採用し、
// 家庭用インクジェット/レーザープリンターの標準的な印刷解像度である300dpiで固定する。
// プリンター機種が確定したら、この定数だけを差し替えれば出力サイズに反映できる。
export const PRINT_CARD_WIDTH_MM = 63.5;
export const PRINT_CARD_HEIGHT_MM = 88.9;
export const PRINT_DPI = 300;
// mm→px変換（1inch = 25.4mm）。.tcardのaspect-ratio:5/7と一致する比率になる。
export const PRINT_WIDTH_PX = Math.round((PRINT_CARD_WIDTH_MM / 25.4) * PRINT_DPI);
export const PRINT_HEIGHT_PX = Math.round((PRINT_CARD_HEIGHT_MM / 25.4) * PRINT_DPI);

import {
  attachHoloTilt,
  freezeTiltForCapture,
  computeGlossyRegions,
  ART_HOLO_OPACITY_BY_RARITY
} from "./card-tilt.js";
import { WORLD_YOMI, withRuby } from "./world-yomi.js";
import { normalizeTraining } from "./aimon-core.js";
import { loadArtCrop } from "./art-crop.js";

const ELEMENT_ICON = {
  "炎": "🔥", "水": "💧", "氷": "❄️", "風": "🌪️",
  "草": "🌿", "岩": "🪨", "光": "✨", "闇": "🌑"
};

// ★1〜3で使う属性別の光沢カラー（8属性）。★4は虹色ホロ固定のため対象外。
const ELEMENT_GLOW_COLOR = {
  "炎": "#ff6a4d",
  "水": "#3fa9ff",
  "氷": "#9fe8ff",
  "風": "#8ff5c9",
  "草": "#6fdb5e",
  "岩": "#c9975a",
  "光": "#fff3a0",
  "闇": "#a56bff"
};

const RARITY_STYLE = {
  1: { color: "#9ca3af", label: "COMMON" },
  2: { color: "#34d399", label: "UNCOMMON" },
  3: { color: "#60a5fa", label: "RARE" },
  4: { color: "#fbbf24", label: "LEGEND" }
};

// 常に存在するエリア(header/art)と、★3以上でのみ光る追加エリア(world/footer)。
const GLOSSY_ROLES = ["header", "art", "world", "footer"];

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

// スキル種別 → FontAwesomeアイコンクラス（運用ルール: .github/copilot-instructions.md）
const SKILL_TYPE_ICON_CLASS = {
  damage: "fa-solid fa-turn-up s-damage",
  loseToWin: "fa-solid fa-repeat s-loseToWin",
  heal: "fa-solid fa-hand-holding-heart s-heal",
  guard: "fa-solid fa-shield-alt s-guard",
};

// 属性補正による増減を色分け表示するヘルパー。
// baseValueが無い（旧データ等）場合は補正なしとして通常表示する。
function statSpan(value, baseValue) {
  if (baseValue == null || baseValue === value) return `${value}`;
  const diff = value - baseValue;
  const cls = diff > 0 ? "tcard-stat-buffed" : "tcard-stat-debuffed";
  const sign = diff > 0 ? "+" : "";
  return `<span class="${cls}">${value}<small class="tcard-stat-diff">(${sign}${diff})</small></span>`;
}

// 各光沢バンド（.tcard-glossy-band-*要素）の位置・表示・明るさをDOM計測結果に合わせて更新する。
// カードがまだレイアウトされていない場合は次フレームで再試行する。
function updateGlossyRegions(card, rarity, bandEls, attempt = 0) {
  const regions = computeGlossyRegions(card, rarity);
  if (!regions) {
    if (attempt < 5) requestAnimationFrame(() => updateGlossyRegions(card, rarity, bandEls, attempt + 1));
    return;
  }
  // top/heightはtransform適用前(レイアウト時)の座標系で解釈されるため、
  // getBoundingClientRect().height（transform: scale()後の見た目上の高さ）ではなく
  // offsetHeight（transformの影響を受けないレイアウト高さ）を基準にpx値へ変換する。
  // ミニカード(.mini-card-stage内でscaleを掛けている場合)でこれを誤るとホロ帯の
  // 位置がずれ、イラストに帯状のオーバーレイが入って見えるバグになる。
  const cardH = card.offsetHeight;
  for (const role of GLOSSY_ROLES) {
    const band = bandEls[role];
    const region = regions[role];
    if (!band) continue;
    if (!region) {
      band.style.display = "none";
      continue;
    }
    band.style.display = "block";
    band.style.top = `${region.top * cardH}px`;
    band.style.height = `${(region.bottom - region.top) * cardH}px`;
    if (role === "art") {
      band.style.setProperty("--holo-opacity", ART_HOLO_OPACITY_BY_RARITY[rarity] ?? ART_HOLO_OPACITY_BY_RARITY[1]);
    }
  }
}

// カード全体のレイアウト適用（調整#6）。
// ネームエリア(header)の高さをDOM計測し、イラスト(art)をその半分だけ上へ引き上げることで
// 「イラスト上端 = ネームエリアのy中心」を作り、ネーム下部をイラストに被せる。
// 同時にホロ光沢帯(updateGlossyRegions)を再計算する（レイアウト確定までフレーム単位で再試行）。
function applyCardLayout(card, rarity, bandEls, attempt = 0) {
  const header = card.querySelector(".tcard-header");
  const art = card.querySelector(".tcard-art");
  const h = header?.offsetHeight || 0;
  if (h > 0) {
    const overlap = Math.round(h / 2);
    card.style.setProperty("--name-overlap", `${overlap}px`);
    if (art) art.style.marginTop = `-${overlap}px`;
  }
  updateGlossyRegions(card, rarity, bandEls);
  if ((!h || !card.offsetHeight) && attempt < 5) {
    requestAnimationFrame(() => applyCardLayout(card, rarity, bandEls, attempt + 1));
  }
}

export function buildAimonCardElement(monster) {
  // ⑬ artCrop: localStorageからイラスト調整データを自動復元（生成/編成/対戦すべてのページで共通）
  loadArtCrop(monster);
  const rarityStyle = RARITY_STYLE[monster.rarity] || RARITY_STYLE[1];
  const world = monster.world;
  const elementJa = world?.element?.ja;
  const elementIcon = ELEMENT_ICON[elementJa] || "❔";
  const origin = monster.origin || null;

  const card = el("div", "tcard");
  card.style.setProperty("--rarity-color", rarityStyle.color);
  card.style.setProperty("--element-glow-color", ELEMENT_GLOW_COLOR[elementJa] || "#ffffff");
  // ズーム詳細（card-zoom.js）用に発見者情報を data 属性へ載せる。フル uid は載せない（設計 §9.6）。
  if (origin) {
    card.dataset.originNickname = origin.nickname || "";
    card.dataset.originShortUid = origin.shortUid || "";
    card.dataset.originDiscoveredAt = origin.discoveredAt || "";
    card.dataset.originIsMine = origin.isMine ? "1" : "";
  }
  if (monster.rarity >= 4) {
    card.classList.add("tcard--legendary-gold");
  } else if (monster.rarity === 3) {
    // ★3: 文字装飾はシルバーのまま、光沢(ホロ)はゴールドに変更
    card.classList.add("tcard--legendary-silver", "tcard--gloss-gold");
  } else if (monster.rarity === 2) {
    // ★2: 光沢をシルバーに変更
    card.classList.add("tcard--gloss-silver");
  } else {
    // ★1: 光沢なし、属性グローのみ
    card.classList.add("tcard--gloss-none");
  }

  // header
  // 願い（育成スロットの確定 text）は名前の前には出さず、レベルバッジ下の
  // スロットバッジ（tcard-slot-badge）にのみ表示する（下記 rarityPanel）。
  const header = el("div", "tcard-header");
  header.appendChild(el("div", "tcard-name", monster.name));
  header.appendChild(el("div", "tcard-hp", `HP<span>${statSpan(monster.hp, monster.baseStats?.hp)}</span>`));
  card.appendChild(header);

  // artwork
  // アートはヘッダー直下から始まり、下段(ボディ/フッター)が必要とする高さを差し引いた
  // 残りスペースを幅いっぱいに使う（レターボックスなしでカード幅に合わせて拡大）。
  const art = el("div", "tcard-art");
  art.appendChild(el("div", "tcard-element", `${elementIcon}<small>${elementJa || ""}</small>`));
  if (monster.imageUrl) {
    const img = el("img", "tcard-art-img");
    img.crossOrigin = "anonymous";
    img.draggable = false;
    img.addEventListener("contextmenu", (e) => e.preventDefault());
    img.src = monster.imageUrl;
    img.alt = monster.name;
    // ⑬ artCrop: ユーザーが調整したイラストのスケール・位置を適用
    const crop = monster.artCrop;
    if (crop && (crop.scale !== 1 || crop.x !== 0 || crop.y !== 0)) {
      img.style.transform = `scale(${crop.scale}) translate(${crop.x}px, ${crop.y}px)`;
      img.style.transformOrigin = "center center";
    }
    art.appendChild(img);
  } else {
    art.appendChild(el("div", "tcard-art-placeholder", "イラスト生成中..."));
  }

  // world band（クラン情報）: イラストエリアの下端にオーバーレイする半透明パネル。
  // 左に「界」の固定パネル（常に短い語なので幅がブレない）、
  // 右に「種族：」「所属クラン：」のラベル付き2行。
  // 国は「地域」と紛らわしいため表示せず、スキルのフレーバーで示唆する運用に変更。
  // 漢字部分にはWORLD_YOMIのふりがなデータを使ってルビを振る
  const worldBand = el("div", "tcard-world");
  if (world) {
    const realmYomi = WORLD_YOMI.realm[world.species.realm];
    worldBand.appendChild(el("div", "tcard-realm-panel", withRuby(world.species.realm, realmYomi)));

    const speciesHtml = withRuby(world.species.ja, WORLD_YOMI.species[world.species.id]);
    const regionHtml = withRuby(world.region.ja, WORLD_YOMI.region[world.region.id]);
    const worldLines = el("div", "tcard-world-lines");
    worldLines.appendChild(el("div", "tcard-world-line", `<span class="tcard-world-label">種族：</span>${speciesHtml}`));
    worldLines.appendChild(el("div", "tcard-world-line", `<span class="tcard-world-label">所属クラン：</span>${regionHtml}`));
    worldBand.appendChild(worldLines);
  }
  art.appendChild(worldBand);

  // レア度パネルはクラン情報パネルと被らないよう右上に配置する。
  // 育成レベル（Lv）バッジはネームエリアではなくレア度パネルの下に縦に並べる。
  const { level } = normalizeTraining(monster);
  const rarityPanel = el("div", "tcard-rarity-wrap");
  rarityPanel.appendChild(el("div", "tcard-rarity", `${"★".repeat(monster.rarity)}<small>${rarityStyle.label}</small>`));
  rarityPanel.appendChild(el("div", "tcard-level", `Lv.${level}`));
  // 願いのスロットバッジ: レベルバッジの下に積む。願いのワードのみ（【】なし）。
  // textContent で追加し、ユーザー入力（願いワード）の HTML 解釈を防ぐ。
  for (const s of monster.slots || []) {
    if (s?.opened && s?.text) {
      const slotBadge = document.createElement("div");
      slotBadge.className = "tcard-slot-badge";
      slotBadge.textContent = s.text;
      rarityPanel.appendChild(slotBadge);
    }
  }
  art.appendChild(rarityPanel);

  card.appendChild(art);

  // body: skill（フレーバー1＋効果構文＋フレーバー2の3部構成） + PST
  const body = el("div", "tcard-body");
  const skill = el("div", "tcard-skill");
  const skillNameEl = el("div", "tcard-skill-name");
  const skName = monster.skill?.name || "";
  const skTypeClass = monster.skill?.type ? SKILL_TYPE_ICON_CLASS[monster.skill.type] : "";
  if (skTypeClass) {
    skillNameEl.appendChild(el("i", skTypeClass));
    skillNameEl.appendChild(document.createTextNode(" " + skName));
  } else {
    skillNameEl.textContent = skName;
  }
  skill.appendChild(skillNameEl);
  skill.appendChild(el("div", "tcard-skill-flavor1", monster.skill?.flavor1 || ""));
  skill.appendChild(el("div", "tcard-skill-effect", monster.skill?.effect || ""));
  skill.appendChild(el("div", "tcard-skill-flavor2", monster.skill?.flavor2 || ""));
  body.appendChild(skill);

  const stats = el("div", "tcard-stats");
  stats.appendChild(el("div", "tcard-stat", `<span class="tcard-stat-label"><i class="fa-solid fa-hand-fist h-pow"></i>パワー</span><span class="tcard-stat-value">${statSpan(monster.p, monster.baseStats?.p)}</span>`));
  stats.appendChild(el("div", "tcard-stat", `<span class="tcard-stat-label"><i class="fa-solid fa-hand-peace h-spd"></i>スピード</span><span class="tcard-stat-value">${statSpan(monster.s, monster.baseStats?.s)}</span>`));
  stats.appendChild(el("div", "tcard-stat", `<span class="tcard-stat-label"><i class="fa-solid fa-hand-paper h-tch"></i>テクニック</span><span class="tcard-stat-value">${statSpan(monster.t, monster.baseStats?.t)}</span>`));
  body.appendChild(stats);
  card.appendChild(body);

  // footer: バッジのみ（M5.6・#1/#2）。おや（初発見者）と初発見者バッジを表示。IDは非表示
  // （編成ページの(i)情報ボタンで確認できる）。初発見者レジストリ由来のニックネーム（サーバー側の不変情報）。
  const footer = el("div", "tcard-footer");
  if (origin) {
    const badgeRow = el("div", "tcard-footer-badges");
    const nameBadge = el("span", "tcard-origin-name-badge");
    if (origin.rankIconKey) {
      const rankIcon = document.createElement("img");
      rankIcon.className = "tcard-origin-rank-icon";
      rankIcon.src = `/api/brand-image?id=rank-gem-mini-${origin.rankIconKey}`;
      rankIcon.alt = "";
      nameBadge.appendChild(rankIcon);
    }
    nameBadge.appendChild(document.createTextNode(`おや：${origin.nickname || "―"}`));
    badgeRow.appendChild(nameBadge);
    if (origin.isMine) {
      badgeRow.appendChild(el("span", "tcard-origin-badge", "⭐️あなたが初発見者です"));
    }
    footer.appendChild(badgeRow);
  }
  card.appendChild(footer);

  // holo/shine overlay（タッチ・マウスの傾きに応じてCSS変数で動く光沢レイヤー）。
  // header・artは常時、world・footerは★3以上のみ光る（body/PSTパネルは対象外）。
  const bandEls = {};
  for (const role of GLOSSY_ROLES) {
    const band = el("div", `tcard-glossy-band tcard-glossy-band-${role}`);
    band.appendChild(el("div", "tcard-holo"));
    band.appendChild(el("div", "tcard-shine"));
    card.appendChild(band);
    bandEls[role] = band;
  }

  // タブ切替時等の再描画で光沢帯を再計算できるよう、レアリティをdata属性に保存する。
  card.dataset.rarity = String(monster.rarity);

  attachHoloTilt(card, monster.rarity);
  applyCardLayout(card, monster.rarity, bandEls);

  return card;
}

// コレクションタブ切替時等にカードのレイアウトを再計算する。
// タブ非表示中(display:none)にbuildAimonCardElementが呼ばれた場合、
// header.offsetHeightが0になりイラストのオフセット(--name-overlap)と
// 光沢(ホロ)帯の位置が正しく計算されないため、表示後に再実行して補正する。
export function refreshCardGlossyRegions(cardEl) {
  const rarity = parseInt(cardEl.dataset.rarity, 10) || 1;
  const bandEls = {};
  for (const role of GLOSSY_ROLES) {
    bandEls[role] = cardEl.querySelector(`.tcard-glossy-band-${role}`);
  }
  applyCardLayout(cardEl, rarity, bandEls);
}

// modern-screenshot（html-to-imageのフォーク）をCDNから動的import。
// html-to-imageはSVGのforeignObject経由でHTMLをレンダリングするが、iOS/Android含む
// WebKit系ブラウザではforeignObject内の<img>が描画されずイラストが空白になる既知の不具合がある。
// modern-screenshotはこの問題への対策が組み込まれているため採用する。
// （未使用ページの初期ロードを軽くするため遅延読み込み）。
async function loadHtmlToImage() {
  const mod = await import("https://cdn.jsdelivr.net/npm/modern-screenshot@4/+esm");
  return mod;
}

// カード内の.tcard-art-imgがブラウザ上で読み込み完了するまで待つ（最大4秒）。
// イラストが無い/既に読み込み済みの場合は即座に解決する。
function waitForArtworkLoaded(cardEl, timeoutMs = 4000) {
  const img = cardEl.querySelector(".tcard-art-img");
  if (!img) return Promise.resolve();
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      img.removeEventListener("load", done);
      img.removeEventListener("error", done);
      resolve();
    };
    img.addEventListener("load", done);
    img.addEventListener("error", done);
    setTimeout(done, timeoutMs);
  });
}

export async function downloadCardAsPng(cardEl, filename) {
  const { domToPng } = await loadHtmlToImage();
  // イラストがまだ読み込み中の場合、未完了のままキャプチャすると空白のまま
  // 埋め込まれてしまうため、実際の読み込み完了(またはタイムアウト)を待つ。
  await waitForArtworkLoaded(cardEl);
  // 傾き/ホロ演出中の状態のまま撮影するとブレて見えるため、一時的にフラット化して撮影する。
  const restore = freezeTiltForCapture(cardEl);
  let dataUrl;
  try {
    dataUrl = await domToPng(cardEl, { scale: 2 });
  } finally {
    restore();
  }

  const finalFilename = filename || "aimon-card.png";
  const blob = await (await fetch(dataUrl)).blob();
  await shareOrDownloadBlob(blob, finalFilename);
}

// シール印刷用に、物理サイズ(PRINT_WIDTH_PX×PRINT_HEIGHT_PX @300dpi)を基準とした
// PNGを書き出す。画面上の表示サイズに関わらず、印刷時に実寸63.5mm×88.9mmで
// 出力されるようスケールを逆算する。
export async function exportCardForPrint(cardEl, filename) {
  const { domToPng } = await loadHtmlToImage();
  await waitForArtworkLoaded(cardEl);
  const restore = freezeTiltForCapture(cardEl);
  let dataUrl;
  try {
    const rect = cardEl.getBoundingClientRect();
    // 画面上のCSSピクセル幅から、印刷実寸(300dpi基準)のピクセル幅になるようscaleを逆算する。
    // こうすることで、表示サイズ(レスポンシブでウィンドウ幅により変わる)に依存せず
    // 常に一定の物理サイズ・解像度でPNGが書き出される。
    const scale = PRINT_WIDTH_PX / rect.width;
    dataUrl = await domToPng(cardEl, { scale });
  } finally {
    restore();
  }

  const finalFilename = filename || "aimon-card-print.png";
  const blob = await (await fetch(dataUrl)).blob();
  await shareOrDownloadBlob(blob, finalFilename);
}

// PNG Blobの保存を試みる共通処理。iOS Safariは<a download>によるdata URLの保存に
// 対応しておらず、タップしても画像がタブに開くだけで「写真」に保存されない。
// Web Share API(ファイル共有)に対応している場合はそちらを優先し、共有シートから
// 「画像を保存」できるようにする。これはAndroid Chromeでも問題なく動作する。
async function shareOrDownloadBlob(blob, finalFilename) {
  if (navigator.canShare && navigator.share) {
    try {
      const file = new File([blob], finalFilename, { type: "image/png" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: finalFilename });
        return;
      }
    } catch (err) {
      // ユーザーがキャンセルした場合(AbortError)はそのまま終了。それ以外は下のフォールバックへ。
      if (err && err.name === "AbortError") return;
    }
  }

  // フォールバック: Blob URLを使った通常のダウンロード（Android/デスクトップでは通常これで保存できる）。
  // data URLはサイズ制限や挙動の差異があるためBlob URLに変換して使う。
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = finalFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
}
