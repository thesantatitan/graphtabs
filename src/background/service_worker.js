'use strict';

const UI_PAGE_PATH = 'src/tabgraph/index.html';
const GRAPH_BROADCAST_DELAY_MS = 75;
const CAPTURE_DEBOUNCE_MS = 200;
const THUMB_TARGET_WIDTH = 160;
const THUMB_TARGET_HEIGHT = 100;
const THUMB_JPEG_QUALITY = 0.7;
const THUMB_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const THUMB_MAX_ENTRIES = 120;
const THUMB_STORAGE_PREFIX = 'thumb_';

/** @typedef {{ id: number, title: string, url: string, windowId: number, openerTabId: number | null, active: boolean }} TabNode */
/** @typedef {{ from: number, to: number }} TabEdge */
/** @typedef {{ nodes: TabNode[], edges: TabEdge[] }} TabGraph */
/** @typedef {{ dataUrl: string | null, blocked: boolean, lastUpdated: number, bytes: number }} ThumbEntry */

const graphState = {
  /** @type {Map<number, chrome.tabs.Tab>} */
  tabs: new Map(),
  /** @type {number | null} */
  broadcastTimer: null,
};

const thumbnailState = {
  /** @type {Map<number, ThumbEntry>} */
  entries: new Map(),
  /** @type {Map<number, number>} */
  timers: new Map(),
  /** @type {Set<number>} */
  inflight: new Set(),
  totalBytes: 0,
};

init().catch((error) => console.error('Service worker init failed', error));

async function init() {
  await Promise.all([
    hydrateThumbnailCache(),
    refreshAllTabs(),
  ]);
  wireTabListeners();
  wireRuntimeListeners();
  console.debug('GraphTabs service worker ready');
}

function wireTabListeners() {
  chrome.runtime.onStartup.addListener(refreshAllTabs);
  chrome.runtime.onInstalled.addListener(refreshAllTabs);

  chrome.tabs.onCreated.addListener((tab) => {
    if (!isValidTab(tab)) return;
    graphState.tabs.set(tab.id, tab);
    scheduleGraphBroadcast();
    if (tab.active) {
      scheduleThumbnailCapture(tab.id, tab.windowId, 'created-active');
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const base = tab ?? graphState.tabs.get(tabId);
    if (!base || !isValidTab(base)) return;

    const next = tab ?? { ...base, ...changeInfo };
    graphState.tabs.set(tabId, next);
    scheduleGraphBroadcast();

    if (next.active && changeInfo.status === 'complete') {
      scheduleThumbnailCapture(tabId, next.windowId, 'updated-complete');
    }
  });

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isValidTab(tab)) return;
      graphState.tabs.set(tab.id, tab);
      scheduleGraphBroadcast();
      scheduleThumbnailCapture(tab.id, tab.windowId, 'activated');
    } catch (error) {
      console.warn('onActivated get failed', error);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    graphState.tabs.delete(tabId);
    scheduleGraphBroadcast();
    removeThumbnail(tabId).catch((error) => console.warn('removeThumbnail failed', error));
  });

  chrome.tabs.onAttached.addListener(async (tabId) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isValidTab(tab)) return;
      graphState.tabs.set(tabId, tab);
      scheduleGraphBroadcast();
    } catch (error) {
      console.warn('onAttached get failed', error);
    }
  });

  chrome.tabs.onDetached.addListener((tabId) => {
    graphState.tabs.delete(tabId);
    scheduleGraphBroadcast();
  });

  chrome.tabs.onMoved.addListener(async (tabId) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isValidTab(tab)) return;
      graphState.tabs.set(tabId, tab);
      scheduleGraphBroadcast();
    } catch (error) {
      console.warn('onMoved get failed', error);
    }
  });

  chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    graphState.tabs.delete(removedTabId);
    await removeThumbnail(removedTabId).catch((error) => console.warn('removeThumbnail on replace failed', error));
    try {
      const tab = await chrome.tabs.get(addedTabId);
      if (!isValidTab(tab)) return;
      graphState.tabs.set(addedTabId, tab);
      scheduleGraphBroadcast();
      if (tab.active) {
        scheduleThumbnailCapture(tab.id, tab.windowId, 'replaced-active');
      }
    } catch (error) {
      console.warn('onReplaced get failed', error);
    }
  });
}

