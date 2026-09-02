import {
  cloneImageData,
  cleanFakeTransparency,
  createZipBlob,
  detectTransparentRegions,
  downloadPngFiles,
  downloadZipBlob,
  exportSlicesAsPng,
  generateGridSlices,
  getAlphaBounds,
  mergeRects,
  sampleCornerColors,
  snapRect,
} from "./src/imageProcessing.js";

/*
 * SpriteLab is intentionally a small, dependency-free browser app.  The UI
 * is DOM based while the image and overlay work happens in one canvas.  This
 * keeps the project easy to host from a local folder without a server.
 */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const uid = (prefix = "slice") => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const viewport = $("#viewportCanvas");
const stage = $("#canvasStage");
const vctx = viewport.getContext("2d", { alpha: false });
const assetThumb = $("#assetThumb");
const assetCtx = assetThumb.getContext("2d");
const cleanThumb = $("#cleanThumb");
const cleanCtx = cleanThumb.getContext("2d");
let cleanPreviewTimer = 0;

const state = {
  originalImageData: null,
  cleanedImageData: null,
  pendingCleaned: null,
  sourceCanvas: document.createElement("canvas"),
  sourceCtx: null,
  previewCanvas: null,
  previewDataRef: null,
  assetDataRef: null,
  maskSourceRef: null,
  maskPreviewData: null,
  backgroundColors: [],
  backgroundColorManual: false,
  fileName: "atlas.png",
  fileFormat: "PNG",
  imageName: "未选择图片",
  slices: [],
  selectedIds: new Set(),
  mode: "select",
  preview: "image",
  transform: { scale: 0.66, x: 0, y: 0 },
  stageSize: { width: 0, height: 0, dpr: 1 },
  drag: null,
  draft: null,
  marquee: null,
  candidates: [],
  candidateSelectedIds: new Set(),
  detectStatus: "idle",
  candidateMask: null,
  gridPreview: [],
  history: [],
  redo: [],
  spaceDown: false,
  rulerVisible: true,
  highContrast: false,
  theme: "light",
};
state.sourceCtx = state.sourceCanvas.getContext("2d", { willReadFrequently: true });

const THEME_STORAGE_KEY = "spritelab-theme";

function storedTheme() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch (_) {
    return "light";
  }
}

function cssToken(name, fallback = "") {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function applyTheme(theme, persist = true) {
  const value = theme === "dark" ? "dark" : "light";
  state.theme = value;
  document.documentElement.dataset.theme = value;
  document.documentElement.style.colorScheme = value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", value === "dark" ? "#0a0d12" : "#f4f7fb");
  const button = $("#themeToggleBtn");
  if (button) {
    const nextLabel = value === "light" ? "深色" : "白色";
    const nextTitle = value === "light" ? "切换到深色主题" : "切换到白色主题";
    $("#themeToggleLabel").textContent = nextLabel;
    button.title = nextTitle;
    button.setAttribute("aria-label", nextTitle);
    button.setAttribute("aria-pressed", value === "dark" ? "true" : "false");
  }
  const select = $("#themeSelect");
  if (select) select.value = value;
  if (persist) {
    try { window.localStorage.setItem(THEME_STORAGE_KEY, value); } catch (_) { /* private browsing can disable storage */ }
  }
  // The thumbnail canvases paint their checkerboard themselves, so invalidate
  // their data refs when the theme changes even though the image buffer is the
  // same. Source pixels remain untouched.
  state.assetDataRef = null;
  renderCleanThumb();
  if (state.stageSize.width) renderAll();
}

function cloneData(data) {
  return data ? cloneImageData(data) : null;
}

// CanvasRenderingContext2D.putImageData is stricter than the algorithms in
// imageProcessing.js (which deliberately return ImageData-like objects for
// worker compatibility). Normalize at the DOM boundary so mask previews and
// worker results render consistently in every browser.
function nativeImageData(data) {
  if (!data) return null;
  if (typeof ImageData !== "undefined" && data instanceof ImageData) return data;
  if (typeof ImageData !== "undefined") { try { return new ImageData(new Uint8ClampedArray(data.data), data.width, data.height); } catch (_) { /* fall through */ } }
  return data;
}

function normalizeSlice(rect, name = "sprite") {
  const x = Math.round(Math.min(rect.x, rect.x + rect.width));
  const y = Math.round(Math.min(rect.y, rect.y + rect.height));
  const width = Math.max(1, Math.round(Math.abs(rect.width)));
  const height = Math.max(1, Math.round(Math.abs(rect.height)));
  return { id: rect.id || uid("slice"), name, x, y, width, height, keepPadding: !!rect.keepPadding, auto: !!rect.auto };
}

function snapshot() {
  return {
    slices: state.slices.map((s) => ({ ...s })),
    // Image buffers are immutable snapshots from the UI's perspective
    // (processing helpers always return a new buffer), so retain the reference
    // here instead of cloning a potentially multi-megapixel RGBA array for
    // every pointer-down history entry.
    cleanedImageData: state.cleanedImageData,
    selectedIds: [...state.selectedIds],
    preview: state.preview,
    candidates: state.candidates.map((c) => ({ ...c })),
    candidateSelectedIds: [...state.candidateSelectedIds],
    detectStatus: state.detectStatus,
  };
}

function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > 45) state.history.shift();
  state.redo.length = 0;
  updateHistoryButtons();
}

function restoreSnapshot(item) {
  state.slices = item.slices.map((s) => ({ ...s }));
  state.cleanedImageData = item.cleanedImageData;
  state.pendingCleaned = null;
  state.candidates = (item.candidates || []).map((c) => ({ ...c }));
  state.candidateSelectedIds = new Set(item.candidateSelectedIds || []);
  state.detectStatus = item.detectStatus || (state.candidates.length ? "results" : "idle");
  const validIds = new Set(state.slices.map((s) => s.id));
  state.selectedIds = new Set((item.selectedIds || []).filter((id) => validIds.has(id)));
  if (!state.selectedIds.size && state.slices[0]) state.selectedIds = new Set([state.slices[0].id]);
  state.preview = item.preview || "image";
  // A cleanup preview is transient and intentionally not stored in history.
  // If the snapshot predates an applied cleanup, avoid showing a "cleaned"
  // tab while the canvas is actually rendering the untouched source.
  if (state.preview === "cleaned" && !state.cleanedImageData) state.preview = "image";
  syncImageCanvas();
  renderDetectList();
  renderAll();
}

function undo() {
  if (!state.history.length) return toast("没有可撤销的操作", "info");
  state.redo.push(snapshot());
  restoreSnapshot(state.history.pop());
  toast("已撤销", "success");
}

function redo() {
  if (!state.redo.length) return toast("没有可重做的操作", "info");
  state.history.push(snapshot());
  restoreSnapshot(state.redo.pop());
  toast("已重做", "success");
}

function getWorkingImageData() {
  return state.cleanedImageData || state.originalImageData;
}

function syncImageCanvas() {
  const imageData = getWorkingImageData();
  if (!imageData) return;
  state.sourceCanvas.width = imageData.width;
  state.sourceCanvas.height = imageData.height;
  state.sourceCtx = state.sourceCanvas.getContext("2d", { willReadFrequently: true });
  state.sourceCtx.putImageData(nativeImageData(imageData), 0, 0);
  state.previewDataRef = null;
  state.maskSourceRef = null;
}

function setImageData(imageData, name, fileName) {
  clearTimeout(cleanPreviewTimer);
  state.originalImageData = cloneData(imageData);
  state.cleanedImageData = null;
  state.pendingCleaned = null;
  state.backgroundColors = [];
  state.backgroundColorManual = false;
  state.fileName = fileName || "atlas.png";
  const extension = (state.fileName.match(/\.([^.]+)$/)?.[1] || "png").toUpperCase();
  state.fileFormat = extension === "JPG" ? "JPEG" : extension;
  state.imageName = name || state.fileName.replace(/\.[^.]+$/, "");
  state.slices = [];
  state.selectedIds = new Set();
  state.candidates = [];
  state.candidateSelectedIds.clear();
  state.detectStatus = "idle";
  state.gridPreview = [];
  state.history = [];
  state.redo = [];
  state.preview = "image";
  syncImageCanvas();
  $("#sampleColorText").textContent = "自动取样四角";
  $("#bgColorSwatch").style.background = $("#bgColorInput").value;
  updateImageLabels();
  renderCleanThumb();
  fitToWindow();
  renderAll();
}

