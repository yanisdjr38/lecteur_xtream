const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const crypto = require("crypto");

/* =========================
   CACHE SYSTEM
========================= */
const CACHE_DIR = path.join(app.getPath("userData"), "cache");
const CACHE_IMAGES_DIR = path.join(CACHE_DIR, "images");
const CACHE_DATA_DIR = path.join(CACHE_DIR, "data");
const CACHE_INDEX_FILE = path.join(CACHE_DIR, "index.json");

const CACHE_MAX_SIZE_MB = 500;
const CACHE_MAX_AGE_DAYS = 30;
const CACHE_IMAGE_MAX_AGE_DAYS = 7;

let cacheIndex = { images: {}, data: {}, totalSize: 0, lastCleanup: 0 };

function initCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (!fs.existsSync(CACHE_IMAGES_DIR)) fs.mkdirSync(CACHE_IMAGES_DIR, { recursive: true });
    if (!fs.existsSync(CACHE_DATA_DIR)) fs.mkdirSync(CACHE_DATA_DIR, { recursive: true });
    
    if (fs.existsSync(CACHE_INDEX_FILE)) {
      cacheIndex = JSON.parse(fs.readFileSync(CACHE_INDEX_FILE, "utf-8"));
    }
    
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (cacheIndex.lastCleanup < oneDayAgo) cleanupCache();
    
    console.log(`Cache initialized: ${(cacheIndex.totalSize / 1024 / 1024).toFixed(2)} MB`);
  } catch (err) {
    console.error("Cache init error:", err);
  }
}

function saveCacheIndex() {
  try {
    fs.writeFileSync(CACHE_INDEX_FILE, JSON.stringify(cacheIndex, null, 2));
  } catch (err) {
    console.error("Save cache index error:", err);
  }
}

function hashUrl(url) {
  return crypto.createHash("md5").update(url).digest("hex");
}

function getImageExtension(url, contentType) {
  if (contentType) {
    if (contentType.includes("png")) return ".png";
    if (contentType.includes("gif")) return ".gif";
    if (contentType.includes("webp")) return ".webp";
  }
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if ([".png", ".gif", ".webp", ".jpg", ".jpeg"].includes(ext)) return ext;
  return ".jpg";
}

async function cleanupCache() {
  console.log("Starting cache cleanup...");
  const now = Date.now();
  let freedSize = 0;
  
  const imageMaxAge = CACHE_IMAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const [hash, info] of Object.entries(cacheIndex.images)) {
    if (now - info.cachedAt > imageMaxAge) {
      try {
        const filePath = path.join(CACHE_IMAGES_DIR, info.filename);
        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); freedSize += info.size || 0; }
        delete cacheIndex.images[hash];
      } catch {}
    }
  }
  
  const dataMaxAge = CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const [key, info] of Object.entries(cacheIndex.data)) {
    if (now - info.cachedAt > dataMaxAge) {
      try {
        const filePath = path.join(CACHE_DATA_DIR, info.filename);
        if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); freedSize += info.size || 0; }
        delete cacheIndex.data[key];
      } catch {}
    }
  }
  
  const maxSizeBytes = CACHE_MAX_SIZE_MB * 1024 * 1024;
  if (cacheIndex.totalSize > maxSizeBytes) {
    const allItems = [
      ...Object.entries(cacheIndex.images).map(([k, v]) => ({ type: "images", key: k, ...v })),
      ...Object.entries(cacheIndex.data).map(([k, v]) => ({ type: "data", key: k, ...v }))
    ].sort((a, b) => a.cachedAt - b.cachedAt);
    
    for (const item of allItems) {
      if (cacheIndex.totalSize <= maxSizeBytes * 0.8) break;
      try {
        const dir = item.type === "images" ? CACHE_IMAGES_DIR : CACHE_DATA_DIR;
        const filePath = path.join(dir, item.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          freedSize += item.size || 0;
          cacheIndex.totalSize -= item.size || 0;
        }
        delete cacheIndex[item.type][item.key];
      } catch {}
    }
  }
  
  cacheIndex.totalSize = Math.max(0, cacheIndex.totalSize - freedSize);
  cacheIndex.lastCleanup = now;
  saveCacheIndex();
  console.log(`Cache cleanup complete: freed ${(freedSize / 1024 / 1024).toFixed(2)} MB`);
}

