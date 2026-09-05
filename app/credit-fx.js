// app/credit-fx.js
// クレジット残高表示の増減を視覚的に強調する共通ヘルパー。
// dashboard.js / shop.js / main.js の3箇所（すべて「クレジット: N」形式のラベル）から使う。
// 要素の data-prev-credits に前回値を保持し、変化時のみパルス+デルタ表示アニメーションを発火する。

// label要素を「プレフィックス + 数値(強調span) + デルタ表示span」の構造に更新し、
// 前回値との差分があればパルスアニメーション（増=緑/減=赤）とフロートする差分バッジを表示する。
export function updateCreditLabel(el, value, prefix = "クレジット: ") {
  if (!el) return;
  const num = Number(value);
  const display = Number.isFinite(num) ? num : "--";
  const prevRaw = el.dataset.prevCredits;
  const prev = prevRaw !== undefined ? Number(prevRaw) : null;

  el.innerHTML = `${prefix}<span class="credit-num">${display}</span><span class="credit-delta"></span>`;
  const numEl = el.querySelector(".credit-num");
  const deltaEl = el.querySelector(".credit-delta");

  // 前回値（prevCredits）を先に更新しておく。dispatchEvent は同期実行で、リスナー
  // （home-account.js の apply）が再び updateCreditLabel を呼ぶ。ここで前回値を更新して
  // いないと、再入時に prev が古いままのため同じ差分を検出し続け、無限再帰（RangeError:
  // Maximum call stack size exceeded）になる。前回値を先に確定させれば再入時に prev === num
  // となり再帰が止まる。
  if (Number.isFinite(num)) {
    el.dataset.prevCredits = String(num);
  }

  if (prev !== null && Number.isFinite(prev) && Number.isFinite(num) && num !== prev) {
    const delta = num - prev;
    const isUp = delta > 0;
    numEl.classList.add(isUp ? "credit-up" : "credit-down");
    deltaEl.textContent = isUp ? `+${delta}` : `${delta}`;
    deltaEl.classList.add(isUp ? "show-up" : "show-down");
    // アニメーション終了後にクラスを外し、再発火できる状態に戻す。
    numEl.addEventListener("animationend", () => numEl.classList.remove("credit-up", "credit-down"), { once: true });
    deltaEl.addEventListener("animationend", () => { deltaEl.textContent = ""; deltaEl.classList.remove("show-up", "show-down"); }, { once: true });
    // クレジットが変化したことを全ページ共通ヘッダー（home-account.js）へ通知する。
    // これにより、ログインボーナス受取・生成・購入などどこで増減してもヘッダーの表示が追従する。
    window.dispatchEvent(new CustomEvent("aimon:credit-updated", { detail: { value: num } }));
  }
}