function wireRuntimeListeners() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return false;
    }

    switch (message.type) {
      case 'graph:get': {
        sendResponse({ graph: buildGraph() });
        return false;
      }
      case 'thumb:get': {
        const tabId = Number(message.tabId);
        const entry = Number.isFinite(tabId) ? thumbnailState.entries.get(tabId) : undefined;
        sendResponse({
          found: Boolean(entry) && !entry.blocked,
          blocked: Boolean(entry?.blocked),
          storageKey: entry ? getThumbnailStorageKey(tabId) : null,
          lastUpdated: entry?.lastUpdated ?? null,
        });
        return false;
      }
      case 'tab:activate': {
        const tabId = Number(message.tabId);
        if (!Number.isFinite(tabId)) {
          sendResponse({ ok: false, error: 'Invalid tabId' });
          return false;
        }
        chrome.tabs.update(tabId, { active: true }).then(async () => {
          const tab = await chrome.tabs.get(tabId);
          if (typeof tab.windowId === 'number') {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          sendResponse({ ok: true });
        }).catch((error) => {
          console.warn('tab:activate failed', error);
          sendResponse({ ok: false, error: error?.message || 'Activation failed' });
        });
        return true;
      }
      case 'tab:close': {
        const tabId = Number(message.tabId);
        if (!Number.isFinite(tabId)) {
          sendResponse({ ok: false, error: 'Invalid tabId' });
          return false;
        }
        chrome.tabs.remove(tabId).then(() => {
          sendResponse({ ok: true });
        }).catch((error) => {
          console.warn('tab:close failed', error);
          sendResponse({ ok: false, error: error?.message || 'Close failed' });
        });
        return true;
      }
      case 'window:focus': {
        const windowId = Number(message.windowId);
        if (!Number.isFinite(windowId)) {
          sendResponse({ ok: false, error: 'Invalid windowId' });
          return false;
        }
        chrome.windows.update(windowId, { focused: true }).then(() => {
          sendResponse({ ok: true });
        }).catch((error) => {
          console.warn('window:focus failed', error);
          sendResponse({ ok: false, error: error?.message || 'Window focus failed' });
        });
        return true;
      }
      default:
        return false;
    }
  });

  chrome.action.onClicked.addListener(async () => {
    const url = chrome.runtime.getURL(UI_PAGE_PATH);
    const existing = await chrome.tabs.query({ url });
    if (existing.length > 0) {
      const tab = existing[0];
      await chrome.tabs.update(tab.id, { active: true });
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return;
    }
    await chrome.tabs.create({ url });
  });
}

async function refreshAllTabs() {
  const tabs = await chrome.tabs.query({});
  graphState.tabs.clear();
  for (const tab of tabs) {
    if (!isValidTab(tab)) continue;
    graphState.tabs.set(tab.id, tab);
  }
  scheduleGraphBroadcast();
}

function buildGraph() {
  /** @type {TabGraph} */
  const graph = { nodes: [], edges: [] };

  for (const tab of graphState.tabs.values()) {
    if (!isValidTab(tab)) continue;
    graph.nodes.push({
      id: tab.id,
      title: tab.title ?? '',
      url: tab.url ?? '',
      windowId: tab.windowId ?? chrome.windows.WINDOW_ID_NONE,
      openerTabId: typeof tab.openerTabId === 'number' ? tab.openerTabId : null,
      active: Boolean(tab.active),
    });
  }

  for (const tab of graphState.tabs.values()) {
    if (!isValidTab(tab)) continue;
    if (typeof tab.openerTabId === 'number' && graphState.tabs.has(tab.openerTabId)) {
      graph.edges.push({ from: tab.openerTabId, to: tab.id });
    }
  }

  return graph;
}

function scheduleGraphBroadcast() {
  if (graphState.broadcastTimer !== null) {
    clearTimeout(graphState.broadcastTimer);
  }

  graphState.broadcastTimer = setTimeout(async () => {
    graphState.broadcastTimer = null;
    const graph = buildGraph();
    try {
      await chrome.runtime.sendMessage({ type: 'graph:update', graph });
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.debug('graph:update delivery skipped', chrome.runtime.lastError.message);
      } else {
        console.warn('graph:update delivery failed', error);
      }
    }
  }, GRAPH_BROADCAST_DELAY_MS);
}

function isValidTab(tab) {
  return Boolean(tab && typeof tab.id === 'number' && tab.id >= 0);
}

function scheduleThumbnailCapture(tabId, windowId, reason) {
  if (!Number.isFinite(tabId)) return;
  if (thumbnailState.inflight.has(tabId)) return;
  const existing = thumbnailState.timers.get(tabId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    thumbnailState.timers.delete(tabId);
    captureThumbnail(tabId, windowId, reason).catch((error) => {
      console.warn('captureThumbnail failed', error);
      thumbnailState.inflight.delete(tabId);
    });
  }, CAPTURE_DEBOUNCE_MS);
  thumbnailState.timers.set(tabId, timer);
}

async function captureThumbnail(tabId, windowId, reason) {
  if (thumbnailState.inflight.has(tabId)) return;
  thumbnailState.inflight.add(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isValidTab(tab)) return;
    if (!tab.active) return;

    const targetWindowId = typeof windowId === 'number' ? windowId : tab.windowId;
    if (!Number.isFinite(targetWindowId)) return;

    const dataUrl = await chrome.tabs.captureVisibleTab(targetWindowId, {
      format: 'jpeg',
      quality: Math.round(THUMB_JPEG_QUALITY * 100),
    }).catch((error) => {
      throw new Error(error?.message || 'captureVisibleTab failed');
    });

    if (!dataUrl) {
      throw new Error('captureVisibleTab returned empty dataUrl');
    }

    const downscaled = await downscaleDataUrl(dataUrl, THUMB_TARGET_WIDTH, THUMB_TARGET_HEIGHT).catch((error) => {
      console.warn('downscale failed, using original size', error);
      return dataUrl;
    });

    await saveThumbnail(tabId, {
      dataUrl: downscaled,
      blocked: false,
      lastUpdated: Date.now(),
    });
    await notifyThumbUpdate(tabId, reason);
  } catch (error) {
    const blocked = isCaptureBlockedError(error);
    if (blocked) {
      await saveThumbnail(tabId, {
        dataUrl: null,
        blocked: true,
        lastUpdated: Date.now(),
      });
      await notifyThumbUpdate(tabId, 'blocked');
    } else {
      console.warn('captureThumbnail error', error);
    }
  } finally {
    thumbnailState.inflight.delete(tabId);
  }
}

