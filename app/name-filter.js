// アイモン名バリデーション用のNGワード・版権名フィルタ、および
// 個人の実名らしき入力を検知する警告用ヒューリスティック。
// データは app/data/ng-words-ja.json（不適切語）、
// app/data/blocked-brand-names.json（版権キャラクター名等）、
// app/data/common-surnames-ja.json（よくある苗字。実名検知の警告に使用）から読み込む。
// NGワード/版権名は部分一致(includes)で判定し、ひらがな/カタカナ・全角半角・大文字小文字の
// 揺れを吸収するため正規化してから比較する。

let cachedLists = null;

// 「ニコル」フェイクエラー（docs/HIDDEN_AIMON_SPEC.md §2.6）。サーバー _name-check.js と同一の判定文字列。
const NICOL_WORD = normalizeForMatch("ニコル");

async function loadJson(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NGワードリストの読み込みに失敗しました: ${relativePath}`);
  return res.json();
}

async function loadWordLists() {
  if (cachedLists) return cachedLists;
  const [ngData, brandData, surnameData] = await Promise.all([
    loadJson("./data/ng-words-ja.json"),
    loadJson("./data/blocked-brand-names.json"),
    loadJson("./data/common-surnames-ja.json"),
  ]);
  cachedLists = {
    ngWords: (ngData.words || []).map(normalizeForMatch),
    brandNames: (brandData.words || []).map(normalizeForMatch),
    surnames: surnameData.surnames || [],
  };
  return cachedLists;
}

// カタカナ→ひらがな変換（ひらがな入力・カタカナ入力どちらでも一致させるため）。
function katakanaToHiragana(str) {
  return str.replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

function normalizeForMatch(str) {
  return katakanaToHiragana(
    String(str)
      .normalize("NFKC") // 全角英数・記号を半角に統一
      .toLowerCase()
      .replace(/[\s\u3000]/g, "") // 半角/全角スペース除去
  );
}

// 名前を検証する。問題なければ { ok: true } を、
// 引っかかった場合は { ok: false, reason: "ng" | "brand" | "nicol" } を返す。
export async function checkMonsterName(rawName) {
  const name = normalizeForMatch(rawName);
  if (!name) return { ok: true };
  if (NICOL_WORD && name.includes(NICOL_WORD)) {
    return { ok: false, reason: "nicol" };
  }
  const { ngWords, brandNames } = await loadWordLists();
  if (ngWords.some((w) => w && name.includes(w))) {
    return { ok: false, reason: "ng" };
  }
  if (brandNames.some((w) => w && name.includes(w))) {
    return { ok: false, reason: "brand" };
  }
  return { ok: true };
}

export const NAME_REJECT_MESSAGES = {
  ng: "使用できない単語が含まれています。別の名前を入力してください。",
  brand: "その名前は使用できません（既存の作品・キャラクター名は使えません）。別の名前を入力してください。",
  nicol: "不思議な力でその名前はかき消された、、",
};

// 漢字のみで構成された文字列か判定（全角カタカナ・ひらがな・英数字は含まない）。
function isKanjiOnly(str) {
  return /^[\u4E00-\u9FFF\u3400-\u4DBF]+$/.test(str);
}

// 個人の実名らしき入力かどうかを判定するヒューリスティック（あくまで警告用・非ブロック）。
// 「よくある苗字」で始まり、続けて1〜3文字の漢字が続く場合（例: 田中太郎）に真とする。
// フルネーム以外の誤検知を避けるため、苗字のみの一致（例: 単に「田中」）では警告しない。
export async function looksLikePersonalName(rawName) {
  const name = String(rawName).normalize("NFKC").replace(/[\s\u3000]/g, "");
  if (!name || !isKanjiOnly(name) || name.length < 3 || name.length > 6) return { matched: false };
  const { surnames } = await loadWordLists();
  const hit = surnames.find((s) => name.startsWith(s) && name.length > s.length);
  if (!hit) return { matched: false };
  return { matched: true, surname: hit };
}

export const PERSONAL_NAME_WARNING =
  "本名らしき名前が入力されています。個人情報保護のため、ニックネームなど本名以外の名前の使用をおすすめします。このまま進めますか？";
