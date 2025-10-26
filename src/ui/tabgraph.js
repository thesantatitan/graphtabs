/// <reference path="../shared/types.d.ts" />
const NODE_WIDTH = 220;
const NODE_HEIGHT = 140;
const NODE_RADIUS = 20;
const COLUMN_GAP = 120;
const ROW_GAP = 80;
const EDGE_COLOR = 'rgba(255, 255, 255, 0.22)';
const EDGE_ACTIVE_COLOR = 'rgba(76, 201, 240, 0.55)';
const NODE_BG = 'rgba(20, 24, 32, 0.9)';
const NODE_BG_ACTIVE = 'rgba(76, 201, 240, 0.25)';
const NODE_BORDER = 'rgba(255, 255, 255, 0.08)';
const NODE_BORDER_ACTIVE = 'rgba(76, 201, 240, 0.75)';
const THUMB_PADDING = 14;
const TITLE_HEIGHT = 34;
const SCALE_MIN = 0.3;
const SCALE_MAX = 3.5;
const SCALE_STEP = 1.18;
const SCROLL_ZOOM_FACTOR = 0.0015;
const THUMB_STORAGE_PREFIX = 'thumb_';

const canvas = document.getElementById('graph-canvas');
const ctx = canvas.getContext('2d', { alpha: true });
const zoomInBtn = document.getElementById('zoom-in');
const zoomOutBtn = document.getElementById('zoom-out');
const resetBtn = document.getElementById('reset-view');
const statusStrip = document.getElementById('status-strip');
const hoverCard = document.getElementById('hover-card');
const hoverTitle = document.getElementById('hover-title');
const hoverDomain = document.getElementById('hover-domain');
const hoverFavicon = document.getElementById('hover-favicon');

const state = {
  graph: { nodes: [], edges: [] },
  layout: new Map(),
  bounds: null,
  viewport: {
    dpr: window.devicePixelRatio || 1,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    hasInitialFit: false,
  },
  thumbnails: new Map(), // tabId -> { bitmap: ImageBitmap|null, blocked: boolean, lastUpdated: number|null }
  pendingThumbs: new Set(),
  hoverTabId: null,
  drag: {
    active: false,
    originX: 0,
    originY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    moved: false,
  },
};

const faviconCache = new Map(); // key -> Promise<ImageBitmap>
const faviconStore = new Map(); // key -> ImageBitmap
const renderState = {
  rafId: null,
};

let hoverFaviconUrl = null;

bootstrap().catch((error) => console.error('GraphTabs UI failed to start', error));

async function bootstrap() {
  setupEvents();
  resizeCanvas();
  await requestInitialGraph();
  scheduleRender();
}

function setupEvents() {
  window.addEventListener('resize', () => {
    resizeCanvas();
    scheduleRender();
  });

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUpOrCancel);
  canvas.addEventListener('pointerleave', handlePointerUpOrCancel);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('click', handleCanvasClick);
  canvas.addEventListener('contextmenu', handleContextMenu);

  zoomInBtn.addEventListener('click', () => applyZoom(SCALE_STEP));
  zoomOutBtn.addEventListener('click', () => applyZoom(1 / SCALE_STEP));
  resetBtn.addEventListener('click', () => resetView(true));

  window.addEventListener('keydown', handleKeyDown, { capture: true });
  window.addEventListener('unload', () => {
    if (hoverFaviconUrl) {
      URL.revokeObjectURL(hoverFaviconUrl);
      hoverFaviconUrl = null;
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'graph:update') {
      updateGraph(message.graph);
    } else if (message.type === 'thumb:update' && Number.isFinite(message.tabId)) {
      handleThumbUpdate(Number(message.tabId));
    }
  });
}

async function requestInitialGraph() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'graph:get' });
    if (response && response.graph) {
      updateGraph(response.graph, { forceFit: true });
    }
  } catch (error) {
    console.warn('graph:get failed', error);
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  state.viewport.dpr = dpr;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
}

