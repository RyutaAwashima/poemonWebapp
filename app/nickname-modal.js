// app/nickname-modal.js
// ニックネーム未設定ユーザーへの登録導線モーダル（共通・2026-08-22 新設）。
// 「ユーザーの登録が必要です。あなたのニックネームを入力してください」を表示し、
// POST /api/users（app/api-client.js の updateMyProfile）で登録する。
// サーバーはニックネーム初回登録時に新規登録ボーナス（_credits.js SIGNUP_GRANT・1回限定）を
// 付与し、レスポンスの signupBonus で通知してくるため、成功時はボーナスも一緒に伝える。
//
// 使い方:
// - ホーム（app/nav-gate.js）: ゲート対象リンクのクリックで openNicknameRegistrationModal() を
//   呼び、onSuccess で本来の遷移を再開する。
// - 生成ページ（generate.html）: 表示時に autoPromptNicknameRegistration() を呼び、
//   未設定なら自動でモーダルを出す。

import { fetchMyProfile, updateMyProfile } from "./api-client.js";

const STYLE_ID = "nk-gate-style";
const NICKNAME_MAX = 20; // functions/api/users.js の NICKNAME_MAX と同じ上限

let root = null;
let titleEl = null;
let textEl = null;
let inputEl = null;
let errorEl = null;
let bonusEl = null;
let submitBtn = null;

