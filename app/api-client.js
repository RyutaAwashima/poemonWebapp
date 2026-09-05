import { getIdTokenForApi } from "./firebase-app.js";

const UUID_KEY = "aimon_player_uuid";
const LOCAL_KEY = "aimon_collection_local";
const MIGRATED_KEY = "aimon_uuid_migrated";

function getOrCreateUUID() {
  let uuid = localStorage.getItem(UUID_KEY);
  if (!uuid) {
    uuid = crypto.randomUUID();
    localStorage.setItem(UUID_KEY, uuid);
  }
  return uuid;
}

export function getPlayerUUID() {
  return getOrCreateUUID();
}

function localLoad() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []; } catch { return []; }
}

function localSave(aimons) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(aimons));
}

// ローカル退避コレクションをクリアする（ログアウト時など）。
// 注意: 旧 uuid（UUID_KEY / MIGRATED_KEY）は消さない。消すと新規匿名セッションが
// 旧データを migrateFrom で引き継いでしまうため。
export function clearLocalCollection() {
  localStorage.removeItem(LOCAL_KEY);
}

// ローカル退避分をアカウント（サーバー）へマージする。初回登録・ログイン時に呼ぶ。
// マージ成功分・重複分はローカルから消し、上限超過で入らなかった分だけローカルに残す。
// 冪等: ローカルが空なら何もしない。失敗時もローカルは保持（次回リトライ可能）。
export async function mergeLocalCollection() {
  const local = localLoad();
  if (!local.length) return { merged: 0, full: 0 };
  try {
    const token = await getIdTokenForApi();
    const res = await fetch("/api/aimons/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ aimons: local }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "merge failed");
    localSave(Array.isArray(data.leftover) ? data.leftover : []);
    return { merged: data.added || 0, full: data.full || 0 };
  } catch {
    return { merged: 0, full: 0 };
  }
}

// /api/aimons を認証付きで呼ぶ。旧版の localStorage uuid があれば一回だけ migrateFrom を送る。
// サーバー側で aimons:{uid} への移行が成功すると MIGRATED_KEY を立て、以後は送らない。
async function apiFetch(path, options = {}) {
  const token = await getIdTokenForApi();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  const oldUuid = localStorage.getItem(UUID_KEY);
  const sep = path.includes("?") ? "&" : "?";
  const migrate =
    oldUuid && !localStorage.getItem(MIGRATED_KEY)
      ? `${sep}migrateFrom=${encodeURIComponent(oldUuid)}`
      : "";
  const res = await fetch(`/api/aimons${path}${migrate}`, { ...options, headers });
  if (res.ok) localStorage.setItem(MIGRATED_KEY, "1");
  return res;
}

export async function fetchAimons() {
  try {
    const res = await apiFetch("");
    if (!res.ok) throw new Error("api error");
    const data = await res.json();
    return { aimons: data.aimons, source: "kv" };
  } catch {
    return { aimons: localLoad(), source: "local" };
  }
}

export async function saveAimon(aimon) {
  try {
    const res = await apiFetch("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aimon }),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || "save failed"), { status: res.status });
    return { ...data, source: "kv" };
  } catch (e) {
    // Re-throw business-logic errors from the API (already saved, full, invalid)
    if (e.status === 409 || e.status === 400) throw e;
    // Network / deployment not ready → fall back to localStorage
    const stored = localLoad();
    if (stored.length >= 30) throw new Error("collection full (max 30)");
    if (stored.find((a) => a.id === aimon.id)) throw new Error("already saved");
    stored.push({ ...aimon, savedAt: new Date().toISOString() });
    localSave(stored);
    return { aimon, total: stored.length, source: "local" };
  }
}

export async function deleteAimon(aimonId) {
  try {
    const res = await apiFetch(`?id=${encodeURIComponent(aimonId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error("delete failed");
    return { ...(await res.json()), source: "kv" };
  } catch {
    const stored = localLoad();
    const filtered = stored.filter((a) => a.id !== aimonId);
    localSave(filtered);
    return { removed: stored.length - filtered.length, source: "local" };
  }
}

// ── ユーザー（ニックネーム）API ──────────────────────────────
async function usersFetch(path, options = {}) {
  const token = await getIdTokenForApi();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(`/api/users${path}`, { ...options, headers });
}

// 自分のプロフィールを取得する。ニックネーム未設定なら nickname: null。
// 注: GET /api/users を呼ぶ。Pages Functions のファイルベースルーティングでは
// functions/api/users.js は /api/users にしか一致しないため、/api/users/me は使わない
// （/me は SPA フォールバックで index.html が返り、常に「未設定」と誤判定される）。
export async function fetchMyProfile() {
  const res = await usersFetch("");
  if (!res.ok) throw new Error("profile api error");
  // ルーティング失敗時（HTML フォールバック）を「未設定」と誤判定しないよう、JSON 以外は弾く。
  const type = res.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error("profile api unavailable");
  return res.json();
}

// ニックネームを登録／変更する（サーバー側で30日クールダウン強制）。
// 失敗時は { status, error } を持つ Error を投げる（429 = クールダウン中）。
export async function updateMyProfile(nickname) {
  const res = await usersFetch("", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "nickname update failed"), { status: res.status });
  }
  return data;
}

// メール登録（Firebase linkWithCredential）後に、トークン上の email と規約同意をサーバーに記録する。
// email は本文ではなく ID token の claim から取られるため、この API は同意フラグと
// キャンペーンメール希望のみ受け取る。
export async function registerAccount({ agreed, newsletter }) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/users/account", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ agreed: !!agreed, newsletter: !!newsletter }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "account registration failed"), { status: res.status });
  }
  return data;
}

// キャンペーンメール希望の変更（登録後の解除・再開）。POST /api/users/account を
// newsletter のみで呼ぶ（再同意不要・登録済みユーザー限定）。
export async function updateNewsletter({ newsletter }) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/users/account", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ newsletter: !!newsletter }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "newsletter update failed"), { status: res.status });
  }
  return data;
}

// ── クレジット（M2 Phase 1）API ────────────────────────────
// クレジット残高とデイリー受取可否を取得する。
// 成功時は { credits, daily: { grant, claimable } } を返す。
export async function fetchCredits() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/credits", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("credits api error");
  return res.json();
}

// 自分のクレジット獲得・消費履歴を取得する（P8）。{ history: [...] }。
// 各要素: { delta, reason, ref, pack, yen, note, createdAt }。
export async function fetchCreditHistory() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/credits/history", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "credit history api error");
  return data;
}

// コレクションを +3枠 拡張する（3クレジット・最大99枠・画像API不使用のクレジット消費施策）。
// 成功時は { credits, collectionLimit, added } を返す。不足なら status 403 の Error を投げる。
export async function expandCollection() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/collection/expand", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || data.error || "expand failed"), {
      status: res.status,
    });
  }
  return data;
}

// ── 育成アイテム・育成（Phase B）API ────────────────────────
// 伝承の巻物を1枚購入（月20枚・1〜10枚目20クレ/11〜20枚目40クレ）。
// 成功時は { item, price, credits, scrolls, purchased, limit } を返す。
export async function buyScroll() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/shop/scroll", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "scroll purchase failed"), { status: res.status });
  }
  return data;
}

// 願いの雫を1枚購入（月30枚・1〜15枚目10クレ/16〜30枚目20クレ）。
// 成功時は { item, price, credits, wishes, purchased, limit } を返す。
export async function buyWish() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/shop/wish", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "wish purchase failed"), { status: res.status });
  }
  return data;
}

// スロットを1つ解放（伝承の巻物1枚消費）。レア4は最初から1スロ解放のため不要な場合あり。
// 成功時は { ok, aimon } を返す。巻物不足なら status 403 の Error を投げる。
export async function unlockSlot(monsterId) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/monster/unlock-slot", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ monsterId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "unlock slot failed"), { status: res.status });
  }
  return data;
}

// 育成実行（願いの力＝スロット抽選）。5レベル消費して二つ名 text をスロットへ確定し、
// 効果をサーバーが再計算する。成功時は { ok, effect, level, aimon } を返す。
// レベル不足なら status 403 の Error を投げる。
export async function trainMonster({ monsterId, slotIdx, text }) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/monster/train", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ monsterId, slotIdx, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "train failed"), { status: res.status });
  }
  return data;
}

// 願いの雫1個を消費して、アイモンにXP100（=レベル+10）を付与する（育成システム再設計）。
// レベル上限(99)到達後のあぶれXPは願いのカケラに1:1変換される。
// 成功時は { ok, level, xp, masterpiece, overflowFragments, fragments, wishes, aimon } を返す。
export async function wishLevelAimon(monsterId) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/monster/wish-level", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ monsterId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "wish level failed"), { status: res.status });
  }
  return data;
}

// 対人戦（通信・ルーム戦）のバトルXPを、使用したアイモンへ付与する。
// source="pvp" で基礎XP20付与（CPU対戦XPは現行実装では見送り）。
// 成功時は { ok, source, xp, granted, overflowFragments, leveledUpCount, reachedMaxCount } を返す。
export async function reportBattleXp({ monsterIds, source = "pvp" }) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/monster/xp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ monsterIds, source }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "battle xp failed"), { status: res.status });
  }
  return data;
}

// 願いのカケラ100個を願いの雫1個に交換する（amount 枚、省略時1枚・最大10枚）。
// 成功時は { ok, item, exchanged, cost, fragments, wishes } を返す。不足なら status 403 の Error。
export async function exchangeFragments({ amount = 1 } = {}) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/shop/exchange", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "exchange failed"), { status: res.status });
  }
  return data;
}

// ── 生成中断検知・再開（2026-08-22） ──────────────────────
// charge.js で所有権を先に保存した後、monster-image.js 実行前にブラウザがクラッシュすると
// コレクション内に imageUrl: null のエントリが残る。それを検知し、無料で再開する。

// 画像生成が中断されたメイモン一覧を取得する。{ interrupted: [{id, name, rarity}, ...] }。
export async function fetchInterruptedAimons() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/monster/resume", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "resume check failed");
  return data;
}

// 指定IDの画像生成を無料で再開する。成功時は { ok, aimon, url }。
export async function resumeMonsterImage(monsterId) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/monster/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: monsterId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "resume failed"), { status: res.status });
  }
  return data;
}

// デイリーログインボーナスを受け取る（1日1回・冪等）。
// 成功時は { granted, credits, daily: { grant, claimable:false } } を返す。
// 受取済みなら status: 409 の Error を投げる。
export async function claimDailyCredits() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/credits/daily", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || data.message || "daily claim failed"), {
      status: res.status,
    });
  }
  return data;
}

// 対戦ボーナスを受け取る（1日1回・冪等）。CPU対戦・通信対戦どちらでもOK。
// 成功時は { granted, credits, battle: { grant, claimable:false } } を返す。
// 受取済みなら status: 409 の Error を投げる。
export async function claimBattleBonus() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/credits/battle", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || data.message || "battle bonus claim failed"), {
      status: res.status,
    });
  }
  return data;
}

// キャンペーンコードでクレジットを受け取る（検証・キャンペーン用）。
// 成功時は { granted, credits, code } を返す。エラー時は status 付き Error を投げる
// （404 invalid_code / 410 code_exhausted / 409 already_redeemed / 400 未入力）。
export async function redeemCampaignCode(code) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/credits/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || data.error || "redeem failed"), {
      status: res.status,
      code: data.error,
    });
  }
  return data;
}

// ── キャンペーンコード管理（開発者/管理者のみ） ──────────
// 全コード一覧（利用状況つき）。
export async function fetchAdminCodes() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/admin/codes", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "admin codes fetch failed"), { status: res.status });
  return data;
}

// 個別コードの利用状況（誰が・いつ使用したか）。
export async function fetchAdminCodeDetail(code) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/admin/codes/${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "admin code detail failed"), { status: res.status });
  return data;
}

// コード発行（単一 or 使い捨て一括）。payload: { kind, credits, code?, maxUses?, count?, startsAt?, expiresAt?, note? }
export async function createAdminCodes(payload) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/admin/codes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "admin code create failed"), { status: res.status });
  return data;
}

// ── イベント会場用QRカード管理（開発者/管理者のみ） ──────────
// カード一覧。利用状況つき。
export async function fetchAdminCards() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/admin/cards", { headers: { Authorization: `Bearer ${token}` } });
  const data = res.headers.get("content-type")?.includes("application/json") ? await res.json() : {};
  if (!res.ok) throw Object.assign(new Error(data.error || "admin cards fetch failed"), { status: res.status });
  return data;
}

// 特定カードの詳細（利用者情報付き）。
export async function fetchAdminCardDetail(token) {
  const idToken = await getIdTokenForApi();
  const res = await fetch(`/api/admin/cards?token=${encodeURIComponent(token)}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const data = res.headers.get("content-type")?.includes("application/json") ? await res.json() : {};
  if (!res.ok) throw Object.assign(new Error(data.error || "admin card detail failed"), { status: res.status });
  return data;
}

// カード一括発行。payload: { credits, priceYen?, count, prefix?, startsAt?, expiresAt?, note? }
export async function createAdminCards(payload) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/admin/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "admin card create failed"), { status: res.status });
  return data;
}

// ── お知らせ管理（開発者/管理者のみ） ────────────────────
// お知らせ一覧。開発者/管理者は下書きも含めて全件、それ以外は公開済みのみ返る。
export async function fetchAnnouncements() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/announcements", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "announcements fetch failed"), { status: res.status });
  return data;
}