function updateGraph(graph, options = {}) {
  if (!graph || !Array.isArray(graph.nodes)) return;
  state.graph = {
    nodes: graph.nodes.slice(),
    edges: Array.isArray(graph.edges) ? graph.edges.slice() : [],
  };
  computeLayout();
  syncThumbnails();
  updateStatusStrip();
  if (options.forceFit || !state.viewport.hasInitialFit) {
    resetView(false);
    state.viewport.hasInitialFit = true;
  }
  scheduleRender();
}

function computeLayout() {
  const windows = new Map();
  for (const node of state.graph.nodes) {
    if (!windows.has(node.windowId)) {
      windows.set(node.windowId, []);
    }
    windows.get(node.windowId).push(node);
  }

  const sortedWindows = Array.from(windows.entries()).sort((a, b) => a[0] - b[0]);
  const layout = new Map();
  let columnIndex = 0;
  let maxRight = Number.NEGATIVE_INFINITY;
  let maxBottom = Number.NEGATIVE_INFINITY;
  let minLeft = Number.POSITIVE_INFINITY;
  let minTop = Number.POSITIVE_INFINITY;

  for (const [, nodes] of sortedWindows) {
    nodes.sort((a, b) => a.id - b.id);
    nodes.forEach((node, rowIndex) => {
      const x = columnIndex * (NODE_WIDTH + COLUMN_GAP) + NODE_WIDTH / 2;
      const y = rowIndex * (NODE_HEIGHT + ROW_GAP) + NODE_HEIGHT / 2;
      const entry = {
        node,
        x,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        left: x - NODE_WIDTH / 2,
        top: y - NODE_HEIGHT / 2,
        right: x + NODE_WIDTH / 2,
        bottom: y + NODE_HEIGHT / 2,
      };
      layout.set(node.id, entry);
      minLeft = Math.min(minLeft, entry.left);
      minTop = Math.min(minTop, entry.top);
      maxRight = Math.max(maxRight, entry.right);
      maxBottom = Math.max(maxBottom, entry.bottom);
    });
    columnIndex += 1;
  }

  state.layout = layout;
  if (layout.size === 0) {
    state.bounds = null;
  } else {
    state.bounds = {
      left: minLeft,
      top: minTop,
      right: maxRight,
      bottom: maxBottom,
      width: maxRight - minLeft,
      height: maxBottom - minTop,
      centerX: (minLeft + maxRight) / 2,
      centerY: (minTop + maxBottom) / 2,
    };
  }
}

function syncThumbnails() {
  const currentTabIds = new Set(state.graph.nodes.map((node) => node.id));

  // Remove thumbnails for tabs that no longer exist
  for (const [tabId, entry] of state.thumbnails.entries()) {
    if (!currentTabIds.has(tabId)) {
      if (entry.bitmap && typeof entry.bitmap.close === 'function') {
        entry.bitmap.close();
      }
      state.thumbnails.delete(tabId);
      state.pendingThumbs.delete(tabId);
    }
  }

  // Request thumbnails for new tabs
  for (const node of state.graph.nodes) {
    if (!state.thumbnails.has(node.id)) {
      state.pendingThumbs.add(node.id);
      requestThumbnail(node.id);
    }
    prefetchFavicon(node);
  }
}

async function requestThumbnail(tabId) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'thumb:get', tabId });
    if (!response) return;
    if (response.blocked) {
      state.thumbnails.set(tabId, { bitmap: null, blocked: true, lastUpdated: response.lastUpdated ?? null });
      state.pendingThumbs.delete(tabId);
      updateStatusStrip();
      scheduleRender();
      return;
    }
    if (response.found && response.storageKey) {
      await loadThumbnailFromStorage(tabId, response.storageKey);
    } else {
      state.pendingThumbs.add(tabId);
      updateStatusStrip();
    }
  } catch (error) {
    console.warn('thumb:get failed', error);
  }
}

