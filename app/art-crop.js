// ── art-crop.js: イラスト調整（artCrop）共通モジュール ──
// 生成画面・編成画面・任意のページから共通して使える。
// localStorage に { scale, x, y } を保存し、buildAimonCardElement が CSS transform に反映する。

import { buildAimonCardElement } from "./card-render.js";
import { closeZoomViewerWithoutRestore } from "./card-zoom.js";

const CROP_KEY = (id) => `aimon_art_crop:${id}`;

// ── localStorage CRUD ──

export function loadArtCrop(monster) {
  if (!monster?.id) return;
  // 既にartCropがセット済みなら上書きしない（サーバー側数据等）
  if (monster.artCrop) return;
  try {
    const raw = localStorage.getItem(CROP_KEY(monster.id));
    if (raw) {
      const crop = JSON.parse(raw);
      if (crop && typeof crop.scale === "number") monster.artCrop = crop;
    }
  } catch { /* ignore */ }
}

export function saveArtCrop(monster, crop) {
  if (!monster?.id) return;
  try { localStorage.setItem(CROP_KEY(monster.id), JSON.stringify(crop)); } catch { /* ignore */ }
}

export function clearArtCrop(monster) {
  if (!monster?.id) return;
  try { localStorage.removeItem(CROP_KEY(monster.id)); } catch { /* ignore */ }
}

// ── 調整モーダル ──

const SNAP_GRID = 10;
const SCALE_SNAP = 0.05;
function snapVal(v, grid) { return Math.round(v / grid) * grid; }

let activeModal = null; // { overlay, monster, onSaved, cropState, dragState }

/**
 * イラスト調整モーダルを開く。
 * @param {Object} monster - アイモンオブジェクト（id, imageUrl, name 必須）
 * @param {Object} [opts]
 * @param {Function} [opts.onSaved] - 確定後に呼ばれるコールバック（再描画用）
 * @param {Function} [opts.onClosed] - モーダルが完全に閉じた後のコールバック
 */
