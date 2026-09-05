import { RARITY_BANDS } from "./aimon-core.js";
import {
  generateMonster,
  fetchMonsterImage,
  fetchMonsterStatus,
  fetchMyProfile,
  fetchCredits,
  postFeed,
  chargeMonster,
} from "./api-client.js";
import { buildAimonCardElement, downloadCardAsPng, exportCardForPrint } from "./card-render.js";
import { openCardZoomViewer, closeZoomViewerWithoutRestore } from "./card-zoom.js";
import { attachButtonHaptics, confirmHaptic } from "./haptics.js";
import { looksLikePersonalName, PERSONAL_NAME_WARNING } from "./name-filter.js";
import { showBonusDialog } from "./bonus-dialog.js";
import { showCreditGuideModal } from "./credit-guide-modal.js";
import { updateCreditLabel } from "./credit-fx.js";
import { startGuide } from "./guide.js";
import { openAdjustModal } from "./art-crop.js";
import { playMagicCircle, stopMagicCircle } from "./magic-circle.js";

const $ = (id) => document.getElementById(id);

let generatedMonster = null;
let savedMonsterId = null; // 現在の generatedMonster がコレクションへ保存済みか（共有時の判定用）
let profile = null; // { nickname, canChangeAt, createdAt, credits } ／ 未設定なら nickname: null
const pageParams = new URLSearchParams(window.location.search);
const returnTo = pageParams.get("returnTo");

attachButtonHaptics();

// ── ⑬ artCrop: localStorage への保存/復元は art-crop.js へ共通化済み ──

// ── ⑭ 召喚/生成アニメーション: 儀式オーバーレイ ──
function showRitual(monster, mode) {
  const isSummon = mode === "summon";
  $("ritual-text").textContent = isSummon ? "召喚中…" : "生成中…";
  $("ritual-sub").textContent = isSummon
    ? `「${monster.name}」の名を世界に呼び起こしています`
    : `「${monster.name}」からたった一体のメイモンを紡いでいます`;
  $("ritual-cost").querySelector("span").textContent = isSummon ? "クレジット消費" : "クレジット消費";
  $("ritual-overlay").classList.add("show");
  // 魔法陣アニメーション開始（レアリティに応じた色演出）
  const mc = $("mc");
  return playMagicCircle(mc, monster.rarity || 1);
}
function hideRitual() {
  stopMagicCircle($("mc"));
  $("ritual-overlay").classList.remove("show");
}

// ── ⑭ リビールステージ（カード登場演出） ──
function showReveal(monster) {
  const wrap = $("reveal-wrap");
  wrap.innerHTML = "";
  const card = buildAimonCardElement(monster);
  card.style.margin = "0";
  card.style.width = "min(340px, 80vw)";
  wrap.appendChild(card);

  $("reveal-title").textContent = "生成完了！";
  $("reveal-title").style.color = "#fbbf24";
  $("reveal-origin").textContent = monster.origin?.isMine
    ? "あなたが初発見者です"
    : `初発見者: ${monster.origin?.nickname || "不明"}`;

  const stage = $("reveal-stage");
  stage.classList.add("show");
  void stage.offsetWidth; // force reflow for transition trigger
  stage.classList.add("show-card");
}
function closeReveal() {
  const stage = $("reveal-stage");
  stage.classList.remove("show-card");
  setTimeout(() => stage.classList.remove("show"), 300);
}

function stars(rarity) {
  return "★".repeat(rarity);
}

function monsterHtml(monster) {
  const skillHtml = monster.skill
    ? `<div>スキル: <strong>${monster.skill.name}</strong>（${monster.skill.flavor1} ${monster.skill.effect} ${monster.skill.flavor2}／対戦中1回限り）</div>`
    : "";
  const artHtml = monster.imageUrl
    ? `<img class="monster-art" src="${monster.imageUrl}" alt="${monster.name}のイラスト" />`
    : `<div class="monster-art monster-art-placeholder">イラスト生成中...</div>`;
  const worldHtml = monster.world
    ? `<div><small>${monster.world.species.realm}・${monster.world.species.ja} / ${monster.world.region.ja}（${monster.world.region.nationJa}） / 属性:${monster.world.element.ja}</small></div>`
    : "";
  return `
    ${artHtml}
    <div><strong>${monster.name}</strong></div>
    <div>ID: <code>${monster.id}</code></div>
    ${worldHtml}
    <div>RARITY: ${stars(monster.rarity)} (${monster.rarity}) [roll=${monster.rarityRoll}]</div>
    <div>HP ${monster.hp} / P ${monster.p} / S ${monster.s} / T ${monster.t} / TOTAL ${monster.total}</div>
    ${skillHtml}
    <div><small>hash: ${monster.hash}</small></div>
  `;
}

