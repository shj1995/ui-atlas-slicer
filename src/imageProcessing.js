/**
 * Browser-only image processing helpers for UI atlas slicing.
 *
 * The pixel algorithms in this file do not depend on React (or any other
 * framework), so they can also be used from a worker.  Coordinates are always
 * integer, top-left based (`x = 0, y = 0` is the top-left pixel).
 */

import { zipSync } from "fflate";

export const DEFAULT_DETECT_OPTIONS = Object.freeze({
  /** Pixels with alpha below this value are considered transparent. */
  alphaThreshold: 16,
  /** Four-neighbour connectivity avoids joining diagonal UI fragments. */
  connectivity: 4,
  minPixelArea: 4,
  minWidth: 1,
  minHeight: 1,
  /** Join component bounding boxes when their gap is no larger than this. */
  mergeDistance: 0,
  mergeAdjacentFragments: false,
  /** Keep a few pixels of empty space around a detected component. */
  padding: 0,
  autoCrop: true,
  retainSemiTransparent: true,
});

export const DEFAULT_CLEAN_OPTIONS = Object.freeze({
  mode: "flood",
  colorThreshold: 24,
  feather: 0,
  connectivity: 4,
  sampleCorners: true,
  sampleRadius: 8,
  minSampleAlpha: 8,
  clearRgb: false,
});

export const DEFAULT_GRID_OPTIONS = Object.freeze({
  columns: 1,
  rows: 1,
  spacingX: 0,
  spacingY: 0,
  margin: 0,
  order: "row-major",
  skipEmpty: false,
  alphaThreshold: 1,
  trim: false,
  namePrefix: "slice",
});

/**
 * A small, DOM-independent ImageData shape check.  It intentionally accepts
 * ImageData-like objects so callers can use data returned by a worker.
 */
export function isImageDataLike(value) {
  return !!value && Number.isInteger(value.width) && Number.isInteger(value.height)
    && value.width >= 0 && value.height >= 0 && value.data != null
    && value.data.length >= value.width * value.height * 4;
}

function assertImageDataLike(value, label = "imageData") {
  if (!isImageDataLike(value)) {
    throw new TypeError(`${label} must be an ImageData or ImageData-like object`);
  }
}

/** Return a detached, mutable copy of an ImageData-like value. */
export function cloneImageData(imageData) {
  assertImageDataLike(imageData);
  const data = new Uint8ClampedArray(imageData.data);
  // The ImageData constructor is not available in a few worker/test runtimes.
  if (typeof ImageData !== "undefined") {
    try { return new ImageData(data, imageData.width, imageData.height); } catch (_) { /* fall through */ }
  }
  return { data, width: imageData.width, height: imageData.height };
}

/** Create a canvas in either a window or a worker. */
export function createCanvas(width, height) {
  const w = Math.max(0, Math.round(width));
  const h = Math.max(0, Math.round(height));
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document !== "undefined" && document.createElement) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  throw new Error("A browser canvas is required for this operation");
}

/**
 * Load a File/Blob, URL, HTMLImageElement, ImageBitmap, or ImageData.  The
 * returned object is deliberately plain and can be kept in application state.
 */
export async function loadImage(source, options = {}) {
  if (isImageDataLike(source)) {
    const imageData = cloneImageData(source);
    const canvas = options.createCanvas === false ? null : createCanvas(imageData.width, imageData.height);
    if (canvas) canvas.getContext("2d").putImageData(imageData, 0, 0);
    return { source, image: null, bitmap: null, canvas, imageData, width: imageData.width, height: imageData.height };
  }

  let image = source;
  let bitmap = null;
  let objectUrl = null;
  try {
    if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
      bitmap = source;
    } else if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) {
      // Canvas is already drawable; no decoding needed.
    } else if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas) {
      // Same as an HTML canvas.
    } else if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) {
      if (!source.complete) await waitForImage(source);
      image = source;
    } else if (typeof Blob !== "undefined" && source instanceof Blob) {
      if (typeof createImageBitmap === "function") {
        bitmap = await createImageBitmap(source, options.imageBitmapOptions || undefined);
        image = bitmap;
      } else {
        objectUrl = URL.createObjectURL(source);
        image = await decodeImageUrl(objectUrl, options);
      }
    } else if (typeof source === "string" || (typeof URL !== "undefined" && source instanceof URL)) {
      image = await decodeImageUrl(String(source), options);
    } else {
      throw new TypeError("Unsupported image source; expected PNG File/Blob, URL, canvas, ImageBitmap, or ImageData");
    }

    const width = image.width || image.videoWidth || image.naturalWidth;
    const height = image.height || image.videoHeight || image.naturalHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("Unable to determine image dimensions");
    const canvas = options.createCanvas === false ? null : createCanvas(width, height);
    let imageData = null;
    if (canvas) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      imageData = ctx.getImageData(0, 0, width, height);
    }
    return { source, image, bitmap, canvas, imageData, width, height };
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function waitForImage(image) {
  if (image.complete && image.naturalWidth) return Promise.resolve(image);
  return new Promise((resolve, reject) => {
    const onLoad = () => { cleanup(); resolve(image); };
    const onError = (event) => { cleanup(); reject(new Error("Unable to decode image")); };
    const cleanup = () => { image.removeEventListener("load", onLoad); image.removeEventListener("error", onError); };
    image.addEventListener("load", onLoad, { once: true });
    image.addEventListener("error", onError, { once: true });
  });
}