async function handleThumbUpdate(tabId) {
  if (!state.layout.has(tabId)) {
    state.pendingThumbs.delete(tabId);
    updateStatusStrip();
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'thumb:get', tabId });
    if (!response) return;
    if (response.blocked) {
      const existing = state.thumbnails.get(tabId);
      if (existing && existing.bitmap && typeof existing.bitmap.close === 'function') {
        existing.bitmap.close();
      }
      state.thumbnails.set(tabId, { bitmap: null, blocked: true, lastUpdated: response.lastUpdated ?? Date.now() });
      state.pendingThumbs.delete(tabId);
      updateStatusStrip();
      scheduleRender();
      return;
    }
    if (response.found && response.storageKey) {
      await loadThumbnailFromStorage(tabId, response.storageKey);
    }
  } catch (error) {
    console.warn('thumb:update handling failed', error);
  }
}

async function loadThumbnailFromStorage(tabId, storageKey) {
  const key = storageKey || getThumbnailStorageKey(tabId);
  try {
    const result = await chrome.storage.session.get(key);
    const entry = result[key];
    if (!entry || entry.blocked) {
      state.thumbnails.set(tabId, { bitmap: null, blocked: Boolean(entry?.blocked), lastUpdated: entry?.lastUpdated ?? null });
      state.pendingThumbs.delete(tabId);
      updateStatusStrip();
      scheduleRender();
      return;
    }
    if (!entry.dataUrl) return;

    const bitmap = await dataUrlToImageBitmap(entry.dataUrl);
    const previous = state.thumbnails.get(tabId);
    if (previous && previous.bitmap && typeof previous.bitmap.close === 'function') {
      previous.bitmap.close();
    }
    state.thumbnails.set(tabId, { bitmap, blocked: false, lastUpdated: entry.lastUpdated ?? Date.now() });
    state.pendingThumbs.delete(tabId);
    updateStatusStrip();
    scheduleRender();
  } catch (error) {
    console.warn('loadThumbnailFromStorage failed', error);
  }
}

async function dataUrlToImageBitmap(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

function scheduleRender() {
  if (renderState.rafId !== null) return;
  renderState.rafId = requestAnimationFrame(() => {
    renderState.rafId = null;
    render();
  });
}

function render() {
  const { dpr, scale, offsetX, offsetY } = state.viewport;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  drawEdges();
  drawNodes();

  ctx.restore();
}

function drawEdges() {
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const edge of state.graph.edges) {
    const from = state.layout.get(edge.from);
    const to = state.layout.get(edge.to);
    if (!from || !to) continue;
    const active = from.node.active || to.node.active;
    ctx.strokeStyle = active ? EDGE_ACTIVE_COLOR : EDGE_COLOR;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
}

function drawNodes() {
  for (const node of state.graph.nodes) {
    const entry = state.layout.get(node.id);
    if (!entry) continue;
    drawNode(entry);
  }
}

function drawNode(entry) {
  const { node, left, top, width, height } = entry;
  const active = Boolean(node.active);
  const borderColor = active ? NODE_BORDER_ACTIVE : NODE_BORDER;
  const fillColor = active ? NODE_BG_ACTIVE : NODE_BG;

  const lineWidth = active ? 2.2 / state.viewport.scale : 1 / state.viewport.scale;
  drawRoundedRect(left, top, width, height, NODE_RADIUS, borderColor, fillColor, lineWidth);

  const thumbRect = {
    x: left + THUMB_PADDING,
    y: top + THUMB_PADDING,
    width: width - THUMB_PADDING * 2,
    height: height - THUMB_PADDING * 2 - TITLE_HEIGHT,
  };

  const thumbEntry = state.thumbnails.get(node.id);
  if (thumbEntry && thumbEntry.bitmap && !thumbEntry.blocked) {
    ctx.save();
    clipRoundedRect(thumbRect.x, thumbRect.y, thumbRect.width, thumbRect.height, 12);
    ctx.drawImage(thumbEntry.bitmap, thumbRect.x, thumbRect.y, thumbRect.width, thumbRect.height);
    ctx.restore();
  } else {
    drawThumbnailFallback(node, thumbRect, Boolean(thumbEntry?.blocked));
  }

  drawNodeTitle(node, left + THUMB_PADDING, top + height - TITLE_HEIGHT, width - THUMB_PADDING * 2);

  if (thumbEntry?.blocked) {
    drawBadge(left + 12, top + 12, 'Capture blocked', 'rgba(255, 107, 107, 0.9)');
  } else if (!thumbEntry || !thumbEntry.bitmap) {
    drawBadge(left + 12, top + 12, 'Waiting…', 'rgba(76, 201, 240, 0.55)');
  }
}

function drawRoundedRect(x, y, width, height, radius, strokeStyle, fillStyle, lineWidth) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.stroke();
}