/* =========================
   IMAGE CACHING
========================= */
function downloadBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https") ? https : http;
    
    const req = lib.request(url, {
      method: "GET", timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*,*/*" },
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        return resolve(downloadBuffer(new URL(res.headers.location, url).toString(), redirectCount + 1));
      }
      if (code < 200 || code >= 300) { res.resume(); return reject(new Error(`HTTP ${code}`)); }
      
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers["content-type"] || "" }));
      res.on("error", reject);
    });
    
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Timeout")));
    req.end();
  });
}

ipcMain.handle("cache:getImage", async (_e, url) => {
  if (!url || typeof url !== "string") return null;
  
  try {
    const hash = hashUrl(url);
    
    if (cacheIndex.images[hash]) {
      const info = cacheIndex.images[hash];
      const filePath = path.join(CACHE_IMAGES_DIR, info.filename);
      
      if (fs.existsSync(filePath)) {
        info.lastAccess = Date.now();
        info.accessCount = (info.accessCount || 0) + 1;
        const data = fs.readFileSync(filePath);
        return `data:${info.mimeType || "image/jpeg"};base64,${data.toString("base64")}`;
      }
      delete cacheIndex.images[hash];
    }
    
    const { buffer, contentType } = await downloadBuffer(url);
    const ext = getImageExtension(url, contentType);
    const filename = `${hash}${ext}`;
    fs.writeFileSync(path.join(CACHE_IMAGES_DIR, filename), buffer);
    
    const mimeType = contentType || `image/${ext.slice(1)}`;
    cacheIndex.images[hash] = {
      filename, url, size: buffer.length, mimeType,
      cachedAt: Date.now(), lastAccess: Date.now(), accessCount: 1
    };
    cacheIndex.totalSize += buffer.length;
    saveCacheIndex();
    
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.warn("Image cache error:", url.slice(0, 50), err.message);
    return null;
  }
});

ipcMain.handle("cache:preloadImages", async (_e, urls) => {
  if (!Array.isArray(urls)) return { success: 0, failed: 0 };
  let success = 0, failed = 0;
  
  for (let i = 0; i < urls.length; i += 5) {
    const batch = urls.slice(i, i + 5).filter(u => u && typeof u === "string");
    await Promise.allSettled(batch.map(async (url) => {
      try {
        const hash = hashUrl(url);
        if (cacheIndex.images[hash]) { success++; return; }
        const { buffer, contentType } = await downloadBuffer(url);
        const ext = getImageExtension(url, contentType);
        const filename = `${hash}${ext}`;
        fs.writeFileSync(path.join(CACHE_IMAGES_DIR, filename), buffer);
        cacheIndex.images[hash] = {
          filename, url, size: buffer.length, mimeType: contentType || `image/${ext.slice(1)}`,
          cachedAt: Date.now(), lastAccess: Date.now(), accessCount: 0
        };
        cacheIndex.totalSize += buffer.length;
        success++;
      } catch { failed++; }
    }));
  }
  saveCacheIndex();
  return { success, failed };
});

/* =========================
   DATA CACHING
========================= */
ipcMain.handle("cache:getData", async (_e, key) => {
  try {
    if (!cacheIndex.data[key]) return null;
    const info = cacheIndex.data[key];
    const filePath = path.join(CACHE_DATA_DIR, info.filename);
    if (!fs.existsSync(filePath)) { delete cacheIndex.data[key]; return null; }
    
    const maxAge = info.maxAge || CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const expired = Date.now() - info.cachedAt > maxAge;
    info.lastAccess = Date.now();
    info.accessCount = (info.accessCount || 0) + 1;
    
    return { data: JSON.parse(fs.readFileSync(filePath, "utf-8")), expired };
  } catch { return null; }
});

ipcMain.handle("cache:setData", async (_e, { key, data, maxAge }) => {
  try {
    const filename = `${hashUrl(key)}.json`;
    const content = JSON.stringify(data);
    fs.writeFileSync(path.join(CACHE_DATA_DIR, filename), content);
    
    const size = Buffer.byteLength(content);
    if (cacheIndex.data[key]) cacheIndex.totalSize -= cacheIndex.data[key].size || 0;
    
    cacheIndex.data[key] = {
      filename, size, maxAge: maxAge || CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
      cachedAt: Date.now(), lastAccess: Date.now(), accessCount: 1
    };
    cacheIndex.totalSize += size;
    saveCacheIndex();
    return true;
  } catch { return false; }
});

ipcMain.handle("cache:getStats", async () => ({
  imageCount: Object.keys(cacheIndex.images).length,
  dataCount: Object.keys(cacheIndex.data).length,
  totalSizeMB: (cacheIndex.totalSize / 1024 / 1024).toFixed(2),
  maxSizeMB: CACHE_MAX_SIZE_MB,
  usagePercent: ((cacheIndex.totalSize / 1024 / 1024 / CACHE_MAX_SIZE_MB) * 100).toFixed(1),
  lastCleanup: cacheIndex.lastCleanup
}));

ipcMain.handle("cache:clear", async (_e, type) => {
  try {
    if (type === "all" || type === "images") {
      for (const info of Object.values(cacheIndex.images)) {
        try {
          const fp = path.join(CACHE_IMAGES_DIR, info.filename);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
          cacheIndex.totalSize -= info.size || 0;
        } catch {}
      }
      cacheIndex.images = {};
    }
    if (type === "all" || type === "data") {
      for (const info of Object.values(cacheIndex.data)) {
        try {
          const fp = path.join(CACHE_DATA_DIR, info.filename);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
          cacheIndex.totalSize -= info.size || 0;
        } catch {}
      }
      cacheIndex.data = {};
    }
    cacheIndex.totalSize = Math.max(0, cacheIndex.totalSize);
    saveCacheIndex();
    return true;
  } catch { return false; }
});

/* =========================
   NETWORK QUALITY
========================= */
let networkStats = { latency: 0, quality: "unknown", qualityScore: 0, lastCheck: 0, history: [] };

ipcMain.handle("network:checkQuality", async (_e, testUrl) => {
  try {
    const start = Date.now();
    const latency = await new Promise((resolve) => {
      const lib = testUrl.startsWith("https") ? https : http;
      const req = lib.request(testUrl, { method: "HEAD", timeout: 5000 }, (res) => {
        res.resume();
        resolve(Date.now() - start);
      });
      req.on("error", () => resolve(-1));
      req.on("timeout", () => { req.destroy(); resolve(-1); });
      req.end();
    });
    
    let quality = "unknown", qualityScore = 0;
    if (latency > 0) {
      if (latency < 100) { quality = "excellent"; qualityScore = 100; }
      else if (latency < 200) { quality = "good"; qualityScore = 80; }
      else if (latency < 500) { quality = "fair"; qualityScore = 60; }
      else if (latency < 1000) { quality = "poor"; qualityScore = 40; }
      else { quality = "bad"; qualityScore = 20; }
    }
    
    networkStats = {
      latency, quality, qualityScore, lastCheck: Date.now(),
      history: [...networkStats.history.slice(-19), { latency, time: Date.now() }]
    };
    return networkStats;
  } catch (err) {
    return { latency: -1, quality: "error", qualityScore: 0, error: err.message };
  }
});

ipcMain.handle("network:getStats", async () => networkStats);

ipcMain.handle("network:testStream", async (_e, streamUrl) => {
  const start = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      const lib = streamUrl.startsWith("https") ? https : http;
      let bytes = 0, firstByteTime = 0;
      
      const req = lib.request(streamUrl, {
        method: "GET", timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0", Range: "bytes=0-1048576" }
      }, (res) => {
        if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        
        res.on("data", (chunk) => {
          if (!firstByteTime) firstByteTime = Date.now() - start;
          bytes += chunk.length;
          if (bytes > 1048576 || Date.now() - start > 10000) req.destroy();
        });
        res.on("end", () => resolve({ bytes, firstByteTime }));
        res.on("close", () => resolve({ bytes, firstByteTime }));
        res.on("error", reject);
      });
      
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
      req.end();
    });
    
    const duration = (Date.now() - start) / 1000;
    const speedMbps = (result.bytes * 8 / 1024 / 1024) / duration;
    
    let recommendedQuality = "SD";
    if (speedMbps >= 25) recommendedQuality = "4K";
    else if (speedMbps >= 10) recommendedQuality = "FHD";
    else if (speedMbps >= 5) recommendedQuality = "HD";
    
    return {
      success: true, bytesReceived: result.bytes, firstByteMs: result.firstByteTime,
      durationMs: Date.now() - start, speedMbps: speedMbps.toFixed(2), recommendedQuality
    };
  } catch (err) {
    return { success: false, error: err.message, durationMs: Date.now() - start };
  }
});