function decodeImageUrl(url, options = {}) {
  if (typeof Image === "undefined") return Promise.reject(new Error("Image decoding is unavailable in this runtime"));
  const image = new Image();
  if (options.crossOrigin !== undefined) image.crossOrigin = options.crossOrigin;
  image.decoding = "async";
  image.src = url;
  return waitForImage(image);
}

/** Resolve an ImageData-like value from an image/canvas. */
export function readImageData(source, options = {}) {
  if (isImageDataLike(source)) return cloneImageData(source);
  const canvas = source && typeof source.getContext === "function" ? source : null;
  if (canvas) {
    const width = canvas.width;
    const height = canvas.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    return ctx.getImageData(0, 0, width, height);
  }
  throw new TypeError("readImageData expects ImageData or a canvas; use loadImage() for Blob/URL sources");
}

// Internal read-only path.  Pixel processors never mutate their input, so a
// caller-provided ImageData-like buffer can be reused without copying the
// entire atlas for every grid cell or exported slice.  Canvas inputs still
// go through getImageData and therefore receive an independent buffer.
function sourceImageData(source) {
  if (isImageDataLike(source)) return source;
  return readImageData(source);
}

/** Backwards-friendly aliases used by a few consumers. */
export const imageDataFromSource = readImageData;
export const getImageData = readImageData;

/**
 * Find alpha-connected regions.  The operation is synchronous and allocates a
 * compact Uint8Array mask plus one queue at most as large as the source.
 */