let busy = false;
let finished = false;
let onSuccess = null;
let autoCloseTimer = null;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .nk-gate { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 16px; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    .nk-gate.hidden { display: none; }
    .nk-gate-backdrop { position: absolute; inset: 0; background: rgba(10, 8, 18, 0.8); }
    .nk-gate-box { position: relative; width: min(400px, 100%); max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px); overflow-y: auto; -webkit-overflow-scrolling: touch; box-sizing: border-box; background: linear-gradient(160deg, #262038, #171226); border: 1px solid rgba(255,255,255,0.16); border-radius: 16px; padding: 30px 22px 22px; box-shadow: 0 12px 48px rgba(0,0,0,0.6); text-align: center; color: #f4f1fb; }
    .nk-gate-close { position: absolute; top: 10px; right: 10px; width: 32px; height: 32px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.22); background: rgba(255,255,255,0.08); color: #e7e2f5; font-size: 13px; cursor: pointer; }
    .nk-gate-title { margin: 0 0 8px; font-size: 1.05rem; line-height: 1.4; }
    .nk-gate-text { margin: 0 0 14px; font-size: 0.86rem; color: #cfc8e6; line-height: 1.6; }
    .nk-gate-input { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.24); background: rgba(255,255,255,0.07); color: #fff; font-size: 1rem; text-align: center; }
    .nk-gate-input:focus { outline: 2px solid #a78bfa; outline-offset: 0; }
    .nk-gate-error { min-height: 1.3em; margin: 8px 0 6px; font-size: 0.78rem; color: #ff9d9d; }
    .nk-gate-bonus { display: none; margin: 2px 0 10px; font-size: 0.84rem; font-weight: 700; color: #ffd479; }
    .nk-gate-submit { width: 100%; padding: 13px; border: none; border-radius: 10px; background: linear-gradient(135deg, #f59e0b, #ef4444); color: #fff; font-weight: 700; font-size: 0.95rem; cursor: pointer; }
    .nk-gate-submit:disabled { opacity: 0.55; cursor: default; }
  `;
  document.head.appendChild(style);
}

function ensureDom() {
  if (root) return;
  injectStyle();
  root = document.createElement("div");
  root.className = "nk-gate hidden";
  root.innerHTML = `
    <div class="nk-gate-backdrop"></div>
    <div class="nk-gate-box" role="dialog" aria-modal="true" aria-label="ユーザー登録">
      <button type="button" class="nk-gate-close" aria-label="閉じる">✕</button>
      <h3 class="nk-gate-title">ユーザーの登録が必要です</h3>
      <p class="nk-gate-text">あなたのニックネームを入力してください<br />（メイモンの「おや」として登録されます）</p>
      <input class="nk-gate-input" type="text" maxlength="${NICKNAME_MAX}" placeholder="ニックネーム（${NICKNAME_MAX}文字以内）" enterkeyhint="done" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <p class="nk-gate-error" role="alert"></p>
      <p class="nk-gate-bonus"></p>
      <button type="button" class="nk-gate-submit">登録する</button>
    </div>`;
  document.body.appendChild(root);
  titleEl = root.querySelector(".nk-gate-title");
  textEl = root.querySelector(".nk-gate-text");
  inputEl = root.querySelector(".nk-gate-input");
  errorEl = root.querySelector(".nk-gate-error");
  bonusEl = root.querySelector(".nk-gate-bonus");
  submitBtn = root.querySelector(".nk-gate-submit");

  root.querySelector(".nk-gate-close").addEventListener("click", () => closeModal());
  root.querySelector(".nk-gate-backdrop").addEventListener("click", () => {
    if (!busy) closeModal();
  });
  submitBtn.addEventListener("click", submit);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    // Android/iOS の日本語 IME は変換確定の Enter を keydown に載せる（isComposing=true）。
    // その場合は誤送信せず無視し、変換確定後に再度 Enter か「登録する」ボタンで送信する。
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  });
}

function setError(msg) {
  errorEl.textContent = msg || "";
}

function closeModal() {
  clearTimeout(autoCloseTimer);
  if (root) root.classList.add("hidden");
  busy = false;
}

// 成功後の「始める」押下・自動クローズの共通処理。
function finishAndProceed() {
  clearTimeout(autoCloseTimer);
  closeModal();
  const cb = onSuccess;
  onSuccess = null;
  cb?.();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function showSuccess(data) {
  finished = true;
  const nickname = data?.nickname || inputEl.value.normalize("NFKC").trim();
  titleEl.textContent = "✅ 登録しました！";
  textEl.innerHTML = `ニックネーム: <strong>${escapeHtml(nickname)}</strong><br />ようこそ、モンスター・ハッシュ・ワールドへ！`;
  inputEl.style.display = "none";
  setError("");
  if (data?.signupBonus > 0) {
    bonusEl.textContent = `🎁 新規登録ボーナス ${data.signupBonus} クレジットをプレゼント！（残高 ${data.credits ?? "?"}）`;
    bonusEl.style.display = "block";
  }
  submitBtn.textContent = "始める";
  submitBtn.disabled = false;
  // ボーナス表示を読む時間を確保してから遷移する（「始める」で即時も可）。
  autoCloseTimer = setTimeout(finishAndProceed, 2200);
}

async function submit() {
  if (busy) return;
  if (finished) {
    finishAndProceed();
    return;
  }
  const nickname = inputEl.value.normalize("NFKC").trim();
  if (!nickname) {
    setError("⚠️ ニックネームを入力してください");
    inputEl.focus();
    return;
  }
  if ([...nickname].length > NICKNAME_MAX) {
    setError(`⚠️ ニックネームは${NICKNAME_MAX}文字以内にしてください`);
    return;
  }
  busy = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "登録中...";
  setError("");
  try {
    const data = await updateMyProfile(nickname);
    showSuccess(data);
  } catch (e) {
    setError(`❌ ${e.message || "登録に失敗しました"}`);
    busy = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "登録する";
  }
}

// モーダルを開く。handler.onSuccess は登録完了（成功画面経由）後に呼ばれる。
export function openNicknameRegistrationModal(handler = {}) {
  ensureDom();
  onSuccess = typeof handler.onSuccess === "function" ? handler.onSuccess : null;
  finished = false;
  busy = false;
  clearTimeout(autoCloseTimer);
  titleEl.textContent = "ユーザーの登録が必要です";
  textEl.innerHTML = `あなたのニックネームを入力してください<br />（メイモンの「おや」として登録されます）`;
  inputEl.style.display = "";
  inputEl.value = "";
  setError("");
  bonusEl.style.display = "none";
  bonusEl.textContent = "";
  submitBtn.disabled = false;
  submitBtn.textContent = "登録する";
  root.classList.remove("hidden");
  setTimeout(() => inputEl.focus(), 50);
}

// ニックネーム未設定なら登録モーダルを自動で開く（生成ページの表示時など）。
// プロフィール取得に失敗した場合も安全側（未設定扱い）でモーダルを出す。
// 戻り値: モーダルを出したら true（設定済みなら false）。
export async function autoPromptNicknameRegistration() {
  let profile = null;
  try {
    profile = await fetchMyProfile();
  } catch {
    profile = null;
  }
  if (profile?.nickname) return false;
  openNicknameRegistrationModal();
  return true;
}