/* =========================
   OFFLINE MODE
========================= */
ipcMain.handle("offline:exportData", async (_e, { categories, items, type }) => {
  try {
    const exportData = { version: 1, exportedAt: Date.now(), type, categories, items };
    const filename = `iptv_offline_${type}_${Date.now()}.json`;
    const filePath = path.join(CACHE_DATA_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(exportData));
    return { success: true, filename, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("offline:importData", async (_e, filePath) => {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!data.version || !data.type || !data.items) throw new Error("Invalid format");
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("offline:listExports", async () => {
  try {
    return fs.readdirSync(CACHE_DATA_DIR)
      .filter(f => f.startsWith("iptv_offline_"))
      .map(f => {
        const filePath = path.join(CACHE_DATA_DIR, f);
        const stats = fs.statSync(filePath);
        const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return { filename: f, path: filePath, size: stats.size, type: content.type, itemCount: content.items?.length || 0, exportedAt: content.exportedAt };
      });
  } catch { return []; }
});

/* =========================
   DOWNLOAD & XTREAM
========================= */
function downloadText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));
    const lib = url.startsWith("https") ? https : http;

    const req = lib.request(url, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*", "Accept-Encoding": "gzip, deflate", Connection: "keep-alive" },
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        return resolve(downloadText(new URL(res.headers.location, url).toString(), redirectCount + 1));
      }

      let stream = res;
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());

      let data = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => (data += chunk));
      stream.on("end", () => {
        if (code >= 200 && code < 300) return resolve(data);
        reject(new Error(`HTTP ${code}`));
      });
      stream.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout")));
    req.end();
  });
}