function canvasTokens() {
  return {
    canvasBg: cssToken("--canvas-bg", "#111820"),
    checkerBase: cssToken("--checker-base", "#222b34"),
    checkerTile: cssToken("--checker-tile", "#2d3843"),
    canvasGuide: cssToken("--canvas-guide", "#75a5a4"),
    sliceFill: cssToken("--slice-fill", "rgba(87,147,181,.035)"),
    sliceBorder: cssToken("--slice-border", "rgba(113,169,191,.72)"),
    sliceBorderStrong: cssToken("--slice-border-strong", "#83abc3"),
    selection: cssToken("--selection", "#60dfc6"),
    selectionFill: cssToken("--selection-fill", "rgba(96,223,198,.12)"),
    marqueeFill: cssToken("--marquee-fill", "rgba(96,223,198,.08)"),
    labelBg: cssToken("--label-bg", "rgba(10,18,24,.78)"),
    labelText: cssToken("--label-text", "#a0bac6"),
    labelSelectedBg: cssToken("--label-selected-bg", "rgba(11,37,39,.88)"),
    labelSelectedText: cssToken("--label-selected-text", "#9cf5e3"),
    handleFill: cssToken("--handle-fill", "#b9fff1"),
    handleStroke: cssToken("--handle-stroke", "#163c3b"),
    candidate: cssToken("--candidate", "#b68cff"),
    candidateSelected: cssToken("--candidate-selected", "#e0cfff"),
    candidateFill: cssToken("--candidate-fill", "rgba(182,140,255,.1)"),
    candidateSelectedFill: cssToken("--candidate-selected-fill", "rgba(211,184,255,.2)"),
    candidateLabel: cssToken("--candidate-label", "#d9c4ff"),
    gridOverlay: cssToken("--grid-overlay", "rgba(125,193,255,.52)"),
    gridOverlayFill: cssToken("--grid-overlay-fill", "rgba(125,193,255,.06)"),
  };
}

function drawChecker(ctx, x, y, width, height, size = 16, tokens = canvasTokens()) {
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
  ctx.fillStyle = tokens.checkerBase; ctx.fillRect(x, y, width, height);
  for (let yy = Math.floor(y / size) * size; yy < y + height; yy += size) for (let xx = Math.floor(x / size) * size; xx < x + width; xx += size) {
    if (((Math.floor(xx / size) + Math.floor(yy / size)) & 1) === 0) { ctx.fillStyle = tokens.checkerTile; ctx.fillRect(xx, yy, size, size); }
  }
  ctx.restore();
}

function currentPreviewData() {
  // The segmented preview is intentionally independent from the working
  // buffer: after applying cleanup, “原图” must still show the untouched
  // pixels while editing/export can continue from the cleaned copy.
  if (state.preview === "image") return state.originalImageData;
  if (state.preview === "cleaned") return state.pendingCleaned || state.cleanedImageData || state.originalImageData;
  if (state.preview === "mask") {
    const source = state.pendingCleaned || state.cleanedImageData || state.originalImageData;
    if (state.maskSourceRef !== source) { state.maskPreviewData = makeMaskData(source); state.maskSourceRef = source; }
    return state.maskPreviewData;
  }
  return state.originalImageData;
}

function makeMaskData(imageData) {
  if (!imageData) return null;
  const data = new Uint8ClampedArray(imageData.width * imageData.height * 4);
  for (let p = 0; p < imageData.width * imageData.height; p++) {
    const alpha = imageData.data[p * 4 + 3]; const i = p * 4;
    data[i] = alpha; data[i + 1] = alpha; data[i + 2] = alpha; data[i + 3] = 255;
  }
  return { width: imageData.width, height: imageData.height, data };
}

function canvasForData(data) {
  if (!data) return null;
  if (!state.previewCanvas || state.previewDataRef !== data || state.previewCanvas.width !== data.width || state.previewCanvas.height !== data.height) {
    state.previewCanvas = document.createElement("canvas");
    state.previewCanvas.width = data.width; state.previewCanvas.height = data.height;
    state.previewCanvas.getContext("2d").putImageData(nativeImageData(data), 0, 0);
    state.previewDataRef = data;
  }
  return state.previewCanvas;
}

function fitToWindow() {
  const data = getWorkingImageData();
  if (!data || !state.stageSize.width || !state.stageSize.height) return;
  const pad = 48;
  const scale = Math.min((state.stageSize.width - pad * 2) / data.width, (state.stageSize.height - pad * 2) / data.height);
  state.transform.scale = Math.max(.08, Math.min(4, scale));
  state.transform.x = (state.stageSize.width - data.width * state.transform.scale) / 2;
  state.transform.y = (state.stageSize.height - data.height * state.transform.scale) / 2;
  updateZoomLabel(); renderCanvas();
}

function setZoom(next, anchorX = state.stageSize.width / 2, anchorY = state.stageSize.height / 2) {
  const data = getWorkingImageData(); if (!data) return;
  const old = state.transform.scale; const scale = Math.max(.08, Math.min(8, next));
  const imageX = (anchorX - state.transform.x) / old; const imageY = (anchorY - state.transform.y) / old;
  state.transform.scale = scale; state.transform.x = anchorX - imageX * scale; state.transform.y = anchorY - imageY * scale;
  updateZoomLabel(); renderCanvas();
}

function updateZoomLabel() { $("#zoomLabel").textContent = `${Math.round(state.transform.scale * 100)}%`; }

function resizeViewport() {
  const rect = stage.getBoundingClientRect();
  state.stageSize.width = rect.width; state.stageSize.height = rect.height; state.stageSize.dpr = window.devicePixelRatio || 1;
  viewport.width = Math.max(1, Math.round(rect.width * state.stageSize.dpr)); viewport.height = Math.max(1, Math.round(rect.height * state.stageSize.dpr));
  viewport.style.width = `${rect.width}px`; viewport.style.height = `${rect.height}px`;
  if (state.originalImageData && !state.transform.x && !state.transform.y) fitToWindow(); else renderCanvas();
}