let detailVisible = false;

function renderMonsterCard(id, monster) {
  const el = $(id);
  el.innerHTML = monsterHtml(monster);
  // 詳細データはユーザーがトグルで開いている時だけ表示状態を維持する。
  // それ以外(初期状態やイラスト差し替え時)は既定で非表示のまま。
  el.classList.toggle("hidden", !detailVisible);
}

function renderTradingCard(monster) {
  const mount = $("tcard-mount");
  closeZoomViewerWithoutRestore();
  mount.innerHTML = "";
  // ⑬ artCrop: buildAimonCardElement が自動で localStorage から復元する
  const cardEl = buildAimonCardElement(monster);
  mount.appendChild(cardEl);
  mount.classList.remove("hidden");
  // カード表示中はイラスト調整ボタンを表示
  $("btn-adjust-art")?.classList.remove("hidden");
  attachCardLongPress(cardEl);
}

// P4 ⑯: 生成カードの長押し(420ms)で拡大表示（openCardZoomViewer）を開く。
// 「拡大して見る」ボタンを廃止し、カード自体の長押しに置き換える（party.jsと同じ挙動）。
// openCardZoomViewer()は実物の.tcardをモーダルへ一時移動するため、閉じた時に元の位置へ
// 正しく戻せるよう対象は.tcard自身を渡す。
function attachCardLongPress(cardEl) {
  if (!cardEl) return;
  let pressTimer = null;
  let longPressed = false;
  let downX = 0;
  let downY = 0;
  // 生成カードは傾き演出（card-tilt.js）が有効で、ホールド中でもCSS transformで
  // カーソル下の要素が変わり、同座標の pointermove が連発されることがある。
  // この微小な「動き」でキャンセルしないよう、実際に指/カーソルが動いた場合のみ
  // 長押しをキャンセルする（タッチ端末では実質影響なし・マウス長押しで必要）。
  const MOVE_SLOP = 8; // px
  const start = (e) => {
    longPressed = false;
    downX = e.clientX;
    downY = e.clientY;
    pressTimer = setTimeout(() => {
      longPressed = true;
      e.stopPropagation();
      cardEl.style.pointerEvents = "";
      openCardZoomViewer(cardEl);
    }, 420);
  };
  const cancelMove = (e) => {
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    if (Math.hypot(dx, dy) <= MOVE_SLOP) return; // tilt起因の同座標moveは無視
    clearTimeout(pressTimer);
  };
  const cancelAlways = () => {
    clearTimeout(pressTimer);
  };
  cardEl.addEventListener("pointerdown", start);
  cardEl.addEventListener("pointerup", cancelAlways);
  cardEl.addEventListener("pointerleave", cancelAlways);
  cardEl.addEventListener("pointermove", cancelMove);
  cardEl.addEventListener("click", (e) => {
    if (longPressed) {
      e.stopPropagation();
      e.preventDefault();
    }
  });
}

async function createFromInputs(nameId) {
  return generateMonster($(nameId).value);
}