export function openAdjustModal(monster, opts = {}) {
  if (activeModal) return; // 重複防止
  if (!monster?.imageUrl) return;

  // 既存のズームビューアを閉じる
  closeZoomViewerWithoutRestore();

  const cropState = {
    scale: monster.artCrop?.scale ?? 1,
    x: monster.artCrop?.x ?? 0,
    y: monster.artCrop?.y ?? 0,
  };
  let dragState = null;

  // ── オーバーレイ DOM 構築 ──
  const overlay = document.createElement("div");
  overlay.className = "art-crop-overlay";
  overlay.innerHTML = `
    <div class="art-crop-backdrop"></div>
    <div class="art-crop-panel">
      <div class="art-crop-head">
        <span class="art-crop-title"><i class="fa-solid fa-crop-simple"></i> イラストを調整</span>
        <button type="button" class="art-crop-close" aria-label="閉じる"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="art-crop-body">
        <div class="art-crop-card-stage" id="art-crop-stage"></div>
        <div class="art-crop-hint">ドラッグで移動、スライダーで拡大縮小</div>
        <div class="art-crop-slider-row">
          <label for="art-crop-scale">大きさ</label>
          <input id="art-crop-scale" type="range" min="1" max="1.5" step="0.05" value="${cropState.scale}" />
          <span id="art-crop-scale-val">${Math.round(cropState.scale * 100)}%</span>
        </div>
        <div class="art-crop-actions">
          <button type="button" class="art-crop-btn art-crop-btn-cancel">キャンセル</button>
          <button type="button" class="art-crop-btn art-crop-btn-confirm">確定して保存</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const stage = overlay.querySelector("#art-crop-stage");
  const slider = overlay.querySelector("#art-crop-scale");
  const scaleVal = overlay.querySelector("#art-crop-scale-val");

  // ── カード構築 ──
  let card = buildAimonCardElement(monster);
  card.classList.add("tcard--adjust-mode");
  // ホロ/チルト演出を無効化（調整モードでは不要）
  card.querySelectorAll(".tcard-glossy-band").forEach((b) => (b.style.display = "none"));
  stage.appendChild(card);

  // ── transform 適用 ──
  function applyTransform(updateSlider = true) {
    const s = Math.round(Math.max(1, Math.min(1.5, cropState.scale)) / SCALE_SNAP) * SCALE_SNAP;
    cropState.scale = parseFloat(s.toFixed(2));
    cropState.x = snapVal(cropState.x, SNAP_GRID);
    cropState.y = snapVal(cropState.y, SNAP_GRID);
    if (updateSlider) {
      slider.value = cropState.scale.toFixed(2);
      scaleVal.textContent = `${Math.round(cropState.scale * 100)}%`;
    }
    const img = stage.querySelector(".tcard-art-img");
    if (img) {
      img.style.transform = `scale(${cropState.scale}) translate(${cropState.x}px, ${cropState.y}px)`;
      img.style.transformOrigin = "center center";
    }
  }

  // ── ドラッグハンドラ ──
  const onDown = (e) => {
    e.preventDefault();
    dragState = { startX: e.clientX, startY: e.clientY, startCropX: cropState.x, startCropY: cropState.y };
    card.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragState) return;
    e.preventDefault();
    cropState.x = dragState.startCropX + (e.clientX - dragState.startX);
    cropState.y = dragState.startCropY + (e.clientY - dragState.startY);
    applyTransform(false);
  };
  const onUp = (e) => {
    if (!dragState) return;
    dragState = null;
    card.releasePointerCapture(e.pointerId);
    applyTransform(true);
  };
  card.addEventListener("pointerdown", onDown);
  card.addEventListener("pointermove", onMove);
  card.addEventListener("pointerup", onUp);
  card.addEventListener("pointercancel", onUp);

  // ── スライダー ──
  slider.addEventListener("input", () => {
    cropState.scale = parseFloat(slider.value);
    applyTransform(false);
  });

  // ── 閉じる処理 ──
  function close(save) {
    if (!activeModal) return;
    if (save) {
      const crop = { scale: cropState.scale, x: cropState.x, y: cropState.y };
      saveArtCrop(monster, crop);
      monster.artCrop = crop;
      if (opts.onSaved) opts.onSaved(monster);
    }
    // クリーンアップ
    card.removeEventListener("pointerdown", onDown);
    card.removeEventListener("pointermove", onMove);
    card.removeEventListener("pointerup", onUp);
    card.removeEventListener("pointercancel", onUp);
    overlay.remove();
    document.body.style.overflow = "";
    activeModal = null;
    if (opts.onClosed) opts.onClosed();
  }

  // ── イベントリスナー ──
  overlay.querySelector(".art-crop-backdrop").addEventListener("click", () => close(false));
  overlay.querySelector(".art-crop-close").addEventListener("click", () => close(false));
  overlay.querySelector(".art-crop-btn-cancel").addEventListener("click", () => close(false));
  overlay.querySelector(".art-crop-btn-confirm").addEventListener("click", () => close(true));

  activeModal = { overlay, monster, onSaved: opts.onSaved, cropState, dragState: null };
}

/**
 * アクティブな調整モーダルを閉じる（外部から呼ばれる場合）。
 */
export function closeAdjustModal(save = false) {
  if (!activeModal) return;
  const modal = activeModal;
  // activeModal を先にクリア（再入防止）
  activeModal = null;
  if (save) {
    const crop = { scale: modal.cropState.scale, x: modal.cropState.x, y: modal.cropState.y };
    saveArtCrop(modal.monster, crop);
    modal.monster.artCrop = crop;
    if (modal.onSaved) modal.onSaved(modal.monster);
  }
  modal.overlay.remove();
  document.body.style.overflow = "";
}

/**
 * 調整モーダルが現在開いているか。
 */
export function isAdjustModalOpen() {
  return !!activeModal;
}