function imageToScreen(rect) { return { x: state.transform.x + rect.x * state.transform.scale, y: state.transform.y + rect.y * state.transform.scale, width: rect.width * state.transform.scale, height: rect.height * state.transform.scale }; }
function screenToImage(x, y) { return { x: (x - state.transform.x) / state.transform.scale, y: (y - state.transform.y) / state.transform.scale }; }
function getPointer(e) { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function snapPoint(p) {
  const grid = Number($("#gridSnapSelect")?.value || 0); const pixel = $("#pixelSnapToggle")?.checked !== false;
  let x = p.x, y = p.y; if (grid > 0) { x = Math.round(x / grid) * grid; y = Math.round(y / grid) * grid; } else if (pixel) { x = Math.round(x); y = Math.round(y); }
  const data = getWorkingImageData(); if (data) { x = Math.max(0, Math.min(data.width, x)); y = Math.max(0, Math.min(data.height, y)); }
  return { x, y };
}

function hitSlice(point) {
  for (let i = state.slices.length - 1; i >= 0; i--) { const s = state.slices[i]; if (point.x >= s.x && point.x <= s.x + s.width && point.y >= s.y && point.y <= s.y + s.height) return s; }
  return null;
}

function hitCandidate(point) {
  for (let i = state.candidates.length - 1; i >= 0; i--) {
    const c = state.candidates[i];
    if (point.x >= c.x && point.x <= c.x + c.width && point.y >= c.y && point.y <= c.y + c.height) return c;
  }
  return null;
}

function getResizeHandle(slice, point) {
  const edge = Math.max(5 / state.transform.scale, 7);
  const left = Math.abs(point.x - slice.x) <= edge, right = Math.abs(point.x - (slice.x + slice.width)) <= edge;
  const top = Math.abs(point.y - slice.y) <= edge, bottom = Math.abs(point.y - (slice.y + slice.height)) <= edge;
  if (left && top) return "nw"; if (right && top) return "ne"; if (left && bottom) return "sw"; if (right && bottom) return "se";
  if (left) return "w"; if (right) return "e"; if (top) return "n"; if (bottom) return "s"; return null;
}

function renderCanvas() {
  const { width, height, dpr } = state.stageSize; if (!width || !height) return;
  const tokens = canvasTokens();
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0); vctx.clearRect(0, 0, width, height); vctx.fillStyle = tokens.canvasBg; vctx.fillRect(0, 0, width, height);
  const data = currentPreviewData();
  const emptyState = $("#stageEmpty");
  if (!data) { if (emptyState) emptyState.hidden = false; return; }
  if (emptyState) emptyState.hidden = true;
  const imageRect = { x: state.transform.x, y: state.transform.y, width: data.width * state.transform.scale, height: data.height * state.transform.scale };
  drawChecker(vctx, imageRect.x, imageRect.y, imageRect.width, imageRect.height, Math.max(8, 16 * Math.min(1, state.transform.scale)), tokens);
  const imgCanvas = canvasForData(data);
  vctx.imageSmoothingEnabled = state.transform.scale < 1;
  vctx.drawImage(imgCanvas, imageRect.x, imageRect.y, imageRect.width, imageRect.height);
  if (state.rulerVisible) drawRulerGuides(vctx, imageRect, tokens);
  // Grid preview is intentionally behind official slices.
  state.gridPreview.forEach((rect) => { const r = imageToScreen(rect); vctx.save(); vctx.fillStyle = tokens.gridOverlayFill; vctx.strokeStyle = tokens.gridOverlay; vctx.setLineDash([4, 4]); vctx.lineWidth = 1; vctx.fillRect(r.x, r.y, r.width, r.height); vctx.strokeRect(r.x + .5, r.y + .5, r.width - 1, r.height - 1); vctx.restore(); });
  state.candidates.forEach((rect, i) => { const r = imageToScreen(rect); const candidateSelected = state.candidateSelectedIds.has(rect.id); vctx.save(); vctx.fillStyle = candidateSelected ? tokens.candidateSelectedFill : tokens.candidateFill; vctx.strokeStyle = candidateSelected ? tokens.candidateSelected : tokens.candidate; vctx.lineWidth = candidateSelected ? 2 : 1.5; vctx.setLineDash([5, 4]); vctx.fillRect(r.x, r.y, r.width, r.height); vctx.strokeRect(r.x + .5, r.y + .5, Math.max(0, r.width - 1), Math.max(0, r.height - 1)); vctx.setLineDash([]); vctx.fillStyle = tokens.candidateLabel; vctx.font = "12px 'DM Mono', monospace"; vctx.fillText(`A${String(i + 1).padStart(2, "0")}`, r.x + 4, r.y + 14); vctx.restore(); });
  state.slices.forEach((slice, i) => drawSliceOverlay(slice, i, tokens));
  if (state.draft) { const r = imageToScreen(normalizeSlice(state.draft)); vctx.save(); vctx.fillStyle = tokens.selectionFill; vctx.strokeStyle = tokens.selection; vctx.lineWidth = 1.5; vctx.setLineDash([6, 4]); vctx.fillRect(r.x, r.y, r.width, r.height); vctx.strokeRect(r.x + .5, r.y + .5, r.width - 1, r.height - 1); vctx.restore(); }
  if (state.marquee) { const r = imageToScreen(normalizeSlice(state.marquee)); vctx.save(); vctx.fillStyle = tokens.marqueeFill; vctx.strokeStyle = tokens.selection; vctx.lineWidth = 1; vctx.setLineDash([4, 3]); vctx.fillRect(r.x, r.y, r.width, r.height); vctx.strokeRect(r.x + .5, r.y + .5, Math.max(0, r.width - 1), Math.max(0, r.height - 1)); vctx.restore(); }
}

function drawRulerGuides(ctx, imageRect, tokens = canvasTokens()) {
  if (state.transform.scale < .32) return;
  ctx.save(); ctx.globalAlpha = .42; ctx.strokeStyle = tokens.canvasGuide; ctx.lineWidth = 1; ctx.setLineDash([2, 7]);
  ctx.beginPath(); ctx.moveTo(imageRect.x, 0); ctx.lineTo(imageRect.x, state.stageSize.height); ctx.moveTo(imageRect.x + imageRect.width, 0); ctx.lineTo(imageRect.x + imageRect.width, state.stageSize.height); ctx.moveTo(0, imageRect.y); ctx.lineTo(state.stageSize.width, imageRect.y); ctx.moveTo(0, imageRect.y + imageRect.height); ctx.lineTo(state.stageSize.width, imageRect.y + imageRect.height); ctx.stroke(); ctx.restore();
}

function drawSliceOverlay(slice, index, tokens = canvasTokens()) {
  const r = imageToScreen(slice); const selected = state.selectedIds.has(slice.id); const contrast = state.highContrast;
  vctx.save();
  vctx.fillStyle = selected ? tokens.selectionFill : tokens.sliceFill;
  vctx.strokeStyle = selected ? tokens.selection : contrast ? tokens.sliceBorderStrong : tokens.sliceBorder;
  vctx.lineWidth = selected ? 1.5 : 1; vctx.fillRect(r.x, r.y, r.width, r.height); vctx.strokeRect(r.x + .5, r.y + .5, Math.max(0, r.width - 1), Math.max(0, r.height - 1));
  const label = `${String(index + 1).padStart(2, "0")}  ${slice.name}`;
  if (r.width > 45 && r.height > 22 && state.transform.scale > .35) { const labelW = Math.min(r.width - 4, Math.max(48, label.length * 6.6 + 12)); vctx.fillStyle = selected ? tokens.labelSelectedBg : tokens.labelBg; vctx.fillRect(r.x + 3, r.y + 3, labelW, 19); vctx.fillStyle = selected ? tokens.labelSelectedText : tokens.labelText; vctx.font = "12px 'DM Mono', monospace"; vctx.fillText(label.slice(0, 38), r.x + 7, r.y + 16); }
  if (selected) drawHandles(r, tokens);
  vctx.restore();
}

function drawHandles(r, tokens = canvasTokens()) {
  const size = 6; const points = [[r.x, r.y], [r.x + r.width / 2, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height / 2], [r.x + r.width, r.y + r.height / 2], [r.x, r.y + r.height], [r.x + r.width / 2, r.y + r.height], [r.x + r.width, r.y + r.height]];
  vctx.fillStyle = tokens.handleFill; vctx.strokeStyle = tokens.handleStroke; vctx.lineWidth = 1;
  points.forEach(([x, y]) => { vctx.beginPath(); vctx.rect(x - size / 2, y - size / 2, size, size); vctx.fill(); vctx.stroke(); });
}