export function detectConnectedComponents(input, options = {}) {
  const imageData = sourceImageData(input);
  const opts = { ...DEFAULT_DETECT_OPTIONS, ...options };
  const width = imageData.width;
  const height = imageData.height;
  const pixelCount = width * height;
  // A threshold of zero means "any non-zero alpha".  When the UI explicitly
  // disables semi-transparent effects, use a conservative cutoff unless the
  // caller already requested an even higher one.
  const requestedThreshold = clampInt(opts.alphaThreshold, 0, 255);
  const alphaThreshold = opts.retainSemiTransparent === false
    ? Math.max(requestedThreshold, 128)
    : requestedThreshold;
  const connectivity = opts.connectivity === 8 ? 8 : 4;
  const mask = new Uint8Array(pixelCount);
  const data = imageData.data;
  for (let i = 0, p = 0; p < pixelCount; p++, i += 4) {
    // `retainSemiTransparent` is expressed through alphaThreshold.  Keeping
    // the branch makes the option self-documenting for callers/UI controls.
    mask[p] = alphaThreshold === 0 ? (data[i + 3] > 0 ? 1 : 0) : (data[i + 3] >= alphaThreshold ? 1 : 0);
  }

  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const rawComponents = [];
  for (let start = 0; start < pixelCount; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index - x) / width;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // Keep horizontal and vertical checks separate.  Using raw index
      // deltas alone is incorrect when width === 1 because `-1` is both the
      // left neighbour and the pixel directly above.
      if (x > 0) {
        const ni = index - 1;
        if (mask[ni] && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
      }
      if (x + 1 < width) {
        const ni = index + 1;
        if (mask[ni] && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
      }
      if (y > 0) {
        const ni = index - width;
        if (mask[ni] && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
      }
      if (y + 1 < height) {
        const ni = index + width;
        if (mask[ni] && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
      }
      if (connectivity === 8) {
        if (x > 0 && y > 0) {
          const ni = index - width - 1;
          if (mask[ni] && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
        }
        if (x + 1 < width && y > 0) {
          const ni = index - width + 1;
          if (mask[ni] && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
        }
        if (x > 0 && y + 1 < height) {
          const ni = index + width - 1;
          if (mask[ni] && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
        }
        if (x + 1 < width && y + 1 < height) {
          const ni = index + width + 1;
          if (mask[ni] && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
        }
      }
    }
    const componentWidth = maxX - minX + 1;
    const componentHeight = maxY - minY + 1;
    if (area < Math.max(1, opts.minPixelArea || 0)) continue;
    if (componentWidth < Math.max(1, opts.minWidth || 0)) continue;
    if (componentHeight < Math.max(1, opts.minHeight || 0)) continue;
    rawComponents.push({ minX, minY, maxX, maxY, area, width: componentWidth, height: componentHeight });
  }

  let components = rawComponents;
  if (opts.mergeAdjacentFragments && Number(opts.mergeDistance) > 0 && components.length > 1) {
    components = mergeComponents(components, Number(opts.mergeDistance));
  }

  // A component's connected-pixel bounds are the only source of truth during
  // automatic detection.  When auto-crop is disabled, retain a small safety
  // gutter so the result does not hug the first/last opaque pixel; an explicit
  // `padding` value is added on top of that gutter.  This makes the toggle
  // meaningful even when callers do not expose a separate padding control.
  const padding = Math.max(0, Math.round(Number(opts.padding) || 0))
    + (opts.autoCrop === false ? 2 : 0);
  const rects = components.map((component, index) => {
    const x = component.minX - padding;
    const y = component.minY - padding;
    const right = component.maxX + 1 + padding;
    const bottom = component.maxY + 1 + padding;
    const rect = clampRect({ x, y, width: right - x, height: bottom - y }, width, height);
    return {
      ...rect,
      id: `auto-${index + 1}`,
      name: `auto-${String(index + 1).padStart(3, "0")}`,
      area: component.area,
      componentCount: component.componentCount || 1,
      auto: true,
    };
  });
  rects.sort((a, b) => a.y - b.y || a.x - b.x);
  // Re-number after sorting so UI labels remain deterministic.
  rects.forEach((rect, index) => {
    rect.id = `auto-${index + 1}`;
    rect.name = `auto-${String(index + 1).padStart(3, "0")}`;
  });
  return { rects, components, mask, width, height, imageData };
}

/** Alias with a UI-friendly name. */
export const detectTransparentRegions = detectConnectedComponents;

function mergeComponents(components, distance) {
  const count = components.length;
  const parent = new Int32Array(count);
  const rank = new Uint8Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== x) { const next = parent[x]; parent[x] = root; x = next; }
    return root;
  };
  const union = (a, b) => {
    let ra = find(a); let rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) { const t = ra; ra = rb; rb = t; }
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
  };
  // Spatial hash keeps merging practical for atlases containing many specks.
  const cellSize = Math.max(1, Math.floor(distance) + 1);
  const buckets = new Map();
  const key = (x, y) => `${x},${y}`;
  for (let i = 0; i < count; i++) {
    const c = components[i];
    const minCellX = Math.floor((c.minX - distance) / cellSize);
    const maxCellX = Math.floor((c.maxX + distance) / cellSize);
    const minCellY = Math.floor((c.minY - distance) / cellSize);
    const maxCellY = Math.floor((c.maxY + distance) / cellSize);
    for (let cy = minCellY; cy <= maxCellY; cy++) for (let cx = minCellX; cx <= maxCellX; cx++) {
      const bucket = buckets.get(key(cx, cy));
      if (bucket) {
        for (const j of bucket) if (boxesWithinGap(c, components[j], distance)) union(i, j);
      }
    }
    for (let cy = minCellY; cy <= maxCellY; cy++) for (let cx = minCellX; cx <= maxCellX; cx++) {
      const bucketKey = key(cx, cy);
      let bucket = buckets.get(bucketKey);
      if (!bucket) { bucket = []; buckets.set(bucketKey, bucket); }
      bucket.push(i);
    }
  }
  const groups = new Map();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    let group = groups.get(root);
    if (!group) { group = []; groups.set(root, group); }
    group.push(components[i]);
  }
  return [...groups.values()].map((group) => {
    const merged = group.reduce((acc, c) => ({
      minX: Math.min(acc.minX, c.minX), minY: Math.min(acc.minY, c.minY),
      maxX: Math.max(acc.maxX, c.maxX), maxY: Math.max(acc.maxY, c.maxY),
      area: acc.area + c.area,
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, area: 0 });
    return { ...merged, width: merged.maxX - merged.minX + 1, height: merged.maxY - merged.minY + 1, componentCount: group.length };
  });
}

function boxesWithinGap(a, b, distance) {
  const gapX = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX) - 1);
  const gapY = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY) - 1);
  // Treat distance as a per-axis dilation (the convention used by most atlas
  // tools): a diagonal pair one pixel apart on each axis is therefore merged
  // when distance is one.  Overlapping projections have a zero gap.
  return gapX <= distance && gapY <= distance;
}

/** Parse #rgb/#rrggbb/#rrggbbaa and rgb()/rgba() color values. */
export function parseColor(color) {
  if (color && typeof color === "object" && Number.isFinite(color.r)) {
    return { r: clampInt(color.r, 0, 255), g: clampInt(color.g, 0, 255), b: clampInt(color.b, 0, 255), a: color.a == null ? 255 : clampInt(color.a, 0, 255) };
  }
  if (typeof color !== "string") return null;
  const value = color.trim().toLowerCase();
  if (value[0] === "#") {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const nums = [...hex].map((v) => parseInt(v + v, 16));
      return { r: nums[0], g: nums[1], b: nums[2], a: nums[3] == null ? 255 : nums[3] };
    }
    if (hex.length === 6 || hex.length === 8) {
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255 };
    }
  }
  const match = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
  if (match) return { r: clampInt(Number(match[1]), 0, 255), g: clampInt(Number(match[2]), 0, 255), b: clampInt(Number(match[3]), 0, 255), a: match[4] == null ? 255 : clampInt(match[4].endsWith("%") ? Number(match[4].slice(0, -1)) * 2.55 : Number(match[4]) * (Number(match[4]) <= 1 ? 255 : 1), 0, 255) };
  return null;
}

