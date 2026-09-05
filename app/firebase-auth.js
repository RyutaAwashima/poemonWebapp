// Firebase Authentication helper shared by every page that talks to
// Realtime Database. Wraps anonymous sign-in so callers only need to
// `await ensureSignedIn(app)` and then read `auth.currentUser.uid`.
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';

/**
 * Signs the current browser session in anonymously (if not already
 * signed in) and resolves once a Firebase user is confirmed.
 * Safe to call multiple times; Firebase persists the anonymous
 * session across reloads, so repeat calls resolve immediately.
 *
 * @param {import('firebase/app').FirebaseApp} app
 * @returns {Promise<{auth: import('firebase/auth').Auth, uid: string}>}
 */
export function ensureSignedIn(app) {
  const auth = getAuth(app);
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsubscribe();
        resolve({ auth, uid: user.uid });
        return;
      }
      // 未ログイン（匿名セッションも無い）のときだけ匿名サインインを試行する。
      // 既存ユーザー（メールログイン済み等）が居る状態で signInAnonymously を
      // 呼ぶと、そのセッションが匿名アカウントに置き換わってしまうため。
      signInAnonymously(auth).catch((err) => {
        unsubscribe();
        reject(err);
      });
    }, reject);
  });
}