function renderThumb(targetCtx, targetCanvas, data) {
  const w = targetCanvas.width, h = targetCanvas.height; targetCtx.clearRect(0, 0, w, h); targetCtx.fillStyle = cssToken("--checker-base", "#222b34"); targetCtx.fillRect(0, 0, w, h);
  if (!data) return; const scale = Math.min((w - 8) / data.width, (h - 8) / data.height); const dw = data.width * scale, dh = data.height * scale; targetCtx.imageSmoothingEnabled = true;
  if (data === getWorkingImageData() && state.sourceCanvas.width === data.width && state.sourceCanvas.height === data.height) targetCtx.drawImage(state.sourceCanvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
  else { const c = document.createElement("canvas"); c.width = data.width; c.height = data.height; c.getContext("2d").putImageData(nativeImageData(data), 0, 0); targetCtx.drawImage(c, (w - dw) / 2, (h - dh) / 2, dw, dh); }
}

function renderCleanThumb() { renderThumb(cleanCtx, cleanThumb, state.pendingCleaned || state.cleanedImageData || state.originalImageData); }

function renderSliceList() {
  const list = $("#sliceList"); list.replaceChildren();
  state.slices.forEach((slice, i) => {
    const row = document.createElement("div"); row.className = `slice-row${state.selectedIds.has(slice.id) ? " active" : ""}`; row.dataset.id = slice.id;
    const thumb = document.createElement("div"); thumb.className = "slice-thumb"; const c = document.createElement("canvas"); c.width = 44; c.height = 44; thumb.append(c);
    const info = document.createElement("div"); info.className = "slice-row-info"; info.innerHTML = `<div class="slice-row-name"></div><div class="slice-row-dim">${slice.width} × ${slice.height}</div>`; info.firstElementChild.textContent = slice.name;
    const index = document.createElement("span"); index.className = "slice-row-index"; index.textContent = String(i + 1).padStart(2, "0"); row.append(thumb, info, index); list.append(row);
    const crop = document.createElement("canvas"); crop.width = Math.max(1, slice.width); crop.height = Math.max(1, slice.height); crop.getContext("2d").drawImage(state.sourceCanvas, -slice.x, -slice.y); const tctx = c.getContext("2d"); const sc = Math.min(40 / crop.width, 40 / crop.height); tctx.drawImage(crop, (44 - crop.width * sc) / 2, (44 - crop.height * sc) / 2, crop.width * sc, crop.height * sc);
    row.addEventListener("click", (e) => { if (e.shiftKey) { if (state.selectedIds.has(slice.id)) state.selectedIds.delete(slice.id); else state.selectedIds.add(slice.id); } else state.selectedIds = new Set([slice.id]); renderAll(); });
  });
  $("#sliceCount").textContent = `${state.slices.length} 个`;
  $("#exportCount").textContent = `${state.slices.length} 个切片`;
  $("#exportSelectedBtn").disabled = state.selectedIds.size === 0;
}

function renderInspector() {
  const selected = getPrimarySelected(); const has = !!selected;
  $("#noSelection").hidden = has; $("#selectionInspector").hidden = !has; $("#selectedChip").textContent = has ? `${state.selectedIds.size} 选中` : "—"; $("#inspectorSubtitle").textContent = has ? `${selected.width} × ${selected.height} px · ${selected.x}, ${selected.y}` : "选择一个切片开始编辑";
  if (!has) { $("#selectionStatus").textContent = "未选择切片"; return; }
  $("#sliceNameInput").value = selected.name; $("#sliceXInput").value = selected.x; $("#sliceYInput").value = selected.y; $("#sliceWInput").value = selected.width; $("#sliceHInput").value = selected.height; $("#keepPaddingToggle").checked = !!selected.keepPadding;
  $("#selectionStatus").textContent = state.selectedIds.size > 1 ? `${state.selectedIds.size} 个切片已选择` : `${selected.name} · ${selected.width} × ${selected.height}`;
}

function getPrimarySelected() { const id = [...state.selectedIds][0]; return state.slices.find((s) => s.id === id) || null; }

function updateImageLabels() {
  const data = getWorkingImageData();
  if (!data) {
    $("#assetName").textContent = "未选择图片";
    $("#assetSize").textContent = "—";
    $("#assetFormat").textContent = "PNG";
    $("#assetStatus").textContent = "等待导入";
    $("#canvasFileName").textContent = "未选择图片";
    $("#canvasDimensions").textContent = "—";
    $("#gridImageSize").textContent = "—";
    if (state.assetDataRef !== null) { renderThumb(assetCtx, assetThumb, null); state.assetDataRef = null; }
    return;
  }
  const dims = `${data.width} × ${data.height}`; $("#assetName").textContent = state.imageName; $("#assetSize").textContent = `${dims} px`; $("#assetFormat").textContent = state.fileFormat || "PNG"; $("#assetStatus").textContent = "本地已载入"; $("#canvasFileName").textContent = state.imageName; $("#canvasDimensions").textContent = dims; $("#gridImageSize").textContent = dims; if (state.assetDataRef !== data) { renderThumb(assetCtx, assetThumb, data); state.assetDataRef = data; }
}

function renderAll() { updateImageLabels(); renderSliceList(); renderInspector(); renderDetectList(); renderCanvas(); updateZoomLabel(); updatePreviewButtons(); updateHistoryButtons(); const applyBtn = $("#applyCleanBtn"); if (applyBtn) applyBtn.disabled = !state.pendingCleaned; }
function updateHistoryButtons() { const undoBtn = $("#undoBtn"), redoBtn = $("#redoBtn"); if (undoBtn) undoBtn.disabled = state.history.length === 0; if (redoBtn) redoBtn.disabled = state.redo.length === 0; }
function updatePreviewButtons() { $$("[data-preview]").forEach((btn) => btn.classList.toggle("active", btn.dataset.preview === state.preview)); }

function addSlice(rect, name) { const data = getWorkingImageData(); const safe = data ? clampRectLocal(rect, data.width, data.height) : normalizeSlice(rect); const slice = normalizeSlice(safe, name || `sprite_${String(state.slices.length + 1).padStart(2, "0")}`); state.slices.push(slice); state.selectedIds = new Set([slice.id]); return slice; }
function clampRectLocal(rect, width, height) { if (width <= 0 || height <= 0) return { x: 0, y: 0, width: 1, height: 1 }; const leftRaw = Math.round(Math.min(rect.x, rect.x + rect.width)); const topRaw = Math.round(Math.min(rect.y, rect.y + rect.height)); const rightRaw = Math.round(Math.max(rect.x, rect.x + rect.width)); const bottomRaw = Math.round(Math.max(rect.y, rect.y + rect.height)); const x = Math.max(0, Math.min(width - 1, leftRaw)); const y = Math.max(0, Math.min(height - 1, topRaw)); const right = Math.max(x + 1, Math.min(width, rightRaw)); const bottom = Math.max(y + 1, Math.min(height, bottomRaw)); return { x, y, width: right - x, height: bottom - y }; }

function removeSelected() { if (!state.selectedIds.size) return; pushHistory(); state.slices = state.slices.filter((s) => !state.selectedIds.has(s.id)); state.selectedIds.clear(); renderAll(); toast("已删除切片", "success"); }
function duplicateSelected() { const selected = state.slices.filter((s) => state.selectedIds.has(s.id)); if (!selected.length) return; pushHistory(); const copies = selected.map((s, i) => ({ ...s, id: uid("slice"), name: `${s.name}_copy`, x: Math.min((getWorkingImageData()?.width || 99999) - s.width, s.x + 12), y: Math.min((getWorkingImageData()?.height || 99999) - s.height, s.y + 12) })); state.slices.push(...copies); state.selectedIds = new Set(copies.map((s) => s.id)); renderAll(); toast(`已复制 ${copies.length} 个切片`, "success"); }

function moveSelected(dx, dy) { if (!state.selectedIds.size) return; const data = getWorkingImageData(); const grid = Number($("#gridSnapSelect")?.value || 0); if (grid) { dx = Math.round(dx / grid) * grid || Math.sign(dx) * grid; dy = Math.round(dy / grid) * grid || Math.sign(dy) * grid; } pushHistory(); state.slices.filter((s) => state.selectedIds.has(s.id)).forEach((s) => { s.x = Math.max(0, Math.min(data.width - s.width, s.x + dx)); s.y = Math.max(0, Math.min(data.height - s.height, s.y + dy)); }); renderAll(); }

function applyInspectorField(field, raw) {
  const selected = getPrimarySelected(); if (!selected) return;
  if (field === "name") {
    const nextName = String(raw).trim() || "sprite";
    if (nextName === selected.name) return;
    pushHistory();
    selected.name = nextName;
    renderAll();
    return;
  }
  const value = Math.round(Number(raw)); if (!Number.isFinite(value)) return;
  const data = getWorkingImageData();
  let nextValue;
  if (field === "x" || field === "y") { const key = field; const max = key === "x" ? data.width - selected.width : data.height - selected.height; nextValue = Math.max(0, Math.min(max, value)); }
  else { const key = field === "w" ? "width" : "height"; nextValue = Math.max(1, Math.min(key === "width" ? data.width - selected.x : data.height - selected.y, value)); }
  const key = field === "w" ? "width" : field === "h" ? "height" : field;
  if (selected[key] === nextValue) return;
  pushHistory(); selected[key] = nextValue;
  renderAll();
}

function switchMode(mode) { state.mode = mode; $$(".tool-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode)); stage.style.cursor = mode === "pan" ? "grab" : mode === "draw" ? "crosshair" : "default"; }

function pointerDown(e) {
  if (!state.originalImageData) return;
  if (e.button === 2) return;
  const p = getPointer(e); const img = snapPoint(screenToImage(p.x, p.y));
  const temporaryPan = state.spaceDown || e.button === 1 || state.mode === "pan";
  if (temporaryPan) { state.drag = { type: "pan", start: p, origin: { ...state.transform } }; stage.setPointerCapture?.(e.pointerId); return; }
  if (state.mode === "draw") { state.draft = { x: img.x, y: img.y, width: 0, height: 0 }; state.drag = { type: "draw", start: img }; stage.setPointerCapture?.(e.pointerId); renderCanvas(); return; }
  const candidateHit = hitCandidate(img);
  if (candidateHit && state.candidates.length) {
    if (e.shiftKey) { if (state.candidateSelectedIds.has(candidateHit.id)) state.candidateSelectedIds.delete(candidateHit.id); else state.candidateSelectedIds.add(candidateHit.id); renderDetectList(); renderCanvas(); return; }
    state.candidateSelectedIds = new Set([candidateHit.id]);
    const handle = getResizeHandle(candidateHit, img);
    pushHistory();
    state.drag = { type: handle ? "candidate-resize" : "candidate-move", candidate: candidateHit, handle, start: img, original: { ...candidateHit } };
    stage.setPointerCapture?.(e.pointerId); renderDetectList(); renderCanvas(); return;
  }
  const hit = hitSlice(img);
  if (!hit) { if (!e.shiftKey) state.selectedIds.clear(); state.drag = { type: "marquee", start: img, additive: e.shiftKey }; state.marquee = { x: img.x, y: img.y, width: 0, height: 0 }; stage.setPointerCapture?.(e.pointerId); renderCanvas(); return; }
  if (e.shiftKey) { if (state.selectedIds.has(hit.id)) state.selectedIds.delete(hit.id); else state.selectedIds.add(hit.id); renderAll(); return; }
  if (!state.selectedIds.has(hit.id)) state.selectedIds = new Set([hit.id]);
  const handle = getResizeHandle(hit, img); pushHistory();
  state.drag = { type: handle ? "resize" : "move", slice: hit, handle, start: img, original: { ...hit }, origins: state.slices.filter((s) => state.selectedIds.has(s.id)).map((s) => ({ id: s.id, x: s.x, y: s.y })) };
  stage.setPointerCapture?.(e.pointerId); renderAll();
}

function pointerMove(e) {
  if (!state.originalImageData) return; const p = getPointer(e); const imgRaw = screenToImage(p.x, p.y); const img = snapPoint(imgRaw); $("#cursorPosition").textContent = `X ${Math.round(imgRaw.x)} · Y ${Math.round(imgRaw.y)}`;
  if (!state.drag) { const hit = hitSlice(img); stage.style.cursor = state.mode === "draw" ? "crosshair" : state.mode === "pan" || state.spaceDown ? "grab" : hit ? (getResizeHandle(hit, img) ? "nwse-resize" : "move") : "default"; return; }
  if (state.drag.type === "pan") { state.transform.x = state.drag.origin.x + p.x - state.drag.start.x; state.transform.y = state.drag.origin.y + p.y - state.drag.start.y; renderCanvas(); return; }
  if (state.drag.type === "draw") { const start = state.drag.start; const rect = normalizeSlice({ x: start.x, y: start.y, width: img.x - start.x, height: img.y - start.y }); state.draft = rect; renderCanvas(); return; }
  if (state.drag.type === "marquee") { state.marquee = { x: state.drag.start.x, y: state.drag.start.y, width: img.x - state.drag.start.x, height: img.y - state.drag.start.y }; renderCanvas(); return; }
  if (state.drag.type === "move") { const dx = img.x - state.drag.start.x, dy = img.y - state.drag.start.y; const data = getWorkingImageData(); state.drag.origins.forEach((origin) => { const s = state.slices.find((x) => x.id === origin.id); if (!s) return; s.x = Math.max(0, Math.min(data.width - s.width, origin.x + dx)); s.y = Math.max(0, Math.min(data.height - s.height, origin.y + dy)); }); renderCanvas(); return; }
  if (state.drag.type === "resize") { resizeSlice(state.drag.slice, state.drag.original, state.drag.handle, img); renderCanvas(); }
  if (state.drag.type === "candidate-move") { const c = state.drag.candidate, o = state.drag.original; const dx = img.x - state.drag.start.x, dy = img.y - state.drag.start.y; const data = getWorkingImageData(); c.x = Math.max(0, Math.min(data.width - c.width, Math.round(o.x + dx))); c.y = Math.max(0, Math.min(data.height - c.height, Math.round(o.y + dy))); renderCanvas(); }
  if (state.drag.type === "candidate-resize") { resizeSlice(state.drag.candidate, state.drag.original, state.drag.handle, img); renderCanvas(); }
}

function resizeSlice(slice, original, handle, p) {
  const data = getWorkingImageData(); let left = original.x, top = original.y, right = original.x + original.width, bottom = original.y + original.height;
  if (handle.includes("w")) left = Math.min(p.x, right - 1); if (handle.includes("e")) right = Math.max(p.x, left + 1); if (handle.includes("n")) top = Math.min(p.y, bottom - 1); if (handle.includes("s")) bottom = Math.max(p.y, top + 1);
  left = Math.max(0, left); top = Math.max(0, top); right = Math.min(data.width, right); bottom = Math.min(data.height, bottom); slice.x = Math.round(left); slice.y = Math.round(top); slice.width = Math.max(1, Math.round(right - left)); slice.height = Math.max(1, Math.round(bottom - top));
}

function pointerUp(e) {
  if (!state.drag) return; if (state.drag.type === "draw" && state.draft) { const draft = state.draft; const rect = normalizeSlice(draft); if (Math.abs(draft.width) >= 1 && Math.abs(draft.height) >= 1) { pushHistory(); const slice = addSlice(rect); toast(`已创建 ${slice.name}`, "success"); } state.draft = null; }
  if (state.drag.type === "marquee" && state.marquee) { const box = normalizeSlice(state.marquee); const selected = state.slices.filter((s) => s.x < box.x + box.width && s.x + s.width > box.x && s.y < box.y + box.height && s.y + s.height > box.y).map((s) => s.id); state.selectedIds = state.drag.additive ? new Set([...state.selectedIds, ...selected]) : new Set(selected); state.marquee = null; }
  state.drag = null; stage.releasePointerCapture?.(e.pointerId); renderAll();
}

function handleWheel(e) { e.preventDefault(); const p = getPointer(e); const factor = e.deltaY < 0 ? 1.1 : .9; setZoom(state.transform.scale * factor, p.x, p.y); }

function handleKeyDown(e) {
  const tag = e.target?.tagName?.toLowerCase(); if (["input", "textarea", "select"].includes(tag)) return;
  if (e.code === "Space") { state.spaceDown = true; stage.style.cursor = "grab"; e.preventDefault(); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelected(); return; }
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); return; }
  if (e.key === "ArrowLeft") { e.preventDefault(); moveSelected(e.shiftKey ? -10 : -1, 0); }
  if (e.key === "ArrowRight") { e.preventDefault(); moveSelected(e.shiftKey ? 10 : 1, 0); }
  if (e.key === "ArrowUp") { e.preventDefault(); moveSelected(0, e.shiftKey ? -10 : -1); }
  if (e.key === "ArrowDown") { e.preventDefault(); moveSelected(0, e.shiftKey ? 10 : 1); }
  if (e.key.toLowerCase() === "v") switchMode("select"); if (e.key.toLowerCase() === "r") switchMode("draw"); if (e.key.toLowerCase() === "h") switchMode("pan"); if (e.key.toLowerCase() === "f") fitToWindow(); if (e.key === "1") setZoom(1);
}
function handleKeyUp(e) { if (e.code === "Space") { state.spaceDown = false; stage.style.cursor = state.mode === "pan" ? "grab" : "default"; } }

async function loadFile(file) {
  const fileType = String(file?.type || "").toLowerCase(); const fileName = String(file?.name || "");
  if (!file || !( /^image\/(png|jpeg|jpg|webp)$/.test(fileType) || /\.(png|jpe?g|webp)$/i.test(fileName) )) return toast("请选择 PNG、JPG 或 WebP 图片", "error");
  try {
    let drawable;
    if (typeof createImageBitmap === "function") {
      try { drawable = await createImageBitmap(file); } catch (_) { /* fall through to Image decode */ }
    }
    if (!drawable) {
      const url = URL.createObjectURL(file);
      drawable = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => { URL.revokeObjectURL(url); resolve(image); }; image.onerror = (err) => { URL.revokeObjectURL(url); reject(err); }; image.src = url; });
    }
    const canvas = document.createElement("canvas"); canvas.width = drawable.width || drawable.naturalWidth; canvas.height = drawable.height || drawable.naturalHeight; const ctx = canvas.getContext("2d", { willReadFrequently: true }); ctx.drawImage(drawable, 0, 0); setImageData(ctx.getImageData(0, 0, canvas.width, canvas.height), file.name.replace(/\.[^.]+$/, ""), file.name); if (typeof drawable.close === "function") drawable.close(); toast(`已载入 ${file.name} · ${canvas.width} × ${canvas.height}`, "success");
  } catch (err) { console.error(err); toast("图片读取失败，请换一张 PNG 重试", "error"); }
}