// お知らせを作成する。payload: { title, body, publish? }（publish:false なら下書き保存）
export async function createAnnouncement(payload) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/announcements", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "announcement create failed"), { status: res.status });
  return data;
}

// 下書きお知らせを公開する。
export async function publishAnnouncement(id) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/announcements/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "announcement publish failed"), { status: res.status });
  return data;
}

// 配信キューの状態サマリー（pending/sent/failed/skipped の件数）。
export async function fetchNewsletterSummary() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/newsletter", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "newsletter summary failed"), { status: res.status });
  return data;
}

// 公開済みお知らせを配信キューへ投入する（省略時は最新の公開済みお知らせが対象）。
export async function dispatchNewsletter(announcementId) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/newsletter", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(announcementId ? { announcementId } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "newsletter dispatch failed"), { status: res.status });
  return data;
}

// ── クレジット経済モニタリング（開発者/管理者のみ） ──────
// reason 別の発行/消費集計 + 現在の総残高（キャンペーンコードの利用状況と合わせて確認する）。
export async function fetchAdminCreditStats() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/admin/credit-stats", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "credit stats fetch failed"), { status: res.status });
  return data;
}

// ── 売上ダッシュボード（準備中） ──────────────────────────
// バックエンドのパイプのみ用意（KPI未確定のためフロントUIは今後実装予定）。
export async function fetchAdminSales() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/admin/sales", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "sales fetch failed"), { status: res.status });
  return data;
}