/** Sample non-transparent pixels around each corner for checkerboard cleanup. */
export function sampleCornerColors(input, options = {}) {
  const imageData = sourceImageData(input);
  const radius = Math.max(0, Math.round(Number(options.sampleRadius ?? 8)));
  const minAlpha = clampInt(options.minSampleAlpha ?? 8, 0, 255);
  const { width, height, data } = imageData;
  const points = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  const colors = [];
  const maxPerCorner = Math.max(1, Math.min(4, Math.round(Number(options.maxCornerColors ?? 2) || 2)));
  for (const [px, py] of points) {
    // A checkerboard has two (or more) distinct colors.  Averaging the whole
    // corner patch would produce a third color that does not match either
    // square, so retain the most frequent quantized colors instead.
    const histogram = new Map();
    const x0 = Math.max(0, px === 0 ? 0 : width - 1 - radius);
    const x1 = Math.min(width - 1, px === 0 ? radius : width - 1);
    const y0 = Math.max(0, py === 0 ? 0 : height - 1 - radius);
    const y1 = Math.min(height - 1, py === 0 ? radius : height - 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < minAlpha) continue;
      // 16-level buckets absorb JPEG-ish/colour-management noise while still
      // keeping checkerboard shades separate.
      const qr = data[i] >> 4; const qg = data[i + 1] >> 4; const qb = data[i + 2] >> 4;
      const key = `${qr},${qg},${qb}`;
      let bin = histogram.get(key);
      if (!bin) { bin = { r: 0, g: 0, b: 0, count: 0 }; histogram.set(key, bin); }
      bin.r += data[i]; bin.g += data[i + 1]; bin.b += data[i + 2]; bin.count++;
    }
    const bins = [...histogram.values()].sort((a, b) => b.count - a.count);
    for (const bin of bins.slice(0, maxPerCorner)) {
      colors.push({ r: Math.round(bin.r / bin.count), g: Math.round(bin.g / bin.count), b: Math.round(bin.b / bin.count), a: 255 });
    }
  }
  return dedupeColors(colors);
}

function dedupeColors(colors) {
  const unique = [];
  for (const color of colors) {
    if (!unique.some((other) => colorDistanceSq(color, other) <= 9)) unique.push(color);
  }
  return unique;
}

function colorDistanceSq(a, b) {
  const dr = a.r - b.r; const dg = a.g - b.g; const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

/**
 * Remove a fake solid/checkerboard background.  Flood mode only removes
 * edge-connected pixels, preserving foreground regions with the same color.
 * Global mode removes every similar pixel and is useful for uniformly keyed
 * backgrounds.  `imageData` is never mutated.
 */
export function cleanFakeTransparency(input, options = {}) {
  const source = sourceImageData(input);
  const opts = { ...DEFAULT_CLEAN_OPTIONS, ...options };
  const output = cloneImageData(source);
  const data = output.data;
  const width = output.width;
  const height = output.height;
  const colors = [];
  if (Array.isArray(opts.backgroundColors)) {
    for (const color of opts.backgroundColors) { const parsed = parseColor(color); if (parsed) colors.push(parsed); }
  }
  if (opts.backgroundColor) {
    const parsed = parseColor(opts.backgroundColor);
    if (parsed) colors.push(parsed);
  }
  if (!colors.length && opts.sampleCorners !== false) colors.push(...sampleCornerColors(source, opts));
  if (!colors.length) return { imageData: output, alphaMask: alphaMaskFromImageData(output), removedPixels: 0, backgroundColors: [], width, height };

  const threshold = Math.max(0, Number(opts.colorThreshold) || 0);
  const thresholdSq = threshold * threshold;
  const feather = Math.max(0, Number(opts.feather) || 0);
  const featherSq = (threshold + feather) * (threshold + feather);
  const matches = (index) => {
    const i = index * 4;
    // Already-transparent pixels are always considered background for flood
    // traversal, but they are not counted as newly removed pixels.
    if (data[i + 3] === 0) return true;
    const color = { r: data[i], g: data[i + 1], b: data[i + 2] };
    return colors.some((candidate) => colorDistanceSq(color, candidate) <= featherSq);
  };
  const removeMask = new Uint8Array(width * height);
  const mode = opts.mode === "global" ? "global" : opts.mode === "both" ? "both" : "flood";
  if (mode === "global" || mode === "both") {
    for (let p = 0; p < width * height; p++) if (matches(p)) removeMask[p] = 1;
  }
  if (mode === "flood" || mode === "both") {
    floodFillFromEdges(width, height, matches, removeMask, opts.connectivity === 8 ? 8 : 4);
  }

  let removedPixels = 0;
  for (let p = 0; p < removeMask.length; p++) {
    if (!removeMask[p]) continue;
    const i = p * 4;
    const alpha = data[i + 3];
    if (alpha > 0) removedPixels++;
    let nextAlpha = 0;
    if (feather > 0 && alpha > 0) {
      let minDistance = Infinity;
      const color = { r: data[i], g: data[i + 1], b: data[i + 2] };
      for (const candidate of colors) minDistance = Math.min(minDistance, Math.sqrt(colorDistanceSq(color, candidate)));
      if (minDistance > threshold) nextAlpha = clampInt(((minDistance - threshold) / feather) * alpha, 0, alpha);
    }
    data[i + 3] = nextAlpha;
    if (opts.clearRgb) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
  }
  const alphaMask = new Uint8ClampedArray(width * height);
  for (let p = 0; p < width * height; p++) alphaMask[p] = data[p * 4 + 3];
  return { imageData: output, alphaMask, removedPixels, backgroundColors: colors, width, height };
}

/** Flood-fill all matching pixels reachable from the image edge. */
export function floodFillFromEdges(width, height, matches, outputMask = null, connectivity = 4) {
  const total = width * height;
  // `outputMask` is optional for callers that simply need the result plane;
  // retain the fifth argument as connectivity for backwards compatibility.
  if (typeof outputMask === "number") { connectivity = outputMask; outputMask = null; }
  if (!outputMask || outputMask.length < total) outputMask = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0; let tail = 0;
  const enqueue = (index) => {
    if (index < 0 || index >= total || visited[index] || !matches(index)) return;
    visited[index] = 1;
    outputMask[index] = 1;
    queue[tail++] = index;
  };
  if (width === 0 || height === 0) return outputMask;
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  const deltas = connectivity === 8 ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] : [[-1, 0], [1, 0], [0, -1], [0, 1]];
  while (head < tail) {
    const index = queue[head++];
    const x = index % width; const y = (index - x) / width;
    for (const [dx, dy] of deltas) {
      const nx = x + dx; const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      enqueue(ny * width + nx);
    }
  }
  return outputMask;
}