async function downscaleDataUrl(dataUrl, targetWidth, targetHeight) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  const { width, height } = imageBitmap;
  if (!width || !height) {
    return dataUrl;
  }

  const aspect = width / height;
  let drawWidth = targetWidth;
  let drawHeight = Math.round(drawWidth / aspect);
  if (drawHeight > targetHeight) {
    drawHeight = targetHeight;
    drawWidth = Math.round(drawHeight * aspect);
  }

  const offsetX = Math.floor((targetWidth - drawWidth) / 2);
  const offsetY = Math.floor((targetHeight - drawHeight) / 2);

  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(imageBitmap, offsetX, offsetY, drawWidth, drawHeight);

  const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_JPEG_QUALITY });
  const arrayBuffer = await thumbBlob.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);
  return `data:${thumbBlob.type};base64,${base64}`;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function saveThumbnail(tabId, { dataUrl, blocked, lastUpdated }) {
  const existing = thumbnailState.entries.get(tabId);
  if (existing) {
    thumbnailState.totalBytes -= existing.bytes;
  }

  const bytes = dataUrl ? estimateDataUrlBytes(dataUrl) : 0;
  const entry = { dataUrl, blocked, lastUpdated, bytes };
  thumbnailState.entries.set(tabId, entry);
  thumbnailState.totalBytes += bytes;

  await chrome.storage.session.set({ [getThumbnailStorageKey(tabId)]: entry });
  await evictThumbnailsIfNeeded();
}

async function removeThumbnail(tabId) {
  const existing = thumbnailState.entries.get(tabId);
  if (!existing) return;
  thumbnailState.entries.delete(tabId);
  thumbnailState.totalBytes -= existing.bytes;
  await chrome.storage.session.remove(getThumbnailStorageKey(tabId));
}

async function notifyThumbUpdate(tabId, reason) {
  try {
    await chrome.runtime.sendMessage({ type: 'thumb:update', tabId, reason });
  } catch (error) {
    if (chrome.runtime.lastError) {
      console.debug('thumb:update delivery skipped', chrome.runtime.lastError.message);
    } else {
      console.warn('thumb:update delivery failed', error);
    }
  }
}

async function hydrateThumbnailCache() {
  const all = await chrome.storage.session.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(THUMB_STORAGE_PREFIX)) continue;
    if (!value || typeof value !== 'object') continue;
    const tabId = Number(key.substring(THUMB_STORAGE_PREFIX.length));
    if (!Number.isFinite(tabId)) continue;
    const entry = {
      dataUrl: typeof value.dataUrl === 'string' ? value.dataUrl : null,
      blocked: Boolean(value.blocked),
      lastUpdated: typeof value.lastUpdated === 'number' ? value.lastUpdated : Date.now(),
      bytes: value.bytes && Number.isFinite(value.bytes)
        ? Number(value.bytes)
        : (typeof value.dataUrl === 'string' ? estimateDataUrlBytes(value.dataUrl) : 0),
    };
    thumbnailState.entries.set(tabId, entry);
    thumbnailState.totalBytes += entry.bytes;
  }
  await evictThumbnailsIfNeeded();
}

async function evictThumbnailsIfNeeded() {
  if (thumbnailState.entries.size <= THUMB_MAX_ENTRIES && thumbnailState.totalBytes <= THUMB_MAX_TOTAL_BYTES) {
    return;
  }
  const entries = Array.from(thumbnailState.entries.entries());
  entries.sort((a, b) => (a[1].lastUpdated ?? 0) - (b[1].lastUpdated ?? 0));
  for (const [tabId] of entries) {
    if (thumbnailState.entries.size <= THUMB_MAX_ENTRIES && thumbnailState.totalBytes <= THUMB_MAX_TOTAL_BYTES) {
      break;
    }
    await removeThumbnail(tabId);
  }
}

function estimateDataUrlBytes(dataUrl) {
  const base64Index = dataUrl.indexOf(',');
  if (base64Index === -1) return dataUrl.length;
  const base64 = dataUrl.substring(base64Index + 1);
  return Math.ceil((base64.length * 3) / 4);
}

function getThumbnailStorageKey(tabId) {
  return `${THUMB_STORAGE_PREFIX}${tabId}`;
}

function isCaptureBlockedError(error) {
  if (!error) return false;
  const message = typeof error === 'string' ? error : error.message;
  if (!message) return false;
  return /permission|visible tab|active tab|allowed|capture/i.test(message);
}