// ── ユーザー管理（開発者/管理者のみ） ────────────────────
// ユーザー検索（email/ニックネーム/UID 部分一致・q省略時は新しい順一覧）。
export async function searchAdminUsers(q) {
  const token = await getIdTokenForApi();
  const url = q ? `/api/admin/users?q=${encodeURIComponent(q)}` : "/api/admin/users";
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "user search failed"), { status: res.status });
  return data;
}

// ユーザー詳細（プロフィール + クレジット履歴）。
export async function fetchAdminUserDetail(uid) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/admin/users/${encodeURIComponent(uid)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "user detail fetch failed"), { status: res.status });
  return data;
}

// 役割変更・アカウントロック/解除。payload: { role? } と/または { locked, reason? }
export async function updateAdminUser(uid, payload) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/admin/users/${encodeURIComponent(uid)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "user update failed"), { status: res.status });
  return data;
}

// クレジット手動調整。payload: { delta, reason }（reason は監査ログに必須で記録される）
export async function adjustAdminUserCredits(uid, payload) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/admin/users/${encodeURIComponent(uid)}/credits`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "credit adjust failed"), { status: res.status });
  return data;
}

// 個別メッセージ送信。payload: { title, body }
export async function sendAdminUserMessage(uid, payload) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/admin/users/${encodeURIComponent(uid)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "message send failed"), { status: res.status });
  return data;
}

// ── 個別メッセージ（本人向け・ダッシュボード表示用） ──────
export async function fetchMyMessages() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/messages", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "messages fetch failed"), { status: res.status });
  return data;
}

export async function markMessageRead(id) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "message read failed"), { status: res.status });
  return data;
}

// ── ランクマッチ（宝石ランク帯・BO1のみ対象） ──────────────
// 自分のランク帯状態を取得する（tier/group/lp/昇格戦/ダイヤモンドpt等）。
export async function fetchMyRank() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/rank", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "rank fetch failed"), { status: res.status });
  return data;
}

// 対戦結果を報告してランクを更新する。payload: { matchRef, opponentUid, result }
// 二重報告時は 409 already_reported を投げる。
export async function reportRankResult(payload) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/rank/report", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "rank report failed"), {
      status: res.status,
      rating: data.rating,
      delta: data.delta,
    });
  }
  return data;
}

// 相手切断による不戦勝を報告する（ランクマッチのみ）。
// サーバーが RTDB で相手の切断を確認（猶予60秒経過）してから精算する。
// payload: { roomId, matchRef, opponentUid }
export async function reportForfeit(payload) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/rank/forfeit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "rank forfeit failed"), { status: res.status });
  }
  return data;
}

// 昇格後（ランクII〜VI到達時）にグループ（2択）を確定する。payload: { group }
export async function chooseRankGroup(group) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/rank/choose-group", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ group }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "choose group failed"), { status: res.status });
  return data;
}

// ダイヤモンド帯のリアルタイム公開リーダーボード（認証不要）。
export async function fetchDiamondLeaderboard() {
  const res = await fetch("/api/rank/diamond-leaderboard");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "leaderboard fetch failed"), { status: res.status });
  return data;
}

// プレイヤーの他ユーザーにも見えるプロフィール画像（アバター）URLを組み立てる（認証不要・GET）。
// 未生成の場合は404になるため、呼び出し側はエラー時にプレースホルダーを表示する。
export function profileImageUrl(uid) {
  return `/api/profile-image?uid=${encodeURIComponent(uid)}`;
}

// 自分のプロフィール画像を生成/再生成する（初回は無料・2回目以降は5クレジット消費）。
// payload: { styleKey, extraPrompt }。成功時は { url, source, free } を返す。
export async function generateProfileImage({ styleKey, extraPrompt }) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/profile-image", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ styleKey, extraPrompt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || data.error || "profile image generation failed"), {
      status: res.status,
      code: data.error || "error",
    });
  }
  return data;
}

// 対戦相手など、他ユーザーのニックネーム・ランク帯を取得する（VSマッチカード用）。
// 戻り値: { nickname, rankTier, rankGroup, groupName, rankLp, subRank, diamondRating }
export async function fetchPublicProfile(uid) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/public-profile?uid=${encodeURIComponent(uid)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "public profile fetch failed"), { status: res.status });
  return data;
}



// クレジットパック購入の Checkout セッションを作成する。
// 成功時は { url, sessionId, pack } を返す（呼び出し側は url へリダイレクト）。
// 登録前（email 未設定）なら status:403 / code:"registration_required" の Error を投げる。
export async function createCheckoutSession(packId) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/stripe/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ packId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || data.message || "checkout failed"), {
      status: res.status,
      code: data.code,
    });
  }
  return data;
}

// 年齢区分（未成年購入制限）を登録する（当月有効・翌月リセット）。
// 成功時は { ok, ageTier } を返す。未成年区分は親権者同意が必須。
// 同意なしは status:400 / code:"guardian_consent_required" の Error を投げる。
export async function saveAgeTier({ tier, guardianConsent = false }) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/age-tier", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tier, guardianConsent }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || data.message || "age tier save failed"), {
      status: res.status,
      code: data.code,
    });
  }
  return data;
}

// 個別メイモンのスキル名・フレーバーをAIで再生成する（1クレジット消費）。
// POST /api/monster/skill-flavor { monsterId } → { skill, credits }
export async function regenerateSingleFlavor(monsterId) {
  try {
    const token = await getIdTokenForApi();
    const res = await fetch("/api/monster/skill-flavor", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ monsterId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.message || data.error || "flavor regeneration failed"), {
        status: res.status,
        code: data.error || "error",
      });
    }
    return await res.json();
  } catch (e) {
    if (e && e.status) throw e;
    return null;
  }
}

// ── アイモン生成（対策1: サーバー側で決定論的に生成・クライアントにRNGなし） ──
// POST /api/monster/generate { name } → { aimon }
// サーバーで生成された正のカード情報（id/レアリティ/ステータス/スキル/世界観）を返す。
// 同じ名前は常に同じ結果（決定論）のため名前単位でキャッシュする（フィード連打対策）。
// 429（レート制限）や 400（NG名など）は status 付き Error を投げる。
const _generateCache = new Map();
export async function generateMonster(name) {
  const key = String(name || "").trim();
  if (_generateCache.has(key)) {
    // 呼び出し側が imageUrl 等を書き換えてもキャッシュを汚さないよう、浅いコピーを返す。
    return { ..._generateCache.get(key) };
  }
  const token = await getIdTokenForApi();
  const res = await fetch("/api/monster/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: key }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || data.error || "generate api error"), {
      status: res.status,
      code: data.error || "generate_error",
    });
  }
  if (!data.aimon) throw new Error("generate api error");
  _generateCache.set(key, data.aimon);
  return { ...data.aimon };
}

// ── 願いの洞窟のプレビュー（対策3: サーバー側で抽選結果を返す） ──
// POST /api/monster/preview { monsterIds, text } → { results: [{ monsterId, id, label }] }
// スロット効果の抽選ロジックはサーバーにのみ存在する（クライアントで最良ワードの試算不可）。
export async function previewSlotEffects({ monsterIds, text }) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/monster/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ monsterIds, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || data.error || "preview api error"), {
      status: res.status,
      code: data.error || "preview_error",
    });
  }
  return Array.isArray(data.results) ? data.results : [];
}

// アイモンのイラストをAIで自動生成し、R2に永続化した画像のURLを取得する（クレジット1枚消費）。
// 成功時は { url, origin, isNewDiscovery } を返す（origin は初発見者情報、isNewDiscovery は今回が初回発見か）。
// ネットワーク等の失敗時は null を返し、呼び出し側はプレースホルダー表示を維持する。
// ── 即引き落とし（Phase 2・リセマラ防止）────────────────
// 画像生成の前にクレジットを確実に消費する。戻り値は chargeId と cost。
// chargeId は fetchMonsterImage に渡す（二重課金防止）。owned=true なら chargeId=null（課金不要）。
export async function chargeMonster(name) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/monster/charge", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || data.error || "charge failed"), {
      status: res.status,
      code: data.error,
    });
  }
  return data; // { chargeId, cost, source, owned }
}

// サーバー側ゲート（ニックネーム未設定 / クレジット不足）の場合は status: 403 の Error を投げる。
// 同時実行中の場合は status: 429 の Error を投げる。
// Phase 2: chargeId を渡すとサーバー側で課金済み扱いになる（二重課金防止）。
export async function fetchMonsterImage(monster, { chargeId } = {}) {
  try {
    const token = await getIdTokenForApi();
    const res = await fetch("/api/monster-image", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        // 対策1: サーバーは名前から決定論的に再生成するため、名前だけ送ればよい。
        // ステータス等を送ってもサーバーは無視する（偽装無効）。
        name: monster.name,
        // Phase 2: chargeId が渡された場合はサーバー側で課金済み（二重課金防止）。
        ...(chargeId ? { chargeId } : {}),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        // nickname_required / insufficient_credits は UI で案内できるように code 付きで投げる。
        throw Object.assign(new Error(data.message || data.error || "forbidden"), {
          status: 403,
          code: data.error || "forbidden",
        });
      }
      if (res.status === 429) {
        throw Object.assign(new Error(data.message || data.error || "generation in progress"), {
          status: 429,
          code: data.error || "generation_in_progress",
        });
      }
      if (res.status === 400) {
        // collection_full などは code 付きで UI 案内できるようにする。
        throw Object.assign(new Error(data.message || data.error || "bad request"), {
          status: 400,
          code: data.error || "bad_request",
        });
      }
      throw new Error("monster-image api error");
    }
    const data = await res.json();
    return {
      url: data.url || null,
      origin: data.origin || null,
      isNewDiscovery: !!data.isNewDiscovery,
      // 生成（source: gemini/replicate-fallback）／ 召喚（summon）／ 自分の再呼び出し（cache）。
      source: data.source || null,
      cost: data.cost,
      acquired: !!data.acquired,
      owned: !!data.owned,
      // ワンストップ保存（M4）: 生成・召喚・再呼び出しすべてで自動保存後のコレクション数。
      collectionCount: data.collectionCount,
      // 召喚などで新規生成ボーナス（+2クレジット・1日1回）を得たか（M5）。
      bonusGranted: !!data.bonusGranted,
      // AIフレーバー反映済みの確定スキル（generate.jsが返した仮スキルを差し替えるために使う）。
      skill: data.skill || null,
    };
  } catch (e) {
    // サーバーが返したステータス付きエラー（403 ニックネーム/残高不足・429 生成中・400 コレクション満杯）は
    // UI で案内できるよう再スローする。それ以外（ネットワーク・500 等）は従来どおり null を返す。
    if (e?.status) throw e;
    return null;
  }
}

// ── 共有フィード（M3 / Phase 2）API ────────────────────────
async function feedFetch(path, options = {}) {
  const token = await getIdTokenForApi();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(`/api/feed${path}`, { ...options, headers });
}

// 共有フィードの投稿を取得する。成功時は { posts: [...] } を返す。
// sort: "popular"（直近24hのLike数順・デフォルト）| "latest"（新しい順）（M5）。
// filters: { rarity?: 1-4, element?: "炎"|"水"|... } — 絞り込みパラメータ（Phase A-2）。
// 各投稿は { id, nickname, monsterId, name, imageUrl, total, rarity, element, createdAt, isMine, likes, likedByMe, recentLikes, badges }。
export async function fetchFeed(sort = "popular", filters = {}) {
  const params = new URLSearchParams({ sort });
  if (filters.rarity) params.set("rarity", String(filters.rarity));
  if (filters.element) params.set("element", filters.element);
  const res = await feedFetch(`?${params}`);
  if (!res.ok) throw new Error("feed api error");
  return res.json();
}

// 自分のフィード投稿（共有済みアイモンのマーク用・M5）。{ posts: [{ id, monsterId }] }。
export async function fetchMyShared() {
  const res = await feedFetch("?mine=1");
  if (!res.ok) throw new Error("feed api error");
  return res.json();
}

// コレクション内アイモンを共有する（サーバー側でコレクションから正規情報を取得）。
// 成功時は { ok, bonusGranted, credits, post } を返す。
// 失敗時は { status, error, code } を持つ Error を投げる（400/403/429 等）。
export async function postFeed(monsterId) {
  const res = await feedFetch("", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ monsterId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || "share failed"), { status: res.status, code: data.code });
  }
  return data;
}

// 自分のフィード投稿を削除する（他人の投稿は 403）。
export async function deleteFeed(id) {
  const res = await feedFetch(`?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "delete failed");
  return data;
}