function runAutoDetect() {
  const data = getWorkingImageData(); if (!data) return;
  pushHistory();
  const btn = $("#runDetectBtn"); btn.disabled = true; btn.innerHTML = "<span class=\"spinner\"></span>正在扫描…";
  requestAnimationFrame(() => { try {
    const result = detectTransparentRegions(data, { alphaThreshold: Number($("#alphaThreshold").value), minPixelArea: Number($("#minAreaInput").value), minWidth: Number($("#minWidthInput").value), minHeight: Number($("#minHeightInput").value), mergeDistance: Number($("#mergeDistanceInput").value), mergeAdjacentFragments: $("#mergeFragmentsToggle").checked, retainSemiTransparent: $("#keepEffectsToggle").checked, autoCrop: $("#autoCropToggle").checked });
    state.candidates = result.rects.map((r, i) => ({ ...r, id: `candidate-${i + 1}`, name: `auto_${String(i + 1).padStart(3, "0")}` })); state.candidateSelectedIds.clear(); state.detectStatus = "results"; renderDetectList(); renderCanvas(); toast(`识别完成：找到 ${state.candidates.length} 个候选区域`, "success");
  } catch (err) { console.error(err); toast(`识别失败：${err.message}`, "error"); } finally { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="12" r="3"/></svg>扫描透明区域'; } });
}

function renderDetectList() {
  const list = $("#detectResultList");
  list.replaceChildren();
  state.candidates.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = `detect-row${state.candidateSelectedIds.has(r.id) ? " selected" : ""}`;
    row.innerHTML = `<span class="detect-swatch"></span><span>A${String(i + 1).padStart(2, "0")}</span><span>${r.width} × ${r.height}</span><button title="删除候选">×</button>`;
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (e.shiftKey) { if (state.candidateSelectedIds.has(r.id)) state.candidateSelectedIds.delete(r.id); else state.candidateSelectedIds.add(r.id); }
      else state.candidateSelectedIds = new Set([r.id]);
      renderDetectList(); renderCanvas();
    });
    row.querySelector("button").addEventListener("click", () => { pushHistory(); state.candidates.splice(i, 1); state.candidateSelectedIds.delete(r.id); renderDetectList(); renderCanvas(); });
    list.append(row);
  });
  const hasCandidates = state.candidates.length > 0;
  $("#detectCount").textContent = hasCandidates ? `${state.candidates.length} 个候选` : state.detectStatus === "accepted" ? "已接受" : state.detectStatus === "results" ? "0 个候选" : "尚未扫描";
  $("#detectEmpty").hidden = hasCandidates;
  $("#detectResultList").hidden = !hasCandidates;
  $("#acceptDetectBtn").hidden = !hasCandidates;
  $("#mergeCandidatesBtn").hidden = !hasCandidates || state.candidateSelectedIds.size < 2;
  $("#detectEmpty span").textContent = state.detectStatus === "accepted" ? "候选已转为正式切片" : "扫描后结果会显示在这里";
}