export const floodFillBackground = floodFillFromEdges;

/** Return a one-byte alpha plane from ImageData. */
export function alphaMaskFromImageData(input) {
  const imageData = sourceImageData(input);
  const result = new Uint8ClampedArray(imageData.width * imageData.height);
  for (let p = 0; p < result.length; p++) result[p] = imageData.data[p * 4 + 3];
  return result;
}

/**
 * Turn an alpha plane into a displayable ImageData.  This is useful for the
 * "Alpha 蒙版" preview: opaque pixels use `color` and transparent pixels are
 * black with zero alpha by default.
 */
export function alphaMaskToImageData(input, options = {}) {
  const imageData = sourceImageData(input);
  const color = parseColor(options.color || "#ffffff") || { r: 255, g: 255, b: 255 };
  const data = new Uint8ClampedArray(imageData.width * imageData.height * 4);
  for (let p = 0; p < imageData.width * imageData.height; p++) {
    const alpha = imageData.data[p * 4 + 3];
    const i = p * 4;
    data[i] = color.r; data[i + 1] = color.g; data[i + 2] = color.b;
    data[i + 3] = options.preserveAlpha === false ? (alpha ? 255 : 0) : alpha;
  }
  if (typeof ImageData !== "undefined" && imageData.width > 0 && imageData.height > 0) {
    try { return new ImageData(data, imageData.width, imageData.height); } catch (_) { /* fall through */ }
  }
  return { data, width: imageData.width, height: imageData.height };
}

