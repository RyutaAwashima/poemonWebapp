// functions/api/_name-check.js
// アイモン名のサーバー側バリデーション（NGワード・版権名）。
// クライアント側（app/name-filter.js）と同じ JSON（app/data/ng-words-ja.json /
// app/data/blocked-brand-names.json）を同一オリジンから読み、同じ正規化
// （NFKC + 小文字化 + カタカナ→ひらがな + 空白除去）で部分一致チェックする。
// feed.js と同じ方式（module スコープでキャッシュ・失敗時は空リストフォールバック）。
// 決定論ロジックは含まない（純粋な名前検証のみ）。

import { normalizeNickname } from "./_users.js";

export const NAME_REJECT_MESSAGES = {
  ng: "使用できない単語が含まれています。別の名前を入力してください。",
  brand: "その名前は使用できません（既存の作品・キャラクター名は使えません）。別の名前を入力してください。",
  nicol: "不思議な力でその名前はかき消された、、",
};

// 「ニコル」フェイクエラー（docs/HIDDEN_AIMON_SPEC.md §2.6）。
// 肩書き部分ではなく固有名詞「ニコル」自体のみ判定する。正規化後の比較なので表記揺れ（カタカナ/ひらがな等）を吸収する。
const NICOL_WORD = normalizeNickname("ニコル");

let cachedNgWords = null;
let cachedBrandWords = null;

// NGワード／版権名リストを読み込む（origin から）。失敗時は空リスト（正当な名前を阻害しない）。
async function loadWordLists(origin) {
  if (cachedNgWords && cachedBrandWords) return { ng: cachedNgWords, brand: cachedBrandWords };
  try {
    const [ngRes, brandRes] = await Promise.all([
      fetch(`${origin}/app/data/ng-words-ja.json`),
      fetch(`${origin}/app/data/blocked-brand-names.json`),
    ]);
    const ng = ngRes.ok ? await ngRes.json() : { words: [] };
    const brand = brandRes.ok ? await brandRes.json() : { words: [] };
    cachedNgWords = (ng.words || []).map(normalizeNickname).filter(Boolean);
    cachedBrandWords = (brand.words || []).map(normalizeNickname).filter(Boolean);
  } catch {
    cachedNgWords = cachedNgWords || [];
    cachedBrandWords = cachedBrandWords || [];
  }
  return { ng: cachedNgWords, brand: cachedBrandWords };
}

// 名前を検証する（クライアント name-filter.js の checkMonsterName と同一仕様）。
// origin: ワードリストを取得する同一オリジン（例: new URL(request.url).origin）。
// 問題なければ { ok: true }、引っかかった場合は { ok: false, reason: "ng" | "brand" }。
export async function checkMonsterNameServer(rawName, origin) {
  const name = normalizeNickname(rawName);
  if (!name) return { ok: true };
  if (NICOL_WORD && name.includes(NICOL_WORD)) {
    return { ok: false, reason: "nicol" };
  }
  const { ng, brand } = await loadWordLists(origin);
  if (ng.some((w) => w && name.includes(w))) {
    return { ok: false, reason: "ng" };
  }
  if (brand.some((w) => w && name.includes(w))) {
    return { ok: false, reason: "brand" };
  }
  return { ok: true };
}