function mergeSelectedCandidates() { const chosen = state.candidates.filter((r) => state.candidateSelectedIds.has(r.id)); if (chosen.length < 2) return toast("请先选择至少两个候选框", "warn"); const merged = mergeRects(chosen); if (!merged) return; pushHistory(); const firstIndex = Math.min(...chosen.map((r) => state.candidates.indexOf(r))); state.candidates = state.candidates.filter((r) => !state.candidateSelectedIds.has(r.id)); const mergedCandidate = { ...merged, id: uid("candidate"), name: `auto_${String(firstIndex + 1).padStart(3, "0")}` }; state.candidates.splice(firstIndex, 0, mergedCandidate); state.candidateSelectedIds = new Set([mergedCandidate.id]); $("#detectCount").textContent = `${state.candidates.length} 个候选`; renderDetectList(); renderCanvas(); toast("已合并所选候选框", "success"); }

function acceptDetection() { if (!state.candidates.length) return; pushHistory(); const created = state.candidates.map((r, i) => ({ ...normalizeSlice({ ...r, id: uid("slice") }, r.name || `auto_${String(i + 1).padStart(3, "0")}`), auto: true })); state.slices.push(...created); state.selectedIds = new Set(created.map((s) => s.id)); state.candidates = []; state.candidateSelectedIds.clear(); state.detectStatus = "accepted"; renderDetectList(); renderAll(); toast(`已接受 ${created.length} 个切片`, "success"); }

function scheduleBackgroundPreview() { clearTimeout(cleanPreviewTimer); if (!state.originalImageData) return; cleanPreviewTimer = setTimeout(() => runBackgroundClean(true), 180); }

