// ボタンをタッチ/クリックした瞬間に軽い振動フィードバックを返す。
// iOS Safariはnavigator.vibrate未対応のため、機能検出して非対応環境では何もしない
// （非対応環境はCSSの押下エフェクトが視覚フィードバックを代替する・M5）。
const canVibrate = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

function vibrate(pattern) {
  if (!canVibrate) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // 非対応・ユーザー操作外などで例外が出ても無視する
  }
}

// 通常ボタン用の短い振動（押した実感を出す程度）。
export function tapHaptic() {
  vibrate(12);
}

// 決定/生成のような重要アクション用の少し強めの振動。
export function confirmHaptic() {
  vibrate([16, 30, 16]);
}

// ボーナス獲得など嬉しいフィードバック用の軽い振動（M5）。
export function successHaptic() {
  vibrate([12, 40, 12]);
}

// イベント委譲方式（M5）: document 直下に pointerdown リスナーを1つだけ張り、
// 実行時に存在するすべての「button / a.btn-link」へ振動を付与する。
// - 動的に追加されるボタン（編成・フィード等）も個別登録なしでカバーできる。
// - disabled なボタンは除外（押下不可の見た目と揃える）。
// - WeakSet で二重登録を防止（ページ内で attachButtonHaptics を複数回呼んでも安全）。
let delegated = false;
const handledButtons = new WeakSet();

export function attachButtonHaptics(root = document) {
  if (delegated) return;
  delegated = true;
  root.addEventListener(
    "pointerdown",
    (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button, a.btn-link") : null;
      if (!btn) return;
      if (btn.disabled) return;
      if (handledButtons.has(btn)) return;
      handledButtons.add(btn);
      vibrate(12);
    },
    { passive: true }
  );
}