$("btn-generate").addEventListener("click", async () => {
  const genBtn = $("btn-generate");
  try {
    // ニックネーム未設定では生成不可（サーバー側でも強制されるが、先にクライアントでゲートする）。
    if (!profile?.nickname) {
      showNicknameStatus("⚠️ ニックネームを設定すると生成できます（ダッシュボードで設定してください）", "err");
      return;
    }
    const personalNameCheck = await looksLikePersonalName($("seed-name").value);
    if (personalNameCheck.matched && !window.confirm(PERSONAL_NAME_WARNING)) {
      return;
    }

    // ── M5: ステータス確認を「表示より前」に実施（無料プレビューでのリセマラ防止） ──
    // 生成ボタンを押した段階ではメイモンのステータスを一切表示しない。
    // メイモンは決定論的に再生成できるため、消費を確定する前にサーバーの状態を問い合わせ、
    // コストに応じた確認ダイアログを通った後にはじめてカード表示に進む。
    const targetMonster = await createFromInputs("seed-name");
    genBtn.disabled = true; // 確認〜画像生成の間の連打を防ぐ
    showSaveStatus("", "");

    let confirmed = false;
    let st = null;
    try {
      st = await fetchMonsterStatus(targetMonster);
      if (st.collectionFull) {
        genBtn.disabled = false;
        showSaveStatus(
          `⚠️ コレクションが満杯です（${st.collectionCount ?? 30}/30体）。編成ページで不要なメイモンを削除してください`,
          "err"
        );
        return;
      }
      let proceed = false;
      const needsCredit = !(st.exists && st.owned); // 新規生成・召喚は課金、自分の所有再呼び出しは無料
      if (needsCredit) {
        // ── クレ0ブロック：課金が必要なのに残高0だと、イラストだけ失敗して0クレリセマラが可能 ──
        // 確認ダイアログを出す前に残高を確認し、0ならクレジット獲得方法の案内モーダルでブロックする。
        let credits = null;
        try {
          const creditState = await fetchCredits();
          credits = creditState?.credits ?? 0;
        } catch {
          // 残高取得に失敗した場合はサーバー側の強制に任せる（従来フローへ）。
        }
        if (credits !== null && credits <= 0) {
          genBtn.disabled = false;
          showSaveStatus("", "");
          showCreditGuideModal({ reason: "no_credits" });
          return;
        }
      }
      if (st.exists && !st.owned) {
        const costText = st.cost === 5 ? "5クレジット（召喚祭・半額）" : `${st.cost ?? 10}クレジット`;
        proceed = window.confirm(
          `「${targetMonster.name}」は誰かが発見済みのメイモンです。\n召喚（${costText}）で所有権を獲得してコレクションに加えます。続行しますか？`
        );
      } else if (st.exists) {
        proceed = window.confirm(
          `「${targetMonster.name}」は自分のコレクションのメイモンです。\nクレジット消費なしで再呼び出しします。続行しますか？`
        );
      } else {
        proceed = window.confirm(
          `「${targetMonster.name}」を生成します。生成ボタンを押すと5クレジット消費します。よろしいですか？`
        );
      }
      if (!proceed) {
        genBtn.disabled = false;
        showSaveStatus("生成をキャンセルしました", "");
        return;
      }
      confirmed = true;
    } catch {
      // ステータスAPIが失敗した場合はサーバー側の強制に任せ、汎用確認のみ行う。
      genBtn.disabled = false;
      if (!window.confirm("このメイモンを生成します（クレジットを消費します）。続行しますか？")) {
        showSaveStatus("生成をキャンセルしました", "");
        return;
      }
      confirmed = true;
    }
    genBtn.disabled = true; // 確認が通ったら画像生成の完了まで再度ロック

    // Phase 2: 即引き落とし（リセマラ防止）。
    // 確認ダイアログ通過直後にクレジットを消費し、chargeId を取得する。
    // これにより、画像生成失敗時も返金が可能で、ユーザーはステータス確認後に
    // ページを閉じても課金が確実に発生する。
    let charge = null;
    try {
      charge = await chargeMonster(targetMonster.name);
    } catch (chargeErr) {
      genBtn.disabled = false;
      if (chargeErr?.status === 403 && chargeErr?.code === "insufficient_credits") {
        showSaveStatus(`⚠️ ${chargeErr.message}（ダッシュボードでデイリー受取・購入ができます）`, "err");
      } else if (chargeErr?.status === 403 && chargeErr?.code === "account_locked") {
        showSaveStatus("🔒 このアカウントはロックされています。心当たりがない場合はお問い合わせください", "err");
      } else if (chargeErr?.status === 429) {
        showSaveStatus("⏳ 処理が多すぎます。少し待ってからもう一度お試しください", "");
      } else {
        showSaveStatus(`❌ 課金エラー: ${chargeErr.message}`, "err");
      }
      return;
    }

    // ユニークモンスター: 画像生成不要・無料でコレクション追加済み（charge.js で処理）。
    if (charge.source === "unique") {
      genBtn.disabled = false;
      showSaveStatus("✅ ユニークモンスターをコレクションに追加しました", "ok");
      initCredits();
      return;
    }

    // 確認通過後のみステータスを表示（ここから先は課金が確定している）。
    // ⑭: 儀式オーバーレイを表示し、カードは裏で準備する。
    generatedMonster = targetMonster;
    const genMode = (st?.exists && !st?.owned) ? "summon" : "generate";
    const animDone = showRitual(targetMonster, genMode);
    renderMonsterCard("generated-card", generatedMonster);
    renderTradingCard(generatedMonster);
    $("btn-share").disabled = false;
    $("btn-download-card").disabled = false;
    $("btn-print-card").disabled = false;
    confirmHaptic();
    showSaveStatus("⏳ イラストを生成しています…", "");

    // AIフレーバー生成はサーバー側（monster-image.js→_image-gen-core.js）で画像生成と並列に完結する。
    // クライアントから個別に生成・保存を往復させていた旧実装は、既所有メイモンの無料再呼び出しでも
    // 誤って課金される credit bug の原因になっていたため撤去済み（2026-08-22）。

    // イラストを自動生成（R2に永続化＋初発見者レジストリに記録）／ 既存キャッシュは召喚・再呼び出し。
    // Phase 2: chargeId を渡してサーバー側の二重課金を防止する。
    // アニメーション完了後にリビールするため、Promise で包んで両方待つ。
    const imgPromise = fetchMonsterImage(targetMonster, { chargeId: charge?.chargeId }).then((img) => {
      if (!img || !img.url || generatedMonster !== targetMonster) return null;
      targetMonster.imageUrl = img.url;
      if (img.origin) targetMonster.origin = img.origin;
      // サーバーが画像生成と並列に確定させたAIフレーバーをカードへ反映する。
      // これを行わないと /api/monster/generate 由来の仮フレーバー（フォールバック文言）が
      // 表示され続けてしまう（2026-08-22 修正）。
      if (img.skill) targetMonster.skill = img.skill;
      renderMonsterCard("generated-card", generatedMonster);
      renderTradingCard(generatedMonster);
      return img;
    });

    // アニメーション完了 + イラスト生成の両方が完了してからリビール
    const [img] = await Promise.all([imgPromise, animDone]);
    genBtn.disabled = false;

    if (!img) {
      hideRitual();
      return;
    }

    // ⑭: 儀式オーバーレイ解除 → リビールステージでカードを披露
    hideRitual();
    showReveal(targetMonster);
    const countText = img.collectionCount != null ? ` コレクション: ${img.collectionCount}体` : "";
    if (img.isNewDiscovery) {
      savedMonsterId = targetMonster.id;
      showSaveStatus(`🎉 新規生成してコレクションに自動保存しました（あなたが初発見者です）${countText}`, "ok");
      setTimeout(() => startGuide(), 800);
    } else if (img.source === "summon") {
      savedMonsterId = targetMonster.id;
      const costText = img.cost === 5 ? "5クレジット（召喚祭・半額）" : `${img.cost ?? 10}クレジット`;
      const originName = img.origin?.nickname || "不明";
      showSaveStatus(`🎯 召喚成功！ ${costText}で所有権を獲得しました（初発見者: ${originName}）${countText}`, "ok");
      if (img.bonusGranted) {
        showBonusDialog(`🎉 召喚ボーナスを獲得しました（+2クレジット）`);
      }
    } else if (img.source === "cache") {
      savedMonsterId = targetMonster.id;
      showSaveStatus(`✅ 自分のコレクションのメイモンを呼び出しました（クレジット消費なし）${countText}`, "ok");
    } else {
      savedMonsterId = targetMonster.id;
      showSaveStatus(`🎉 生成してコレクションに保存しました${countText}`, "ok");
    }
    initCredits();
  } catch (error) {
    genBtn.disabled = false;
    hideRitual(); // ⑭: エラー時もオーバーレイを解除
    if (error?.status === 403 && error?.code === "nickname_required") {
      showNicknameStatus("⚠️ ニックネームを設定してから生成してください", "err");
    } else if (error?.status === 403 && error?.code === "insufficient_credits") {
      showSaveStatus(`⚠️ ${error.message}（ダッシュボードでデイリー受取・購入ができます）`, "err");
    } else if (error?.status === 403 && error?.code === "account_locked") {
      showSaveStatus("🔒 このアカウントはロックされています。心当たりがない場合はお問い合わせください", "err");
    } else if (error?.status === 429) {
      showSaveStatus("⏳ 処理が多すぎます。少し待ってからもう一度お試しください", "");
    } else if (error?.status === 400 && error?.code === "collection_full") {
      showSaveStatus(`⚠️ ${error.message}`, "err");
    } else if (error?.status === 400 && (error?.code === "invalid_name" || error?.code === "name too long")) {
      showSaveStatus(`⚠️ ${error.message}`, "err");
    } else if (error?.status === 502 && error?.code === "summon_save_failed") {
      showSaveStatus(`⚠️ ${error.message}`, "err");
    } else if (error?.status === 401) {
      showSaveStatus("⚠️ ログインが必要です。再ログインしてお試しください", "err");
    } else {
      showSaveStatus(`❌ 生成エラー: ${error.message}`, "err");
    }
  }
});

