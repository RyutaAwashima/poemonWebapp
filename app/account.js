// app/account.js
// 匿名 → メールアカウント登録（Firebase linkWithCredential）と規約同意の記録をまとめる。
// 登録後も uid は変わらないため、コレクション・ニックネーム・発見記録はそのまま引き継がれる。

import {
  getAuth,
  linkWithCredential,
  EmailAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirebaseApp, ensureAuth } from "./firebase-app.js";
import { registerAccount as recordAccountAgreement } from "./api-client.js";

// Firebase のエラーコード → ユーザー向けメッセージ。
const EMAIL_ERROR_MESSAGES = {
  "auth/invalid-email": "メールアドレスの形式が正しくありません",
  "auth/missing-password": "パスワードを入力してください",
  "auth/weak-password": "パスワードは8文字以上にしてください",
  "auth/email-already-in-use": "このメールアドレスは既に別のアカウントで使用されています",
  "auth/credential-already-in-use": "このメールアドレスは既に別のアカウントで使用されています",
  "auth/operation-not-allowed": "メール/パスワード登録が現在無効です（運営にお問い合わせください）",
  "auth/network-request-failed": "通信に失敗しました。ネットワークを確認してください",
};

function emailErrorMessage(err) {
  return EMAIL_ERROR_MESSAGES[err?.code] || err?.message || "登録に失敗しました";
}

// 匿名ユーザーにメール/パスワードをリンクし、サーバーへ規約同意を記録する。
// 成功時: { status: "ok", email }。失敗時: { status: "error", message } を返す（throw しない）。
export async function registerAccount({ email, password, agreed, newsletter }) {
  if (!email || !password) {
    return { status: "error", message: "メールアドレスとパスワードを入力してください" };
  }
  if (!agreed) {
    return { status: "error", message: "利用規約・プライバシーポリシーへの同意が必要です" };
  }

  try {
    await ensureAuth(); // 匿名サインイン済みにする
    const auth = getAuth(getFirebaseApp());
    const credential = EmailAuthProvider.credential(email.trim(), password);
    await linkWithCredential(auth.currentUser, credential);
  } catch (err) {
    // 既にこのメールにリンク済みならリンクは不要（サーバー記録へ進む）。
    if (err?.code !== "auth/provider-already-linked") {
      return { status: "error", message: emailErrorMessage(err) };
    }
  }

  try {
    const data = await recordAccountAgreement({ agreed: true, newsletter: !!newsletter });
    return { status: "ok", email: data.email || email.trim() };
  } catch (err) {
    return { status: "error", message: err.message || "アカウントの記録に失敗しました" };
  }
}