ipcMain.handle("m3u:loadUrl", async (_e, url) => {
  if (typeof url !== "string" || !url.startsWith("http")) throw new Error("URL invalide");
  return downloadText(url);
});

function xtreamBase(domain) {
  const d = (domain || "").trim().replace(/\/+$/, "");
  if (!d) throw new Error("Domaine Xtream manquant");
  return /^https?:\/\//i.test(d) ? d : `http://${d}`;
}

async function xtreamJson({ domain, username, password, params = {} }) {
  if (!username || !password) throw new Error("Credentials manquants");
  const u = new URL(`${xtreamBase(domain)}/player_api.php`);
  u.searchParams.set("username", username);
  u.searchParams.set("password", password);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const txt = await downloadText(u.toString());
  try { return JSON.parse(txt); } catch { throw new Error(`Non JSON: ${txt.slice(0, 200)}`); }
}

ipcMain.handle("xtream:handshake", async (_e, p) => xtreamJson(p));
ipcMain.handle("xtream:getLiveCategories", async (_e, p) => xtreamJson({ ...p, params: { action: "get_live_categories" } }));
ipcMain.handle("xtream:getLiveStreams", async (_e, p) => {
  const params = { action: "get_live_streams" };
  if (p.category_id) params.category_id = p.category_id;
  return xtreamJson({ ...p, params });
});
ipcMain.handle("xtream:getVodCategories", async (_e, p) => xtreamJson({ ...p, params: { action: "get_vod_categories" } }));
ipcMain.handle("xtream:getVodStreams", async (_e, p) => {
  const params = { action: "get_vod_streams" };
  if (p.category_id) params.category_id = p.category_id;
  return xtreamJson({ ...p, params });
});
ipcMain.handle("xtream:getSeriesCategories", async (_e, p) => xtreamJson({ ...p, params: { action: "get_series_categories" } }));
ipcMain.handle("xtream:getSeries", async (_e, p) => {
  const params = { action: "get_series" };
  if (p.category_id) params.category_id = p.category_id;
  return xtreamJson({ ...p, params });
});
ipcMain.handle("xtream:getSeriesInfo", async (_e, p) => {
  if (!p.series_id) throw new Error("series_id manquant");
  return xtreamJson({ ...p, params: { action: "get_series_info", series_id: p.series_id } });
});
ipcMain.handle("xtream:getShortEPG", async (_e, p) => {
  if (!p.stream_id) throw new Error("stream_id manquant");
  return xtreamJson({ ...p, params: { action: "get_short_epg", stream_id: p.stream_id, limit: p.limit || 4 } });
});
ipcMain.handle("xtream:getVodInfo", async (_e, p) => {
  if (!p.vod_id) throw new Error("vod_id manquant");
  return xtreamJson({ ...p, params: { action: "get_vod_info", vod_id: p.vod_id } });
});

/* =========================
   WINDOW
========================= */
function createWindow() {
  const win = new BrowserWindow({
    width: 1320, height: 880,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => { initCache(); createWindow(); });
app.on("window-all-closed", () => { saveCacheIndex(); if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => saveCacheIndex());
