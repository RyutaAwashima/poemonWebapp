// カードに「物理カードっぽい」3D傾き＋ホロ光沢インタラクションを付与する。
// マウス／タッチの指の位置をカード中心からの相対位置に変換し、
// CSS変数(--rx, --ry, --mx, --my)を更新するだけで、実際の見た目(rotate/gradient)は
// styles.css側の .tcard 定義に委譲する（レイヤー分離）。
//
// レアリティが高いほどホロの発色を強くする。

export const MAX_TILT_DEG = 14; // カードの最大傾き角度
export const HOLO_OPACITY_BY_RARITY = {
  1: 0.08,
  2: 0.16,
  3: 0.28,
  4: 0.42
};
// イラスト部分は他の光沢エリアより1段階暗め（レアリティを1つ下げた程度）にする。
export const ART_HOLO_OPACITY_BY_RARITY = {
  1: 0.04,
  2: 0.08,
  3: 0.16,
  4: 0.28
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// カード内の各エリアが光沢対象かどうか・その位置（カード上端からの割合0〜1）を計算する。
// header・artは常時対象（artはワントーン暗め）。world・footerは★3以上のみ対象。
// body（スキルウインドウ・PSTパネル）は常にマットのまま対象外。
// cardEl は実際にレイアウト済み（DOMに接続済み）である必要がある。
export function computeGlossyRegions(cardEl, rarity) {
  const cardRect = cardEl.getBoundingClientRect();
  if (!cardRect.height) return null;
  const headerEl = cardEl.querySelector(".tcard-header");
  const artEl = cardEl.querySelector(".tcard-art");
  const worldEl = cardEl.querySelector(".tcard-world");
  const footerEl = cardEl.querySelector(".tcard-footer");
  if (!headerEl || !artEl || !worldEl || !footerEl) return null;

  const h = cardRect.height;
  const frac = (px) => clamp(px / h, 0, 1);
  const rectFrac = (target) => {
    const r = target.getBoundingClientRect();
    return { top: frac(r.top - cardRect.top), bottom: frac(r.bottom - cardRect.top) };
  };

  return {
    header: rectFrac(headerEl),
    art: rectFrac(artEl),
    world: rarity >= 3 ? rectFrac(worldEl) : null,
    footer: rarity >= 3 ? rectFrac(footerEl) : null
  };
}

function pointerRatioFromEvent(evt, rect) {
  const point = evt.touches?.[0] || evt.changedTouches?.[0] || evt;
  const x = clamp((point.clientX - rect.left) / rect.width, 0, 1);
  const y = clamp((point.clientY - rect.top) / rect.height, 0, 1);
  return { x, y };
}

function applyTilt(cardEl, ratioX, ratioY) {
  // ratio 0-1 → -1..1 に変換して傾き角度を算出
  const nx = ratioX * 2 - 1;
  const ny = ratioY * 2 - 1;
  const ry = nx * MAX_TILT_DEG; // 左右の指位置 → Y軸回転
  const rx = -ny * MAX_TILT_DEG; // 上下の指位置 → X軸回転
  cardEl.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
  cardEl.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
  cardEl.style.setProperty("--mx", `${(ratioX * 100).toFixed(1)}%`);
  cardEl.style.setProperty("--my", `${(ratioY * 100).toFixed(1)}%`);
}

function resetTilt(cardEl) {
  cardEl.style.setProperty("--rx", "0deg");
  cardEl.style.setProperty("--ry", "0deg");
  cardEl.style.setProperty("--mx", "50%");
  cardEl.style.setProperty("--my", "50%");
}

// カードに指/マウスによる3D傾きとホロ光沢を有効化する。
// rarity(1-4)に応じてホロの強さを調整。戻り値は後片付け用のdispose関数。
export function attachHoloTilt(cardEl, rarity) {
  const holoOpacity = HOLO_OPACITY_BY_RARITY[rarity] ?? HOLO_OPACITY_BY_RARITY[1];
  cardEl.classList.add("tcard--tilt");
  cardEl.style.setProperty("--holo-opacity", holoOpacity);
  resetTilt(cardEl);

  let dragging = false;

  const onMove = (evt) => {
    if (!dragging && evt.type === "pointermove") return;
    const rect = cardEl.getBoundingClientRect();
    const { x, y } = pointerRatioFromEvent(evt, rect);
    cardEl.classList.add("tcard--active");
    applyTilt(cardEl, x, y);
  };

  const onEnter = () => {
    dragging = true;
  };

  const onLeave = () => {
    dragging = false;
    cardEl.classList.remove("tcard--active");
    resetTilt(cardEl);
  };

  cardEl.addEventListener("pointerenter", onEnter);
  cardEl.addEventListener("pointermove", onMove);
  cardEl.addEventListener("pointerleave", onLeave);
  cardEl.addEventListener("pointercancel", onLeave);
  cardEl.addEventListener("touchstart", onMove, { passive: true });
  cardEl.addEventListener("touchmove", onMove, { passive: true });
  cardEl.addEventListener("touchend", onLeave);
  cardEl.addEventListener("touchcancel", onLeave);

  return function dispose() {
    cardEl.removeEventListener("pointerenter", onEnter);
    cardEl.removeEventListener("pointermove", onMove);
    cardEl.removeEventListener("pointerleave", onLeave);
    cardEl.removeEventListener("pointercancel", onLeave);
    cardEl.removeEventListener("touchstart", onMove);
    cardEl.removeEventListener("touchmove", onMove);
    cardEl.removeEventListener("touchend", onLeave);
    cardEl.removeEventListener("touchcancel", onLeave);
  };
}

// PNG書き出し直前に呼び、傾き/ホロを一時的に無効化してフラットな見た目で撮影する。
// 戻り値の restore() で元の状態に戻す。
export function freezeTiltForCapture(cardEl) {
  const wasActive = cardEl.classList.contains("tcard--active");
  cardEl.classList.add("tcard--capturing");
  cardEl.classList.remove("tcard--active");
  resetTilt(cardEl);
  return function restore() {
    cardEl.classList.remove("tcard--capturing");
    if (wasActive) cardEl.classList.add("tcard--active");
  };
}