// フィードに共有する（M3）。生成はワンストップでコレクションへ自動保存されるため（M4）、
// 生成に成功したメイモンはそのまま直接共有する。初回共有で共有ボーナス+2クレジット。
$("btn-share").addEventListener("click", async () => {
  if (!generatedMonster) return;
  const shareBtn = $("btn-share");
  shareBtn.disabled = true;
  showSaveStatus("共有準備中...", "");
  try {
    const res = await postFeed(generatedMonster.id);
    showSaveStatus(
      res.bonusGranted
        ? "✅ フィードに共有しました（共有ボーナス +2クレジット）"
        : "✅ フィードに共有しました（本日の共有ボーナスは受取済み）",
      "ok"
    );
  } catch (err) {
    const msg =
      err.code === "ng_word"
        ? "このメイモン名は共有できません"
        : err.code === "not_owned"
          ? "コレクションに保存後に共有してください"
          : err.code === "rate_limited"
            ? err.message
            : `共有に失敗しました: ${err.message}`;
    showSaveStatus(`❌ ${msg}`, "err");
  } finally {
    shareBtn.disabled = false;
  }
});

function showSaveStatus(text, type) {
  const el = $("save-status");
  el.textContent = text;
  el.className = "save-status" + (type ? " " + type : "") + (text ? "" : " hidden");
}

