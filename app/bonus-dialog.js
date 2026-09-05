// 共有・いいね・召喚ボーナス獲得ダイアログ（M5）
// いいね・召喚・共有（新規/統合）などのインプレッション操作で +2クレジットを獲得したときに表示する。
// DOMへ動的にオーバーレイを注入するため、ページ側のマークアップ追加は不要。
// スタイルは app/styles.css の .bonus-dialog 系、および index.html のインラインスタイルに定義する。

import { successHaptic } from "./haptics.js";

export function showBonusDialog(message = "🎉 ボーナスを獲得しました（+2クレジット）") {
  // 既に表示中なら再表示しない（連打時も1回だけ）。
  if (document.querySelector(".bonus-dialog")) return;
  successHaptic();

  const overlay = document.createElement("div");
  overlay.className = "bonus-dialog";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const box = document.createElement("div");
  box.className = "bonus-dialog-box";

  const icon = document.createElement("div");
  icon.className = "bonus-dialog-icon";
  icon.textContent = "🎉";

  const msg = document.createElement("p");
  msg.className = "bonus-dialog-msg";
  msg.textContent = message;

  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn-primary bonus-dialog-ok";
  ok.textContent = "OK";

  ok.addEventListener("click", () => {
    overlay.remove();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  box.appendChild(icon);
  box.appendChild(msg);
  box.appendChild(ok);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
