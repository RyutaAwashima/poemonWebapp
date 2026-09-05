// 全ページで共有する Firebase App の初期化と、API 呼び出し用 ID token 取得ヘルパー。
// 初回アクセス時に遅延初期化し、匿名サインイン完了後にフレッシュなトークンを返す。
// メインページ（index / generate / party 等）はこれ経由で /api/* を呼ぶ。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signOut } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { FIREBASE_CONFIG } from './firebase-config.js';
import { ensureSignedIn } from './firebase-auth.js';

let _app = null;
let _authPromise = null;

export function getFirebaseApp() {
  if (!_app) {
    _app = initializeApp(FIREBASE_CONFIG);
  }
  return _app;
}

// 匿名サインインを一度だけ実行し、確実にログイン済みにする（複数回呼んでも安全）。
export function ensureAuth() {
  if (!_authPromise) {
    _authPromise = ensureSignedIn(getFirebaseApp());
  }
  return _authPromise;
}

// API 呼び出し用にフレッシュな ID token を返す（有効期限が近いと自動更新される）。
export async function getIdTokenForApi() {
  const { auth } = await ensureAuth();
  return auth.currentUser.getIdToken();
}

// サインアウトして、次回 ensureAuth() で新規匿名セッションを作り直せるようにする。
// ログアウト後に呼ぶこと。ローカル退避コレクションのクリアは呼び出し側で行う。
export async function signOutAndReset() {
  const auth = getAuth(getFirebaseApp());
  await signOut(auth).catch(() => {});
  _authPromise = null;
}
