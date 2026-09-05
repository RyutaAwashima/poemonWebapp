// app/home-announcements.js
// ホームの「お知らせ」欄。D1 に一元管理された公開済みお知らせを /api/announcements から取得して表示する。
// メール配信（/api/newsletter）と同じデータソースを参照するため、お知らせの重複管理が不要になる。

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

const mount = document.getElementById("home-announcements");
if (mount) {
  const VISIBLE_COUNT = 3; // 直近3件を常時表示し、残りは「もっと見る」で開閉（2026-08-14）

  function renderItem(a) {
    return `
        <article class="announce-item">
          <time class="announce-date">${escapeHtml(formatDate(a.publishedAt))}</time>
          <h3 class="announce-title">${escapeHtml(a.title)}</h3>
          <p class="announce-body">${escapeHtml(a.body)}</p>
        </article>`;
  }

  fetch("/api/announcements", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fetch failed"))))
    .then((data) => {
      const list = Array.isArray(data.announcements) ? data.announcements : [];
      if (!list.length) {
        mount.innerHTML = '<p class="announce-empty">現在お知らせはありません</p>';
        return;
      }
      const shown = list.slice(0, VISIBLE_COUNT);
      const rest = list.slice(VISIBLE_COUNT);
      let html = shown.map(renderItem).join("");
      if (rest.length) {
        html += `
          <button type="button" class="announce-more" aria-expanded="false">
            <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
            <span>残り${rest.length}件を表示</span>
          </button>
          <div class="announce-rest" hidden>
            ${rest.map(renderItem).join("")}
          </div>`;
      }
      mount.innerHTML = html;
      const btn = mount.querySelector(".announce-more");
      const restBox = mount.querySelector(".announce-rest");
      btn?.addEventListener("click", () => {
        const expand = restBox.hidden; // 現在閉じているなら開く
        restBox.hidden = !expand;
        btn.setAttribute("aria-expanded", String(expand));
        btn.querySelector("i").className = expand ? "fa-solid fa-chevron-up" : "fa-solid fa-chevron-down";
        btn.querySelector("span").textContent = expand ? "閉じる" : `残り${rest.length}件を表示`;
      });
    })
    .catch(() => {
      mount.innerHTML = '<p class="announce-empty">お知らせを読み込めませんでした</p>';
    });
}
