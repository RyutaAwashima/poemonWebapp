// app/login.js
// メール/パスワードでのログイン（既存アカウントで別端末から続ける）。
// ログイン成功後、ローカルに退避されていたコレクションをアカウントへマージしてから
// returnTo（またはホーム）へ遷移する。

import { getFirebaseApp } from "./firebase-app.js";
import { getAuth, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { mergeLocalCollection } from "./api-client.js";
import { attachButtonHaptics, confirmHaptic } from "./haptics.js";

const $ = (id) => document.getElementById(id);

const LOGIN_ERROR_MESSAGES = {
  "auth/invalid-email": "メールアドレスの形式が正しくありません",
  "auth/user-disabled": "このアカウントは利用停止されています",
  "auth/user-not-found": "このメールアドレスは登録されていません",
  "auth/wrong-password": "パスワードが正しくありません",
  "auth/invalid-credential": "メールアドレスまたはパスワードが正しくありません",
  "auth/too-many-requests": "試行回数が多すぎます。しばらく待ってから再試行してください",
  "auth/operation-not-allowed": "メール/パスワードログインが現在無効です（運営にお問い合わせください）",
  "auth/network-request-failed": "通信に失敗しました。ネットワークを確認してください",
};

function show(text, type) {
  const el = $("login-status");
  el.textContent = text;
  el.className = "save-status" + (type ? " " + type : "") + (text ? "" : " hidden");
}

// 同オリジンの相対パスだけ許可（外部URLや // への誘導を防ぐ）。
function safeReturnTo(raw) {
  if (!raw) return "./";
  if (raw.startsWith("//")) return "./";
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "./";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  if (raw.startsWith("./") || raw.startsWith("../")) return raw;
  return "./";
}

attachButtonHaptics();

async function doLogin() {
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  if (!email || !password) {
    show("⚠️ メールアドレスとパスワードを入力してください", "err");
    return;
  }

  const btn = $("btn-login");
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "ログイン中...";
  try {
    const auth = getAuth(getFirebaseApp());
    await signInWithEmailAndPassword(auth, email, password);
    // 匿名プレイ中にローカルへ退避されていたアイモンをアカウントへ引き継ぐ（無ければ何もしない）。
    await mergeLocalCollection();
    confirmHaptic();
    const params = new URLSearchParams(window.location.search);
    window.location.href = safeReturnTo(params.get("returnTo"));
  } catch (err) {
    show(`❌ ${LOGIN_ERROR_MESSAGES[err?.code] || err?.message || "ログインに失敗しました"}`, "err");
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

$("btn-login").addEventListener("click", doLogin);
$("login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});