function runBackgroundClean(silent = false) {
  const data = getWorkingImageData(); if (!data) return; const btn = $("#runCleanBtn"); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>正在清理…';
  requestAnimationFrame(() => { try {
    const cleanOptions = { backgroundColors: state.backgroundColors.length ? state.backgroundColors : undefined, colorThreshold: Number($("#colorTolerance").value), feather: $("#protectEdgesToggle").checked ? 5 : 0, mode: $("#floodFillToggle").checked ? "flood" : "global", sampleCorners: !state.backgroundColorManual };
    if (state.backgroundColorManual) cleanOptions.backgroundColor = $("#bgColorInput").value;
    const result = cleanFakeTransparency(data, cleanOptions); state.pendingCleaned = result.imageData; state.preview = "cleaned"; $("#applyCleanBtn").disabled = false; renderCleanThumb(); renderCanvas(); updatePreviewButtons(); const percent = Math.round((result.removedPixels / (data.width * data.height)) * 100); if (!silent) toast(`预览已生成 · 清除 ${result.removedPixels.toLocaleString()} 个像素 (${percent}%)`, percent > 35 ? "warn" : "success");
  } catch (err) { console.error(err); toast(`清理失败：${err.message}`, "error"); } finally { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 15.5 14.5 6l3.5 3.5-9.5 9.5H5Z"/><path d="M4 20h16"/></svg>清理背景'; } });
}

function sampleBackground() { const data = getWorkingImageData(); if (!data) return; const colors = sampleCornerColors(data, { sampleRadius: 10 }); if (!colors.length) return toast("四角没有找到可取样像素", "warn"); state.backgroundColors = colors; state.backgroundColorManual = false; const c = colors.reduce((a, b) => ({ r: a.r + b.r, g: a.g + b.g, b: a.b + b.b }), { r: 0, g: 0, b: 0 }); c.r = Math.round(c.r / colors.length); c.g = Math.round(c.g / colors.length); c.b = Math.round(c.b / colors.length); const hex = `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`; $("#bgColorInput").value = hex; $("#bgColorSwatch").style.background = hex; $("#sampleColorText").textContent = `${hex} · ${colors.length} 个背景色`; scheduleBackgroundPreview(); toast(`已从四角取样 ${colors.length} 种背景色`, "success"); }

function applyBackgroundClean() { if (!state.pendingCleaned) return; clearTimeout(cleanPreviewTimer); pushHistory(); state.cleanedImageData = cloneData(state.pendingCleaned); state.pendingCleaned = null; syncImageCanvas(); state.preview = "cleaned"; updateImageLabels(); renderCleanThumb(); renderAll(); $("#applyCleanBtn").disabled = true; toast("背景清理已应用，可用 Ctrl+Z 撤销", "success"); }
function resetBackgroundClean() { clearTimeout(cleanPreviewTimer); if (state.cleanedImageData) pushHistory(); state.pendingCleaned = null; state.cleanedImageData = null; state.preview = "image"; syncImageCanvas(); $("#applyCleanBtn").disabled = true; updateImageLabels(); renderCleanThumb(); renderAll(); toast("已还原原图，可用 Ctrl+Z 撤销", "info"); }

function getGridNumber(id, fallback = 0) { const value = $(id).value.trim(); return value === "" ? fallback : Number(value); }
function gridOrderValue() { const value = $("#gridOrder").value; return value === "bl" ? "bottom-left" : value === "rtl" ? "rtl" : "row-major"; }
function previewGrid() { const data = getWorkingImageData(); if (!data) return; try { const result = generateGridSlices(data, { columns: getGridNumber("#gridCols", 1), rows: getGridNumber("#gridRows", 1), cellWidth: getGridNumber("#gridCellW", undefined), cellHeight: getGridNumber("#gridCellH", undefined), spacingX: getGridNumber("#gridGapX", 0), spacingY: getGridNumber("#gridGapY", 0), margin: getGridNumber("#gridMargin", 0), skipEmpty: $("#skipEmptyToggle").checked, trim: $("#gridCropToggle").checked, order: gridOrderValue(), namePrefix: "grid" }); state.gridPreview = result.rects; renderCanvas(); } catch (err) { console.warn(err); } }
function generateGrid() { const data = getWorkingImageData(); if (!data) return; try { const result = generateGridSlices(data, { columns: getGridNumber("#gridCols", 1), rows: getGridNumber("#gridRows", 1), cellWidth: getGridNumber("#gridCellW", undefined), cellHeight: getGridNumber("#gridCellH", undefined), spacingX: getGridNumber("#gridGapX", 0), spacingY: getGridNumber("#gridGapY", 0), margin: getGridNumber("#gridMargin", 0), skipEmpty: $("#skipEmptyToggle").checked, trim: $("#gridCropToggle").checked, order: gridOrderValue(), namePrefix: "grid" }); pushHistory(); const created = result.rects.map((r) => normalizeSlice({ ...clampRectLocal(r, data.width, data.height), id: uid("slice") }, r.name)); state.slices.push(...created); state.selectedIds = new Set(created.map((s) => s.id)); state.gridPreview = []; renderAll(); toast(`已生成 ${created.length} 个网格切片`, "success"); } catch (err) { toast(`网格生成失败：${err.message}`, "error"); } }

function formatExportName(name, index, fallback) {
  const raw = String(name || fallback || "sprite");
  const ordinal = index + 1;
  // `{n}` is a natural number; `{nn}`/`{nnn}` opt into zero padding while
  // retaining compatibility with the short placeholder shown in the UI.
  return raw.replace(/\{(n+)\}/gi, (_, token) => String(ordinal).padStart(token.length, "0"));
}

async function exportSlices(selectedOnly = false) {
  const data = getWorkingImageData();
  if (!data || !state.slices.length) return toast("还没有可导出的切片", "warn");
  const slices = selectedOnly ? state.slices.filter((s) => state.selectedIds.has(s.id)) : state.slices;
  if (!slices.length) return toast("请先选择切片", "warn");
  const btn = selectedOnly ? $("#exportSelectedBtn") : $("#exportAllBtn");
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner dark"></span>处理中…';
  try {
    const useNames = $("#exportMetaToggle").checked;
    const trim = $("#exportTrimToggle").checked;
    const namedSlices = slices.map((s, i) => ({
      ...s,
      name: useNames
        ? formatExportName(s.name, i, `sprite_${String(i + 1).padStart(3, "0")}`)
        : `${state.imageName}_${String(i + 1).padStart(3, "0")}`,
    }));
    const result = await exportSlicesAsPng(data, namedSlices, { trim, alphaThreshold: 1 });
    downloadPngFiles(result.files, { delay: 110 });
    if (useNames) downloadMetadata(namedSlices, data, { trim });
    toast(`已准备 ${result.files.length} 个 PNG${useNames ? " 与坐标清单" : ""}，浏览器将开始下载`, "success");
  } catch (err) {
    console.error(err);
    toast(`导出失败：${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function buildMetadataBlob(slices, data, options = {}) {
  const payload = {
    format: "SpriteLab-Atlas",
    version: 1,
    image: state.fileName,
    size: { width: data.width, height: data.height },
    sprites: slices.map((s, i) => ({
      name: s.name,
      index: i,
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      rotated: false,
      trimmed: !!options.trim && !s.keepPadding,
    })),
  };
  return {
    name: `${state.imageName || "atlas"}.atlas.json`,
    blob: new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
  };
}

function downloadMetadata(slices, data, options = {}) {
  const file = buildMetadataBlob(slices, data, options);
  const href = URL.createObjectURL(file.blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = file.name;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(href); }, 1000);
}

/** Package the selected/all slices into one local ZIP download. */
async function exportSlicesZip(selectedOnly = false) {
  const data = getWorkingImageData();
  if (!data || !state.slices.length) return toast("还没有可导出的切片", "warn");
  const slices = selectedOnly ? state.slices.filter((s) => state.selectedIds.has(s.id)) : state.slices;
  if (!slices.length) return toast("请先选择切片", "warn");
  const btn = $("#exportZipBtn");
  if (!btn) return toast("当前页面未启用 ZIP 导出按钮", "warn");
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner dark"></span>打包中…';
  try {
    const useNames = $("#exportMetaToggle").checked;
    const trim = $("#exportTrimToggle").checked;
    const namedSlices = slices.map((s, i) => ({
      ...s,
      name: useNames
        ? formatExportName(s.name, i, `sprite_${String(i + 1).padStart(3, "0")}`)
        : `${state.imageName}_${String(i + 1).padStart(3, "0")}`,
    }));
    const result = await exportSlicesAsPng(data, namedSlices, { trim, alphaThreshold: 1 });
    const extraFiles = useNames ? [buildMetadataBlob(namedSlices, data, { trim })] : [];
    const zip = await createZipBlob(result.files, { extraFiles });
    const suffix = selectedOnly ? "-selected" : "";
    downloadZipBlob(zip, `${state.imageName || "sprites"}${suffix}.zip`);
    toast(`已下载 ZIP：${result.files.length} 个 PNG${useNames ? " 与坐标清单" : ""}`, "success");
  } catch (err) {
    console.error(err);
    toast(`ZIP 导出失败：${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function setInspectorTab(panel) {
  $$(".inspector-tab").forEach((b) => b.classList.toggle("active", b.dataset.panel === panel));
  $$(".inspector-panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${panel}`));
  if (panel === "clean") renderCleanThumb();
  if (panel === "grid") {
    previewGrid();
  } else {
    // Grid guides are a temporary preview owned by the grid panel. Leaving
    // the panel must repaint immediately, without deleting generated slices.
    state.gridPreview = [];
    renderCanvas();
  }
}

function toast(message, type = "info") { const region = $("#toastRegion"); const node = document.createElement("div"); node.className = `toast ${type}`; node.innerHTML = `<div class="toast-icon">${type === "error" ? "!" : type === "warn" ? "△" : type === "success" ? "✓" : "·"}</div><div><b>${type === "error" ? "操作未完成" : type === "warn" ? "请注意" : type === "success" ? "完成" : "提示"}</b><span></span></div>`; node.querySelector("span").textContent = message; region.append(node); setTimeout(() => node.remove(), 3600); }

function openModal(id) { const m = $(`#${id}`); if (m) m.hidden = false; }
function closeModal(id) { const m = $(`#${id}`); if (m) m.hidden = true; }

function bindEvents() {
  window.addEventListener("resize", resizeViewport);
  stage.addEventListener("pointerdown", pointerDown); stage.addEventListener("pointermove", pointerMove); stage.addEventListener("pointerup", pointerUp); stage.addEventListener("pointercancel", pointerUp); stage.addEventListener("wheel", handleWheel, { passive: false }); stage.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", handleKeyDown); window.addEventListener("keyup", handleKeyUp);
  $("#fitBtn").addEventListener("click", fitToWindow); $("#zoomIn").addEventListener("click", () => setZoom(state.transform.scale * 1.2)); $("#zoomOut").addEventListener("click", () => setZoom(state.transform.scale / 1.2));
  $("#undoBtn").addEventListener("click", undo); $("#redoBtn").addEventListener("click", redo);
  $$(".tool-btn").forEach((b) => b.addEventListener("click", () => switchMode(b.dataset.mode)));
  const openFilePicker = () => { const input = $("#fileInput"); input.value = ""; input.click(); }; $("#replaceImageBtn").addEventListener("click", openFilePicker); $("#dropHint").addEventListener("click", openFilePicker); $("#assetDropZone").addEventListener("click", openFilePicker); $("#fileInput").addEventListener("change", (e) => { const file = e.target.files[0]; e.target.value = ""; loadFile(file); });
  [stage, $("#assetDropZone")].forEach((el) => { el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag-over"); }); el.addEventListener("dragleave", () => el.classList.remove("drag-over")); el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("drag-over"); loadFile(e.dataTransfer.files[0]); }); });
  window.addEventListener("paste", (e) => { const item = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith("image/")); if (item) loadFile(item.getAsFile()); });
  $("#autoDetectBtn").addEventListener("click", () => { setInspectorTab("detect"); runAutoDetect(); }); $("#runDetectBtn").addEventListener("click", runAutoDetect); $("#acceptDetectBtn").addEventListener("click", acceptDetection); $("#mergeCandidatesBtn").addEventListener("click", mergeSelectedCandidates);
  $("#cleanBgBtn").addEventListener("click", () => { setInspectorTab("clean"); }); $("#runCleanBtn").addEventListener("click", () => runBackgroundClean(false)); $("#sampleCornersBtn").addEventListener("click", sampleBackground); $("#applyCleanBtn").addEventListener("click", applyBackgroundClean); $("#resetCleanBtn").addEventListener("click", resetBackgroundClean); $("#bgColorInput").addEventListener("input", (e) => { state.backgroundColors = []; state.backgroundColorManual = true; $("#bgColorSwatch").style.background = e.target.value; $("#sampleColorText").textContent = "手动颜色"; scheduleBackgroundPreview(); });
  $("#gridSliceBtn").addEventListener("click", () => setInspectorTab("grid")); $("#runGridBtn").addEventListener("click", generateGrid); ["#gridCols", "#gridRows", "#gridCellW", "#gridCellH", "#gridGapX", "#gridGapY", "#gridMargin", "#gridOrder", "#skipEmptyToggle", "#gridCropToggle"].forEach((id) => $(id).addEventListener("input", previewGrid));
  $$(".inspector-tab").forEach((b) => b.addEventListener("click", () => setInspectorTab(b.dataset.panel))); $$("[data-preview]").forEach((b) => b.addEventListener("click", () => { state.preview = b.dataset.preview; renderAll(); }));
  $("#duplicateBtn").addEventListener("click", duplicateSelected); $("#deleteBtn").addEventListener("click", removeSelected); $("#clearSlicesBtn").addEventListener("click", () => { if (!state.slices.length) return; pushHistory(); state.slices = []; state.selectedIds.clear(); renderAll(); toast("已清空切片", "success"); });
  const fieldBindings = [["#sliceNameInput", "name"], ["#sliceXInput", "x"], ["#sliceYInput", "y"], ["#sliceWInput", "w"], ["#sliceHInput", "h"]]; fieldBindings.forEach(([selector, field]) => { const input = $(selector); const commit = (e) => applyInspectorField(field, e.target.value); input.addEventListener("change", commit); input.addEventListener("blur", commit); }); $("#keepPaddingToggle").addEventListener("change", (e) => { const selected = state.slices.filter((s) => state.selectedIds.has(s.id)); if (!selected.length) return; pushHistory(); selected.forEach((s) => { s.keepPadding = e.target.checked; }); renderAll(); }); $("#pixelSnapToggle").addEventListener("change", () => { $("#snapStatus").textContent = $("#pixelSnapToggle").checked ? "像素吸附" : "自由移动"; }); $("#gridSnapSelect").addEventListener("change", () => { $("#snapStatus").textContent = Number($("#gridSnapSelect").value) ? `${$("#gridSnapSelect").value} px 网格` : $("#pixelSnapToggle").checked ? "像素吸附" : "自由移动"; });
  $("#alphaThreshold").addEventListener("input", (e) => { $("#alphaThresholdOut").textContent = e.target.value; }); $("#colorTolerance").addEventListener("input", (e) => { $("#colorToleranceOut").textContent = e.target.value; scheduleBackgroundPreview(); }); $("#floodFillToggle").addEventListener("change", scheduleBackgroundPreview); $("#protectEdgesToggle").addEventListener("change", scheduleBackgroundPreview);
  $("#exportAllBtn").addEventListener("click", () => exportSlices(false)); $("#exportSelectedBtn").addEventListener("click", () => exportSlices(true)); $("#exportZipBtn").addEventListener("click", () => exportSlicesZip(false)); $("#helpBtn").addEventListener("click", () => openModal("helpModal")); $("#settingsBtn").addEventListener("click", () => openModal("settingsModal")); $("#themeToggleBtn").addEventListener("click", () => applyTheme(state.theme === "light" ? "dark" : "light")); $("#themeSelect").addEventListener("change", (e) => applyTheme(e.target.value)); $$('[data-close-modal]').forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.closeModal))); $$(".modal-backdrop").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; })); $("#rulerToggle").addEventListener("change", (e) => { state.rulerVisible = e.target.checked; renderCanvas(); }); $("#contrastToggle").addEventListener("change", (e) => { state.highContrast = e.target.checked; renderCanvas(); });
}

function init() { applyTheme(storedTheme(), false); setImageData(null, "未选择图片", "atlas.png"); bindEvents(); requestAnimationFrame(() => { resizeViewport(); fitToWindow(); }); $("#bgColorSwatch").style.background = $("#bgColorInput").value; }

init();
