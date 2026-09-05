# ポエモン（Poemon）

**3才から遊べる、AIが毎日ポエムを書いてくれるお世話ゲーム**

- 基本無料・全機能アンロックは買い切り
- 子供は絵文字つきキーワードでお世話 → ポエモンがキーワードを覚えて毎日ポエムを書き綴る
- ママ・パパが読んで一緒に楽しめる
- タブレットメイン・URLで簡単共有・Xで広報

詳細コンセプト: [docs/CONCEPT.md](./docs/CONCEPT.md)

---

## 技術スタック（sangyoufare2026 からの雛形流用）

- Cloudflare Pages Functions + D1 + KV + R2
- Firebase Auth
- Vanilla JS
- AI: Gemini（画像生成・ポエム生成）

## 開発ロードマップ

- **Phase A**: MVP土台（認証 + 画像生成 + ハッシュ抽選 + 経済）
- **Phase B**: 育成込み（レベル/XP/スロット）
- **Phase C**: たまごっち完成品（時間経過 / 養育UI / LLM対話）

## セットアップ

（開発開始時に追記予定）