function clipRoundedRect(x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.clip();
}

function drawThumbnailFallback(node, rect, blocked) {
  ctx.save();
  clipRoundedRect(rect.x, rect.y, rect.width, rect.height, 12);
  const gradient = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
  gradient.addColorStop(0, blocked ? 'rgba(80, 20, 20, 0.8)' : 'rgba(28, 33, 45, 0.9)');
  gradient.addColorStop(1, blocked ? 'rgba(102, 28, 28, 0.6)' : 'rgba(24, 27, 37, 0.8)');
  ctx.fillStyle = gradient;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  const key = getFaviconKey(node.url);
  const bitmap = faviconStore.get(key);
  if (bitmap) {
    const size = Math.min(rect.width, rect.height) * 0.5;
    const cx = rect.x + rect.width / 2 - size / 2;
    const cy = rect.y + rect.height / 2 - size / 2;
    ctx.globalAlpha = 0.85;
    ctx.drawImage(bitmap, cx, cy, size, size);
  } else {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = `${28 / state.viewport.scale}px "Inter", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const letter = (node.title || extractDomain(node.url) || '?').trim().charAt(0).toUpperCase() || '?';
    ctx.fillText(letter, rect.x + rect.width / 2, rect.y + rect.height / 2 + 4 / state.viewport.scale);
    getFaviconBitmap(node.url, node.title).then(() => scheduleRender()).catch(() => {});
  }
  ctx.restore();
}

function drawNodeTitle(node, x, y, width) {
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.fillRect(x - 8, y - 6, width + 16, TITLE_HEIGHT);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.font = `${14 / state.viewport.scale}px "Inter", "Segoe UI", sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const title = node.title || '(Untitled tab)';
  const textX = x;
  const textY = y + 4;
  const maxWidth = width;
  const line = truncateText(title, maxWidth);
  ctx.fillText(line, textX, textY, maxWidth);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  const domain = extractDomain(node.url);
  ctx.font = `${12 / state.viewport.scale}px "Inter", "Segoe UI", sans-serif`;
  ctx.fillText(domain, textX, textY + 18 / state.viewport.scale, maxWidth);
  ctx.restore();
}

function drawBadge(x, y, text, color) {
  ctx.save();
  const paddingX = 10 / state.viewport.scale;
  const paddingY = 4 / state.viewport.scale;
  ctx.font = `${12 / state.viewport.scale}px "Inter", "Segoe UI", sans-serif`;
  const textWidth = ctx.measureText(text).width;
  const badgeWidth = textWidth + paddingX * 2;
  const badgeHeight = 18 / state.viewport.scale + paddingY;
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = 1 / state.viewport.scale;
  const radius = 9 / state.viewport.scale;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + badgeWidth - radius, y);
  ctx.quadraticCurveTo(x + badgeWidth, y, x + badgeWidth, y + radius);
  ctx.lineTo(x + badgeWidth, y + badgeHeight - radius);
  ctx.quadraticCurveTo(x + badgeWidth, y + badgeHeight, x + badgeWidth - radius, y + badgeHeight);
  ctx.lineTo(x + radius, y + badgeHeight);
  ctx.quadraticCurveTo(x, y + badgeHeight, x, y + badgeHeight - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#0b0d11';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + badgeWidth / 2, y + badgeHeight / 2 + 1 / state.viewport.scale);
  ctx.restore();
}

function truncateText(text, maxWidth) {
  const metrics = ctx.measureText(text);
  if (metrics.width <= maxWidth) return text;
  let truncated = text;
  while (ctx.measureText(`${truncated}…`).width > maxWidth && truncated.length > 1) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch (_) {
    return url || '';
  }
}

async function getFaviconBitmap(url, title) {
  try {
    const u = new URL(url);
    const key = u.origin;
    if (faviconStore.has(key)) {
      return faviconStore.get(key);
    }
    if (faviconCache.has(key)) {
      return faviconCache.get(key);
    }
    const promise = (async () => {
      try {
        const bitmap = await fetchFavicon(url);
        faviconStore.set(key, bitmap);
        return bitmap;
      } catch (error) {
        const fallback = await createInitialsBitmap(title || u.hostname || '?');
        faviconStore.set(key, fallback);
        return fallback;
      } finally {
        faviconCache.delete(key);
        scheduleRender();
      }
    })();
    faviconCache.set(key, promise);
    return promise;
  } catch (_) {
    const key = url;
    if (faviconStore.has(key)) {
      return faviconStore.get(key);
    }
    if (faviconCache.has(key)) {
      return faviconCache.get(key);
    }
    const promise = (async () => {
      const fallback = await createInitialsBitmap(title || '?');
      faviconStore.set(key, fallback);
      faviconCache.delete(key);
      scheduleRender();
      return fallback;
    })();
    faviconCache.set(key, promise);
    return promise;
  }
}

function getFaviconKey(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch (_) {
    return url;
  }
}

async function fetchFavicon(url) {
  const candidates = [];
  try {
    const u = new URL(url);
    candidates.push(`${u.origin}/favicon.ico`);
    candidates.push(`https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(u.origin)}`);
  } catch (_) {
    candidates.push(`https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(url)}`);
  }
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { cache: 'force-cache' });
      if (!response.ok) continue;
      const blob = await response.blob();
      return createImageBitmap(blob);
    } catch (error) {
      // try next candidate
    }
  }
  throw new Error('favicon fetch failed');
}