$("btn-download-card").addEventListener("click", async () => {
  if (!generatedMonster) return;
  const cardEl = $("tcard-mount").firstElementChild;
  if (!cardEl) return;
  const btn = $("btn-download-card");
  btn.disabled = true;
  showSaveStatus("画像を書き出しています...", "");
  try {
    await downloadCardAsPng(cardEl, `${generatedMonster.name}_${generatedMonster.id}.png`);
    showSaveStatus("✅ 画像を保存しました", "ok");
  } catch (e) {
    showSaveStatus(`❌ 画像化に失敗しました: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

$("btn-print-card").addEventListener("click", async () => {
  if (!generatedMonster) return;
  const cardEl = $("tcard-mount").firstElementChild;
  if (!cardEl) return;
  const btn = $("btn-print-card");
  btn.disabled = true;
  showSaveStatus("印刷用画像を書き出しています...", "");
  try {
    // シール印刷用: ポーカーカード実寸(63.5mm×88.9mm)・300dpi基準のPNGを書き出す。
    // 印刷対象プリンターが決まったらcard-render.jsのPRINT_*定数を差し替えるだけでよい。
    await exportCardForPrint(cardEl, `${generatedMonster.name}_${generatedMonster.id}_print.png`);
    showSaveStatus("✅ 印刷用画像を保存しました", "ok");
  } catch (e) {
    showSaveStatus(`❌ 印刷用画像の書き出しに失敗しました: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
  }
});

// トレーディングカード画像で内容は確認できるため、詳細データ(イラスト単体＋ステータステキスト)は
// 既定で非表示にし、必要な時だけトグルで開閉できるようにする。
$("btn-toggle-detail").addEventListener("click", () => {
  const detail = $("generated-card");
  const btn = $("btn-toggle-detail");
  detailVisible = detail.classList.contains("hidden") && !!generatedMonster;
  if (detailVisible) {
    detail.classList.remove("hidden");
    btn.setAttribute("data-tap-label", "詳細を隠す");
  } else {
    detailVisible = false;
    detail.classList.add("hidden");
    btn.setAttribute("data-tap-label", "詳細を表示");
  }
});

// ── ニックネーム（初発見者「おや」）設定と生成ゲート ──────────
function showNicknameStatus(text, type) {
  const el = $("nickname-status");
  el.textContent = text;
  el.className = "save-status" + (type ? " " + type : "") + (text ? "" : " hidden");
}

function setGenerateEnabled(enabled) {
  $("btn-generate").disabled = !enabled;
}

// 生成ゲート: ニックネーム未設定なら生成ボタンを無効化し、ダッシュボードでの設定を促す。
// （ニックネーム設定 UI は dashboard.html へ移動したため、ここでは状態表示のみ行う）
function applyProfileGate() {
  if (profile === null) {
    setGenerateEnabled(false);
    showNicknameStatus("⚠️ プロフィールを取得できませんでした。再試行してください", "err");
    return;
  }
  if (profile?.nickname) {
    setGenerateEnabled(true);
    showNicknameStatus("", "");
  } else {
    setGenerateEnabled(false);
    showNicknameStatus(
      "⚠️ ニックネームを設定すると生成できます（ダッシュボードで設定してください）",
      ""
    );
  }
}

async function initNickname() {
  try {
    profile = await fetchMyProfile();
  } catch {
    profile = null; // 取得失敗（エラー表示）
  }
  applyProfileGate();
}

// ── クレジット残高チップ（ショップへの導線） ─────────────
// 生成ページ上部に残高を表示し、クレジット購入ボタンでショップへ誘導する（2026-08-07）。
async function initCredits() {
  const label = $("credits-chip-label");
  if (!label) return;
  try {
    const st = await fetchCredits();
    updateCreditLabel(label, st?.credits);
    // 召喚祭（時限キャンペーン）開催中は召喚コスト半減の告知を表示する（設計 §5.8④）。
    const notice = $("summon-festival-notice");
    if (notice) {
      if (st?.summonFestival?.active) {
        notice.textContent = `🎉 召喚祭開催中！ 既存メイモンの召喚コストが 2 → ${st.summonFestival.cost} クレジットに半減！`;
        notice.className = "save-status ok";
      } else {
        notice.textContent = "";
        notice.className = "save-status hidden";
      }
    }
  } catch {
    label.textContent = "クレジット: --";
  }
}

const bandText = RARITY_BANDS.map((b) => `R${b.rarity}:${b.min}-${b.max}`).join(" / ");
console.info(`レア度帯: ${bandText}`);

// ページ表示時にプロフィールを読み込み、ニックネーム未設定なら生成ボタンを無効化する。
// （ニックネーム設定・アカウント登録はダッシュボードへ、クレジット購入はショップへ移動）
initNickname();
// クレジット残高チップを読み込んで表示する（購入はショップへ）。
initCredits();

// ── ⑭ リビールステージ: 閉じる・イラスト調整ボタン ──
$("btn-reveal-close")?.addEventListener("click", () => {
  closeReveal();
  // カードは renderTradingCard で既に tcard-mount に描画済み
});
$("btn-reveal-adjust")?.addEventListener("click", () => {
  closeReveal();
  // リビールを閉じてから調整モーダルを開く
  setTimeout(() => {
    if (generatedMonster) {
      openAdjustModal(generatedMonster, {
        onSaved: () => renderTradingCard(generatedMonster),
      });
    }
  }, 350);
});

// ── ⑬ 画像調整: art-crop.js のモーダルに統合済み ──
$("btn-adjust-art")?.addEventListener("click", () => {
  if (!generatedMonster) return;
  openAdjustModal(generatedMonster, {
    onSaved: () => renderTradingCard(generatedMonster),
  });
});