// 生成前の確認ダイアログ用: 対象アイモンの状態を確認する（M4 / 2026-08-07）。
// GET /api/monster-image?check=1&id= → { exists, owned, cost, collectionCount, collectionFull }
// exists=既に誰かが生成済み（＝召喚対象）/ owned=自分のコレクション所持 / cost=召喚コスト（祭中1）。
export async function fetchMonsterStatus(monster) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/monster-image?check=1&id=${encodeURIComponent(monster.id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.message || data.error || "status api error"), {
      status: res.status,
      code: data.error || "bad_request",
    });
  }
  return {
    exists: !!data.exists,
    owned: !!data.owned,
    cost: data.cost,
    collectionCount: data.collectionCount,
    collectionFull: !!data.collectionFull,
  };
}

// フィード投稿への Like をトグルする。成功時は { ok, liked, likes }。
export async function likeFeed(id) {
  const res = await feedFetch("/like", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "like failed"), { status: res.status });
  return data;
}

// フィード投稿を通報する（Phase A-3）。{ ok, reportCount }。
export async function reportFeed(id, reason = "") {
  const res = await feedFetch("/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, reason }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "report failed"), { status: res.status });
  return data;
}

// 自分の生成履歴（名前・レア度・種別）を取得する（M4）。{ history: [...] }。
export async function fetchHistory() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/history", { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "history api error");
  return data;
}