async function createInitialsBitmap(text) {
  const letter = (text || '?').trim().charAt(0).toUpperCase() || '?';
  const size = 128;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d');
  context.fillStyle = '#1f2430';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#4cc9f0';
  context.font = '64px "Inter", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(letter, size / 2, size / 2 + 6);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return createImageBitmap(blob);
}

function handlePointerDown(event) {
  if (event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  state.drag.active = true;
  state.drag.originX = event.clientX;
  state.drag.originY = event.clientY;
  state.drag.startOffsetX = state.viewport.offsetX;
  state.drag.startOffsetY = state.viewport.offsetY;
  state.drag.moved = false;
}

function handlePointerMove(event) {
  const rect = canvas.getBoundingClientRect();
  const worldPoint = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  updateHover(worldPoint, event);

  if (!state.drag.active) return;
  const dx = event.clientX - state.drag.originX;
  const dy = event.clientY - state.drag.originY;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    state.drag.moved = true;
  }
  state.viewport.offsetX = state.drag.startOffsetX + dx;
  state.viewport.offsetY = state.drag.startOffsetY + dy;
  scheduleRender();
}

function handlePointerUpOrCancel(event) {
  if (state.drag.active) {
    state.drag.active = false;
    canvas.releasePointerCapture(event.pointerId);
  }
}