/** Compute the non-transparent bounds of an ImageData region. */
export function getAlphaBounds(input, options = {}) {
  const imageData = sourceImageData(input);
  const threshold = clampInt(options.alphaThreshold ?? 1, 0, 255);
  const rect = normalizeRect(options.rect || { x: 0, y: 0, width: imageData.width, height: imageData.height });
  const clipped = clampRect(rect, imageData.width, imageData.height);
  let minX = clipped.x + clipped.width; let minY = clipped.y + clipped.height;
  let maxX = clipped.x - 1; let maxY = clipped.y - 1;
  for (let y = clipped.y; y < clipped.y + clipped.height; y++) for (let x = clipped.x; x < clipped.x + clipped.width; x++) {
    const alpha = imageData.data[(y * imageData.width + x) * 4 + 3];
    if (threshold === 0 ? alpha === 0 : alpha < threshold) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Build a regular grid.  If an ImageData/canvas is supplied, `skipEmpty` and
 * `trim` inspect its alpha channel; otherwise only geometry is generated.
 */
export function generateGridSlices(input, options = {}) {
  const opts = { ...DEFAULT_GRID_OPTIONS, ...options };
  let imageData = null;
  let width = Number(options.width);
  let height = Number(options.height);
  if (input != null) {
    if (isImageDataLike(input) || (input && typeof input.getContext === "function")) {
      imageData = sourceImageData(input); width = imageData.width; height = imageData.height;
    } else if (typeof input === "object") {
      if (isImageDataLike(input.imageData)) { imageData = sourceImageData(input.imageData); width = imageData.width; height = imageData.height; }
      else if (input.canvas && typeof input.canvas.getContext === "function") { imageData = sourceImageData(input.canvas); width = imageData.width; height = imageData.height; }
      else { width = Number(input.width); height = Number(input.height); }
    }
  }
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new TypeError("Grid dimensions are required");
  width = Math.max(0, Math.round(width)); height = Math.max(0, Math.round(height));
  const columns = Math.max(1, Math.floor(Number(opts.columns) || 1));
  const rows = Math.max(1, Math.floor(Number(opts.rows) || 1));
  const spacingX = Math.max(0, Math.round(Number(opts.spacingX ?? opts.gapX ?? opts.spacing ?? 0) || 0));
  const spacingY = Math.max(0, Math.round(Number(opts.spacingY ?? opts.gapY ?? opts.spacing ?? 0) || 0));
  const margin = normalizeMargins(opts.margin ?? { x: opts.marginX ?? 0, y: opts.marginY ?? 0 });
  const availableWidth = width - margin.left - margin.right - spacingX * (columns - 1);
  const availableHeight = height - margin.top - margin.bottom - spacingY * (rows - 1);
  const widthOption = opts.cellWidth ?? opts.cellW;
  const heightOption = opts.cellHeight ?? opts.cellH;
  const hasExplicitCellWidth = widthOption != null && widthOption !== "" && Number(widthOption) > 0 && Number.isFinite(Number(widthOption));
  const hasExplicitCellHeight = heightOption != null && heightOption !== "" && Number(heightOption) > 0 && Number.isFinite(Number(heightOption));
  const cellWidth = Math.max(0, hasExplicitCellWidth ? Math.round(Number(widthOption)) : Math.floor(availableWidth / columns));
  const cellHeight = Math.max(0, hasExplicitCellHeight ? Math.round(Number(heightOption)) : Math.floor(availableHeight / rows));
  const cells = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const x = margin.left + col * (cellWidth + spacingX);
    const y = margin.top + row * (cellHeight + spacingY);
    // When cell dimensions are derived, let the last column/row consume any
    // remainder so no source pixels are silently left out due to rounding.
    const derivedWidth = !hasExplicitCellWidth && col === columns - 1
      ? Math.max(0, width - margin.right - x) : cellWidth;
    const derivedHeight = !hasExplicitCellHeight && row === rows - 1
      ? Math.max(0, height - margin.bottom - y) : cellHeight;
    const rect = clampRect({ x, y, width: derivedWidth, height: derivedHeight }, width, height);
    const alphaBounds = imageData && rect.width && rect.height ? getAlphaBounds(imageData, { rect, alphaThreshold: opts.alphaThreshold }) : null;
    const empty = !alphaBounds;
    if (opts.skipEmpty && empty) continue;
    const resultRect = opts.trim && alphaBounds ? alphaBounds : rect;
    cells.push({
      ...resultRect,
      id: `${opts.namePrefix || "slice"}-${cells.length + 1}`,
      name: `${opts.namePrefix || "slice"}-${String(cells.length + 1).padStart(3, "0")}`,
      index: row * columns + col,
      row,
      column: col,
      cellRect: rect,
      empty,
      auto: true,
    });
  }
  if (opts.order === "bottom-left" || opts.order === "bottom-up" || opts.order === "bl") {
    cells.sort((a, b) => b.row - a.row || a.column - b.column);
  } else if (opts.order === "column-major") {
    cells.sort((a, b) => a.column - b.column || a.row - b.row);
  } else if (opts.order === "rtl") {
    cells.sort((a, b) => a.row - b.row || b.column - a.column);
  } else {
    cells.sort((a, b) => a.row - b.row || a.column - b.column);
  }
  cells.forEach((cell, i) => {
    cell.index = i;
    cell.id = `${opts.namePrefix || "slice"}-${i + 1}`;
    cell.name = `${opts.namePrefix || "slice"}-${String(i + 1).padStart(3, "0")}`;
  });
  return { rects: cells, width, height, columns, rows, cellWidth, cellHeight, spacingX, spacingY, margin };
}

function normalizeMargins(margin) {
  if (typeof margin === "number") {
    const value = Math.max(0, Math.round(Number(margin) || 0));
    return { left: value, right: value, top: value, bottom: value };
  }
  if (margin && typeof margin === "object") return {
    left: Math.max(0, Math.round(Number(margin.left ?? margin.x ?? 0) || 0)),
    right: Math.max(0, Math.round(Number(margin.right ?? margin.x ?? 0) || 0)),
    top: Math.max(0, Math.round(Number(margin.top ?? margin.y ?? 0) || 0)),
    bottom: Math.max(0, Math.round(Number(margin.bottom ?? margin.y ?? 0) || 0)),
  };
  return { left: 0, right: 0, top: 0, bottom: 0 };
}

/** Normalize a possibly negative/dragged rectangle. */
export function normalizeRect(rect) {
  const rawX = Number(rect?.x ?? 0); const rawY = Number(rect?.y ?? 0);
  const rawWidth = Number(rect?.width ?? rect?.w ?? 0); const rawHeight = Number(rect?.height ?? rect?.h ?? 0);
  const x = Number.isFinite(rawX) ? rawX : 0;
  const y = Number.isFinite(rawY) ? rawY : 0;
  const width = Number.isFinite(rawWidth) ? rawWidth : 0;
  const height = Number.isFinite(rawHeight) ? rawHeight : 0;
  return { x: Math.round(Math.min(x, x + width)), y: Math.round(Math.min(y, y + height)), width: Math.round(Math.abs(width)), height: Math.round(Math.abs(height)) };
}

/** Clamp a rectangle to source bounds. */
export function clampRect(rect, sourceWidth, sourceHeight) {
  const normalized = normalizeRect(rect);
  const maxWidth = Math.max(0, Number.isFinite(Number(sourceWidth)) ? Math.round(Number(sourceWidth)) : 0);
  const maxHeight = Math.max(0, Number.isFinite(Number(sourceHeight)) ? Math.round(Number(sourceHeight)) : 0);
  const x = Math.max(0, Math.min(maxWidth, normalized.x));
  const y = Math.max(0, Math.min(maxHeight, normalized.y));
  const right = Math.max(x, Math.min(maxWidth, normalized.x + normalized.width));
  const bottom = Math.max(y, Math.min(maxHeight, normalized.y + normalized.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Snap a rectangle to pixel or grid increments. */
export function snapRect(rect, options = {}) {
  const grid = Math.max(1, Math.round(Number(options.gridSize ?? options.grid ?? 1) || 1));
  const mode = options.mode || "round";
  const snap = (value) => mode === "floor" ? Math.floor(value / grid) * grid : mode === "ceil" ? Math.ceil(value / grid) * grid : Math.round(value / grid) * grid;
  const normalized = normalizeRect(rect);
  return { x: snap(normalized.x), y: snap(normalized.y), width: Math.max(grid, snap(normalized.width)), height: Math.max(grid, snap(normalized.height)) };
}

/** Merge an arbitrary list of rectangles into their enclosing rectangle. */
export function mergeRects(rects) {
  const valid = (rects || []).map(normalizeRect).filter((r) => r.width > 0 && r.height > 0);
  if (!valid.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const r of valid) {
    if (r.x < minX) minX = r.x; if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Copy a source rectangle into a detached ImageData-like object. */
export function cropImageData(input, rect, options = {}) {
  const source = sourceImageData(input);
  let crop = clampRect(rect, source.width, source.height);
  if (options.trim) {
    const trimmed = getAlphaBounds(source, { rect: crop, alphaThreshold: options.alphaThreshold ?? 1 });
    if (trimmed) crop = trimmed;
  }
  const padding = Math.max(0, Math.round(Number(options.padding) || 0));
  if (padding) crop = clampRect({ x: crop.x - padding, y: crop.y - padding, width: crop.width + 2 * padding, height: crop.height + 2 * padding }, source.width, source.height);
  const outWidth = crop.width; const outHeight = crop.height;
  const outData = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    const sourceStart = ((crop.y + y) * source.width + crop.x) * 4;
    outData.set(source.data.subarray(sourceStart, sourceStart + outWidth * 4), y * outWidth * 4);
  }
  if (typeof ImageData !== "undefined" && outWidth > 0 && outHeight > 0) {
    try { return new ImageData(outData, outWidth, outHeight); } catch (_) { /* fall through */ }
  }
  return { data: outData, width: outWidth, height: outHeight };
}

/** Encode a crop (or complete ImageData) as PNG in the browser. */
export async function encodePng(input, rect = null, options = {}) {
  let source = input;
  if (!isImageDataLike(source)) source = readImageData(source);
  const imageData = rect ? cropImageData(source, rect, options) : cloneImageData(source);
  const canvas = createCanvas(imageData.width, imageData.height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(imageData, 0, 0);
  const type = options.type || "image/png";
  if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type });
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), type, options.quality));
}

/**
 * Encode many slices.  No download is triggered; callers can show progress,
 * rename files, or pass the returned blobs to `downloadPngFiles`.
 */
export async function exportSlicesAsPng(input, slices, options = {}) {
  const source = isImageDataLike(input)
    ? input
    : isImageDataLike(input?.imageData)
      ? input.imageData
      : readImageData(input);
  const prefix = options.prefix || options.namePrefix || "slice";
  const files = [];
  for (let i = 0; i < (slices || []).length; i++) {
    const slice = slices[i];
    const rawName = slice.name || `${prefix}-${String(i + 1).padStart(3, "0")}`;
    // Keep the naming helper useful to headless callers as well as the UI.
    // `{n}` is 1-based; repeating the token (`{nnn}`) requests zero padding.
    const sequenceName = String(rawName).replace(/\{(n+)\}/gi, (_, token) => String(i + 1).padStart(token.length, "0"));
    const name = sanitizeFilename(sequenceName);
    // A slice can explicitly preserve its transparent gutter even when the
    // export panel's global “裁剪透明边缘” option is enabled.
    const sliceOptions = { ...options, trim: slice.keepPadding ? false : options.trim };
    const blob = await encodePng(source, slice, sliceOptions);
    files.push({ name: name.toLowerCase().endsWith(".png") ? name : `${name}.png`, blob, rect: normalizeRect(slice), index: i });
    if (typeof options.onProgress === "function") options.onProgress({ completed: i + 1, total: slices.length, file: files[files.length - 1] });
  }
  return { files, totalBytes: files.reduce((sum, file) => sum + (file.blob?.size || 0), 0), sourceWidth: source.width, sourceHeight: source.height };
}

export const extractSlice = cropImageData;
export const gridSlice = generateGridSlices;
export const clearFakeTransparency = cleanFakeTransparency;

/** Trigger one browser download per PNG file (requires a window/document). */
export function downloadPngFiles(files, options = {}) {
  if (typeof document === "undefined" || typeof URL === "undefined") throw new Error("Downloads are only available in a browser window");
  const delay = Math.max(0, Number(options.delay ?? 80));
  (files || []).forEach((file, index) => {
    const href = URL.createObjectURL(file.blob || file);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = file.name || `slice-${index + 1}.png`;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    // A short stagger makes Chromium accept a batch of downloads reliably.
    setTimeout(() => {
      anchor.click();
      setTimeout(() => { anchor.remove(); URL.revokeObjectURL(href); }, 1000);
    }, index * delay);
  });
}

/**
 * Build a ZIP archive from exported files without sending pixels to a server.
 *
 * `files` is normally the `result.files` array returned by
 * {@link exportSlicesAsPng}: `{ name, blob }`.  `extraFiles` can be an object
 * or an array of `{ name, blob }` entries (for example a coordinate manifest)
 * and is stored alongside the PNGs.  The function is async because
 * browser Blobs expose their bytes through `arrayBuffer()`.
 *
 * Empty input, malformed entries, zero-byte files, and ZIP encoder failures
 * reject with a descriptive Error so the UI can show a single actionable
 * message instead of silently downloading a corrupt archive.  Set
 * `skipEmpty: true` when a caller intentionally wants to omit zero-byte
 * entries.
 */
export async function createZipBlob(files, options = {}) {
  const inputFiles = Array.isArray(files) ? files : [];
  const entries = Object.create(null);
  const usedNames = new Set();
  const skipEmpty = options.skipEmpty === true;

  const addEntry = async (entry, fallbackName) => {
    if (entry == null) {
      throw new Error(`ZIP 文件项无效：${fallbackName || "未命名"}`);
    }
    const rawName = typeof entry === "object" && !(entry instanceof Uint8Array) && !(entry instanceof ArrayBuffer)
      ? entry.name
      : undefined;
    const name = uniqueArchiveName(sanitizeFilename(rawName || fallbackName || "file"), usedNames);
    const source = typeof entry === "object" && rawName !== undefined
      ? (entry.blob ?? entry.data ?? entry.content)
      : entry;
    const bytes = await toUint8Array(source, name);
    if (!bytes.byteLength) {
      if (skipEmpty) return false;
      throw new Error(`ZIP 文件为空：${name}`);
    }
    entries[name] = bytes;
    return true;
  };

  for (let index = 0; index < inputFiles.length; index++) {
    await addEntry(inputFiles[index], `slice-${String(index + 1).padStart(3, "0")}.png`);
  }

  const extras = options.extraFiles;
  if (extras instanceof Map) {
    let index = 0;
    for (const [name, value] of extras.entries()) {
      await addEntry({ name, blob: value }, `extra-${++index}`);
    }
  } else if (Array.isArray(extras)) {
    for (let index = 0; index < extras.length; index++) {
      await addEntry(extras[index], `extra-${index + 1}`);
    }
  } else if (extras && typeof extras === "object") {
    for (const [name, value] of Object.entries(extras)) {
      await addEntry({ name, blob: value }, name);
    }
  }

  const names = Object.keys(entries);
  if (!names.length) throw new Error("没有可打包的文件");
  try {
    const archive = zipSync(entries, {
      level: Number.isFinite(Number(options.level)) ? Math.max(0, Math.min(9, Number(options.level))) : 6,
    });
    return new Blob([archive], { type: "application/zip" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ZIP 打包失败：${message}`);
  }
}

/** Trigger one browser download for a ZIP Blob. */
export function downloadZipBlob(blob, filename = "sprites.zip") {
  if (typeof document === "undefined" || typeof URL === "undefined") throw new Error("Downloads are only available in a browser window");
  if (!blob || typeof blob.size !== "number" || blob.size <= 0) throw new Error("ZIP 文件为空，无法下载");
  const safeName = sanitizeFilename(filename).toLowerCase().endsWith(".zip") ? sanitizeFilename(filename) : `${sanitizeFilename(filename)}.zip`;
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = safeName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => { anchor.remove(); URL.revokeObjectURL(href); }, 1000);
}

async function toUint8Array(value, name) {
  if (value == null) throw new Error(`ZIP 文件项缺少内容：${name}`);
  if (value instanceof Uint8Array) return value;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (typeof value?.arrayBuffer === "function") {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  throw new Error(`ZIP 文件项格式不受支持：${name}`);
}

function uniqueArchiveName(name, usedNames) {
  const base = name || "file";
  if (!usedNames.has(base)) {
    usedNames.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : "";
  let counter = 2;
  let candidate = `${stem}-${counter}${extension}`;
  while (usedNames.has(candidate)) candidate = `${stem}-${++counter}${extension}`;
  usedNames.add(candidate);
  return candidate;
}

function sanitizeFilename(name) {
  return String(name || "slice").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "slice";
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export default {
  loadImage,
  readImageData,
  imageDataFromSource,
  getImageData,
  detectConnectedComponents,
  detectTransparentRegions,
  cleanFakeTransparency,
  clearFakeTransparency,
  floodFillFromEdges,
  floodFillBackground,
  sampleCornerColors,
  alphaMaskFromImageData,
  alphaMaskToImageData,
  getAlphaBounds,
  generateGridSlices,
  gridSlice,
  normalizeRect,
  clampRect,
  snapRect,
  mergeRects,
  cropImageData,
  extractSlice,
  encodePng,
  exportSlicesAsPng,
  downloadPngFiles,
  createZipBlob,
  downloadZipBlob,
};
