// アイコンタップUI共通ユーティリティ（2026-08-08 UI洗練）。
//
// 対象: `data-tap-label="文言"` 属性を持つ button / a 要素。
// 挙動:
//  - 押下（pointerdown）中、要素のすぐ上にラベルを表示（指で隠れないよう常に上）
//  - 指を押したままドラッグして要素から外れると「キャンセル」扱いになり、
//    その後の click イベントを抑制する（誤タップ防止）
//  - 指を離すとラベルを消す。キャンセルされていなければ通常どおり click が発火
//  - マウスでは hover 中もラベルを表示（デスクトップの可読性確保）
//  - disabled 要素は対象外
//
// 使い方: 各ページで一度 `attachTapLabels()` を呼ぶ（イベント委譲方式）。
// アクセシビリティ: data-tap-label を aria-label にも自動反映（未設定時のみ）。

let labelEl = null;
let press = null; // { el, pointerId, cancelled }
let suppressClick = false;

const SLOP = 12; // 要素の境界から何px以上出たらキャンセルとみなすか

function getLabel() {
  if (!labelEl) {
    labelEl = document.createElement("div");
    labelEl.className = "tap-label";
    labelEl.setAttribute("role", "tooltip");
    document.body.appendChild(labelEl);
  }
  return labelEl;
}

function isTarget(node) {
  if (!node || !(node instanceof Element)) return null;
  const el = node.closest("[data-tap-label]");
  return el && !el.disabled ? el : null;
}

function syncAria(el) {
  if (!el.hasAttribute("aria-label")) {
    const text = el.getAttribute("data-tap-label") || "";
    if (text) el.setAttribute("aria-label", text);
  }
}

function positionLabel(label, el) {
  const r = el.getBoundingClientRect();
  const lw = label.offsetWidth || 0;
  const lh = label.offsetHeight || 0;
  let left = r.left + r.width / 2 - lw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - lw - 8));
  // #2: ラベルは必ずアイコンの上に表示（指で隠れないように）。
  // 上に空間が無い場合は画面上端へ寄せ、下（指の位置）には出さない。
  let top = r.top - lh - 6;
  if (top < 4) top = 4;
  label.style.left = `${left}px`;
  label.style.top = `${top}px`;
}

function showLabel(el) {
  const label = getLabel();
  const text = el.getAttribute("data-tap-label") || el.getAttribute("aria-label") || "";
  if (!text) return;
  label.textContent = text;
  positionLabel(label, el);
  label.classList.add("show");
}

function hideLabel() {
  if (labelEl) labelEl.classList.remove("show");
}

/**
 * タップラベル＋ドラッグキャンセルを有効化する（イベント委譲・複数回呼び出し安全）。
 * @param {ParentNode} root
 */
export function attachTapLabels(root = document) {
  if (root.__tapLabelsAttached) return;
  root.__tapLabelsAttached = true;

  root.addEventListener("pointerdown", (e) => {
    suppressClick = false;
    const el = isTarget(e.target);
    if (!el) return;
    syncAria(el);
    showLabel(el);
    press = { el, pointerId: e.pointerId, cancelled: false };
  }, true);

  root.addEventListener("pointermove", (e) => {
    if (!press || press.pointerId !== e.pointerId) return;
    // 要素の外へ出たらキャンセル扱い（誤タップ防止）
    const r = press.el.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < r.left - SLOP || x > r.right + SLOP || y < r.top - SLOP || y > r.bottom + SLOP) {
      if (!press.cancelled) {
        press.cancelled = true;
        hideLabel();
      }
    }
  }, true);

  function endPress(e) {
    if (!press || press.pointerId !== e.pointerId) return;
    if (press.cancelled) suppressClick = true;
    press = null;
    hideLabel();
  }
  root.addEventListener("pointerup", endPress, true);
  root.addEventListener("pointercancel", endPress, true);

  // キャンセルされたタップの click を抑制する（1回だけ）
  root.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true);

  // マウスホバーでもラベル表示（タッチ以外・押下中でないとき）
  root.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse" || press) return;
    const el = isTarget(e.target);
    if (el) {
      syncAria(el);
      showLabel(el);
    }
  });
  root.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse" || press) return;
    hideLabel();
  });

  // スクロール/リサイズ/フォーカス喪失でラベルを隠す
  window.addEventListener("scroll", hideLabel, { passive: true });
  window.addEventListener("resize", hideLabel);
  window.addEventListener("blur", hideLabel);
}

// 自動初期化（各ページはこのスクリプトを読み込むだけで有効化される）
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => attachTapLabels(), { once: true });
  } else {
    attachTapLabels();
  }
}