function handleWheel(event) {
  event.preventDefault();
  const { offsetX, offsetY, deltaY } = event;
  const factor = Math.exp(-deltaY * SCROLL_ZOOM_FACTOR);
  applyZoom(factor, { x: offsetX, y: offsetY });
}

function applyZoom(factor, anchor) {
  const { scale, offsetX, offsetY } = state.viewport;
  const newScale = clamp(scale * factor, SCALE_MIN, SCALE_MAX);
  const rect = canvas.getBoundingClientRect();
  const anchorPoint = anchor || { x: rect.width / 2, y: rect.height / 2 };
  state.viewport.scale = newScale;
  const worldX = (anchorPoint.x - offsetX) / scale;
  const worldY = (anchorPoint.y - offsetY) / scale;
  state.viewport.offsetX = anchorPoint.x - worldX * newScale;
  state.viewport.offsetY = anchorPoint.y - worldY * newScale;
  scheduleRender();
}

function screenToWorld(x, y) {
  const scale = state.viewport.scale;
  return {
    x: (x - state.viewport.offsetX) / scale,
    y: (y - state.viewport.offsetY) / scale,
  };
}

function handleCanvasClick(event) {
  if (state.drag.moved) {
    state.drag.moved = false;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  const node = findNodeAt(world.x, world.y);
  if (node) {
    chrome.runtime.sendMessage({ type: 'tab:activate', tabId: node.id }).catch((error) => {
      console.warn('tab:activate failed', error);
    });
  }
}

function handleContextMenu(event) {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
  const node = findNodeAt(world.x, world.y);
  if (node) {
    chrome.runtime.sendMessage({ type: 'tab:close', tabId: node.id }).catch((error) => {
      console.warn('tab:close failed', error);
    });
  }
}

function findNodeAt(x, y) {
  for (const entry of state.layout.values()) {
    if (x >= entry.left && x <= entry.right && y >= entry.top && y <= entry.bottom) {
      return entry.node;
    }
  }
  return null;
}

function updateHover(worldPoint, event) {
  const node = findNodeAt(worldPoint.x, worldPoint.y);
  if (!node) {
    hideHoverCard();
    state.hoverTabId = null;
    return;
  }
  if (state.hoverTabId === node.id) {
    positionHoverCard(event.clientX, event.clientY);
    return;
  }
  state.hoverTabId = node.id;
  hoverTitle.textContent = node.title || '(Untitled tab)';
  hoverDomain.textContent = extractDomain(node.url);
  const key = getFaviconKey(node.url);
  const ready = faviconStore.get(key);
  if (ready) {
    assignHoverFavicon(ready).catch(() => hoverFavicon.removeAttribute('src'));
  } else {
    hoverFavicon.removeAttribute('src');
    getFaviconBitmap(node.url, node.title)
      .then((bitmap) => assignHoverFavicon(bitmap).catch(() => hoverFavicon.removeAttribute('src')))
      .catch(() => hoverFavicon.removeAttribute('src'));
  }
  hoverCard.hidden = false;
  positionHoverCard(event.clientX, event.clientY);
}

function positionHoverCard(clientX, clientY) {
  const offset = 18;
  const rect = hoverCard.getBoundingClientRect();
  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;

  let left = clientX + offset;
  let top = clientY + offset;

  if (left + rect.width > viewWidth - 12) {
    left = Math.max(12, viewWidth - rect.width - 12);
  }
  if (top + rect.height > viewHeight - 12) {
    top = clientY - rect.height - offset;
    if (top < 12) {
      top = Math.max(12, viewHeight - rect.height - 12);
    }
  }

  hoverCard.style.left = `${left}px`;
  hoverCard.style.top = `${top}px`;
}

function hideHoverCard() {
  hoverCard.hidden = true;
  hoverFavicon.removeAttribute('src');
  if (hoverFaviconUrl) {
    URL.revokeObjectURL(hoverFaviconUrl);
    hoverFaviconUrl = null;
  }
}

async function assignHoverFavicon(bitmap) {
  if (hoverFaviconUrl) {
    URL.revokeObjectURL(hoverFaviconUrl);
    hoverFaviconUrl = null;
  }
  const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
  const offCtx = offscreen.getContext('2d');
  offCtx.drawImage(bitmap, 0, 0);
  const blob = await offscreen.convertToBlob({ type: 'image/png' });
  hoverFaviconUrl = URL.createObjectURL(blob);
  hoverFavicon.src = hoverFaviconUrl;
}

function resetView(animated) {
  if (!state.bounds) {
    state.viewport.scale = 1;
    state.viewport.offsetX = 0;
    state.viewport.offsetY = 0;
    scheduleRender();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const margin = 120;
  const availableWidth = Math.max(1, rect.width - margin);
  const availableHeight = Math.max(1, rect.height - margin);
  const scaleX = availableWidth / (state.bounds.width || NODE_WIDTH);
  const scaleY = availableHeight / (state.bounds.height || NODE_HEIGHT);
  const scale = clamp(Math.min(scaleX, scaleY), SCALE_MIN, SCALE_MAX);

  state.viewport.scale = scale;
  state.viewport.offsetX = rect.width / 2 - state.bounds.centerX * scale;
  state.viewport.offsetY = rect.height / 2 - state.bounds.centerY * scale;
  scheduleRender();
}

function updateStatusStrip() {
  const windowCount = new Set(state.graph.nodes.map((node) => node.windowId)).size;
  const tabsCount = state.graph.nodes.length;
  const pendingCount = Array.from(state.graph.nodes).filter((node) => state.pendingThumbs.has(node.id)).length;
  const blockedCount = Array.from(state.graph.nodes).filter((node) => state.thumbnails.get(node.id)?.blocked).length;
  const parts = [];
  parts.push(`${windowCount} window${windowCount === 1 ? '' : 's'}`);
  parts.push(`${tabsCount} tab${tabsCount === 1 ? '' : 's'}`);
  if (pendingCount > 0) {
    parts.push(`<span class="status-highlight">${pendingCount} thumb${pendingCount === 1 ? '' : 's'} pending</span>`);
  }
  if (blockedCount > 0) {
    parts.push(`<span class="status-warning">${blockedCount} restricted</span>`);
  }
  statusStrip.innerHTML = parts.join(' · ');
}

function getThumbnailStorageKey(tabId) {
  return `${THUMB_STORAGE_PREFIX}${tabId}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function handleKeyDown(event) {
  if (event.target && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
  if (event.key === '+') {
    applyZoom(SCALE_STEP);
  } else if (event.key === '-') {
    applyZoom(1 / SCALE_STEP);
  } else if (event.key === '0') {
    resetView();
  } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    cycleActiveNode(event.key);
    event.preventDefault();
  } else if (event.key === 'Delete') {
    if (state.hoverTabId) {
      chrome.runtime.sendMessage({ type: 'tab:close', tabId: state.hoverTabId }).catch((error) => console.warn('tab:close failed', error));
    }
  }
}

function cycleActiveNode(directionKey) {
  if (state.graph.nodes.length === 0) return;
  const sorted = state.graph.nodes.slice().sort((a, b) => a.id - b.id);
  const currentIndex = sorted.findIndex((node) => node.id === state.hoverTabId);
  let nextIndex = 0;
  if (currentIndex >= 0) {
    if (directionKey === 'ArrowRight' || directionKey === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % sorted.length;
    } else {
      nextIndex = (currentIndex - 1 + sorted.length) % sorted.length;
    }
  }
  const nextNode = sorted[nextIndex];
  state.hoverTabId = nextNode.id;
  chrome.runtime.sendMessage({ type: 'tab:activate', tabId: nextNode.id }).catch((error) => console.warn('tab:activate failed', error));
}

function prefetchFavicon(node) {
  getFaviconBitmap(node.url, node.title).catch(() => {
    /* ignore */
  });
}