// ── 課金トラブル報告（ユーザー向け） ──────────────────────
// 問題を報告する。payload: { title?, body }。送信するとDiscordへ即時アラートされる。
export async function reportIssue({ title, body }) {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/report-issue", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "report failed"), { status: res.status });
  return data;
}

// ── 課金インシデント（開発者/管理者のみ） ──────────────────
export async function fetchAdminBillingIncidents(status = "open") {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/admin/billing-incidents?status=${encodeURIComponent(status)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "incidents fetch failed"), { status: res.status });
  return data;
}

export async function resolveAdminBillingIncident(id) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/admin/billing-incidents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "incident resolve failed"), { status: res.status });
  return data;
}

// ── フィード通報対応（開発者/管理者のみ） ───────────────────
export async function fetchAdminFeedReports() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/admin/feed-reports", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "feed reports fetch failed"), { status: res.status });
  return data;
}

export async function resolveAdminFeedReport(id, action) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/admin/feed-reports/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "feed report action failed"), { status: res.status });
  return data;
}

// ── X投稿候補（開発者/管理者のみ） ───────────────────────
export async function fetchAdminXCandidates() {
  const token = await getIdTokenForApi();
  const res = await fetch("/api/admin/x-candidates", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "x-candidates fetch failed"), { status: res.status });
  return data;
}

export async function resolveAdminXCandidate(id, action) {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/admin/x-candidates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "x-candidate action failed"), { status: res.status });
  return data;
}

// ── 画像生成統計（開発者/管理者のみ） ─────────────────────
export async function fetchAdminImageStats(period = "24h") {
  const token = await getIdTokenForApi();
  const res = await fetch(`/api/admin/image-stats?period=${encodeURIComponent(period)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "image stats fetch failed"), { status: res.status });
  return data;
}
