/*************************************************
 * renderer.js - IPTV Player Pro
 * Cache, Performance, EPG, Pagination
 *************************************************/

const { execFile } = require("child_process");
const fs = require("fs");
const { ipcRenderer, clipboard } = require("electron");

/* ========================= STATE ========================= */
let channels = [];
let xtCreds = null;
let xtContentType = "live";
let xtCats = [];
let xtItems = [];
const STORAGE_KEY = "xtream_creds_v1";
const PLAYER_KEY = "default_player_v1";

let viewMode = "list";
let currentSeries = null;
let currentPage = 1;
let itemsPerPage = 50;
let filteredItems = [];

// Features toggles
let epgEnabled = true;
let cacheEnabled = true;
let favOnly = false;
let defaultPlayer = "internal"; // "internal" or "vlc"

// EPG Cache
let epgCache = {};
const EPG_CACHE_DURATION = 5 * 60 * 1000;

// Current selected item for stream testing
let currentSelectedItem = null;
let currentStreamUrl = null;

/* ========================= FAVORITES ========================= */
const FAV_KEY = "iptv_favs_v1";
const RESUME_KEY = "iptv_resume_v1";

function loadFavs() {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY)) || {};
  } catch {
    return {};
  }
}
function saveFavs(map) {
  localStorage.setItem(FAV_KEY, JSON.stringify(map));
}
function isFav(key) {
  return !!loadFavs()[key];
}
function toggleFav(key, payload) {
  const map = loadFavs();
  if (map[key]) delete map[key];
  else map[key] = payload || { key, addedAt: Date.now() };
  saveFavs(map);
}
function getFavKeysSet() {
  return new Set(Object.keys(loadFavs()));
}
function loadResume() {
  try {
    return JSON.parse(localStorage.getItem(RESUME_KEY));
  } catch {
    return null;
  }
}
function saveResume(obj) {
  localStorage.setItem(RESUME_KEY, JSON.stringify(obj));
}

/* ========================= UTILS ========================= */
function copyLink(url) {
  clipboard.writeText(url);
  toast("Lien copié", "✓");
}

function toast(msg, icon = "ℹ️") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.innerHTML = `<span class="toast-icon">${icon}</span>${msg}`;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2000);
}

/* ========================= VIDEO PLAYER ========================= */

function playInPlayer(url, title = "Lecture en cours", startTimeSeconds = 0) {
  const modal = document.getElementById("videoPlayerModal");
  const titleEl = document.getElementById("videoTitle");
  const videoElement = document.getElementById("videoPlayer");

  if (!videoElement) {
    toast("❌ Élément vidéo introuvable", "⚠️");
    return;
  }

  if (titleEl) titleEl.textContent = title;
  modal.classList.add("show");

  console.log("Chargement du flux:", url);

  // Utiliser directement l'élément HTML5 video pour plus de compatibilité avec IPTV
  // Nettoyer l'ancienne source
  videoElement.pause();
  videoElement.removeAttribute("src");
  while (videoElement.firstChild) {
    videoElement.removeChild(videoElement.firstChild);
  }

  // Créer un nouvel élément source
  const source = document.createElement("source");
  source.src = url;

  // Déterminer le type MIME
  if (url.includes(".m3u8") || url.includes("m3u8")) {
    source.type = "application/x-mpegURL";
  } else if (url.includes("format=ts") || url.includes(".ts")) {
    source.type = "video/mp2t";
  } else if (url.includes(".mp4")) {
    source.type = "video/mp4";
  }

  videoElement.appendChild(source);

  // Gestionnaire d'erreurs
  let hasError = false;
  videoElement.onerror = function (e) {
    if (hasError) return; // Éviter les erreurs en cascade
    hasError = true;

    console.error("Erreur de chargement vidéo:", e);
    const error = videoElement.error;
    if (error) {
      console.error("Code d'erreur:", error.code, "Message:", error.message);
    }

    toast("❌ Impossible de lire ce flux. Essayez VLC.", "⚠️");

    // Proposer d'ouvrir avec VLC après 2 secondes
    setTimeout(() => {
      if (
        confirm(
          "Impossible de lire le flux dans le lecteur intégré.\n\nVoulez-vous l'ouvrir avec VLC ?"
        )
      ) {
        closeVideoPlayer();
        playInVLC(url, startTimeSeconds);
      } else {
        closeVideoPlayer();
      }
    }, 1000);
  };

  // Événements de chargement
  videoElement.onloadedmetadata = function () {
    console.log("Métadonnées chargées, durée:", videoElement.duration);
    if (startTimeSeconds > 0 && videoElement.duration > startTimeSeconds) {
      videoElement.currentTime = startTimeSeconds;
    }
  };

  videoElement.oncanplay = function () {
    console.log("Vidéo prête à être lue");
    hasError = false; // Réinitialiser le flag d'erreur
  };

  // Charger et lire
  videoElement.load();

  const playPromise = videoElement.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => {
        console.log("Lecture démarrée avec succès");
        toast("▶️ Lecture en cours", "✓");
      })
      .catch((err) => {
        console.error("Erreur lors du démarrage de la lecture:", err);
        if (err.name !== "AbortError") {
          hasError = true;
          toast("❌ Erreur de lecture. Essayez VLC.", "⚠️");
        }
      });
  }

  // Sauvegarder la position toutes les 10 secondes
  videoElement.ontimeupdate = function () {
    if (currentSelectedItem && videoElement.currentTime > 0) {
      const time = videoElement.currentTime;
      if (
        Math.floor(time) % 10 === 0 &&
        Math.floor(time) !== videoElement._lastSaveTime
      ) {
        videoElement._lastSaveTime = Math.floor(time);
        saveResume({ key: currentSelectedItem.key, ts: time });
      }
    }
  };
}

function closeVideoPlayer() {
  const modal = document.getElementById("videoPlayerModal");
  modal.classList.remove("show");

  const videoElement = document.getElementById("videoPlayer");
  if (videoElement) {
    videoElement.pause();
    videoElement.removeAttribute("src");
    // Supprimer tous les éléments source enfants
    while (videoElement.firstChild) {
      videoElement.removeChild(videoElement.firstChild);
    }
    videoElement.load();
    videoElement.onerror = null;
    videoElement.ontimeupdate = null;
    videoElement.onloadedmetadata = null;
    videoElement.oncanplay = null;
  }
}

// Fonction de compatibilité pour VLC (optionnelle)
function playInVLC(url, startTimeSeconds = 0) {
  const args = [
    "--network-caching=3000",
    "--file-caching=3000",
    "--live-caching=3000",
  ];
  if (startTimeSeconds > 0)
    args.push(`--start-time=${Math.floor(startTimeSeconds)}`);
  args.push(url);
  execFile("vlc", args, (err) => {
    if (err) alert("Erreur VLC: " + err.message);
  });
}

function saveCreds(creds) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}
function loadCreds() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}
function clearCreds() {
  localStorage.removeItem(STORAGE_KEY);
}

function savePlayerPref(player) {
  localStorage.setItem(PLAYER_KEY, player);
}
function loadPlayerPref() {
  return localStorage.getItem(PLAYER_KEY) || "internal";
}

function playMedia(url, title, startTime = 0) {
  if (defaultPlayer === "vlc") {
    playInVLC(url, startTime);
  } else {
    // Utiliser le lecteur HTML5 natif
    playInPlayer(url, title, startTime);
  }
}

function setListMeta(count, total = null) {
  const el = document.getElementById("listMeta");
  if (el)
    el.textContent =
      total && total !== count
        ? `${count} / ${total}`
        : `${count} élément${count > 1 ? "s" : ""}`;
}

/* ========================= CACHE STATS ========================= */
async function updateCacheStats() {
  try {
    const stats = await ipcRenderer.invoke("cache:getStats");
    document.getElementById("cacheImages").textContent = stats.imageCount;
    document.getElementById("cacheData").textContent = stats.dataCount;
    document.getElementById(
      "cacheSize"
    ).textContent = `${stats.totalSizeMB} MB`;
    document.getElementById(
      "cachePercent"
    ).textContent = `${stats.usagePercent}%`;

    const bar = document.getElementById("cacheProgressBar");
    const pct = parseFloat(stats.usagePercent);
    bar.style.width = `${Math.min(100, pct)}%`;
    bar.className =
      "cache-progress-bar" +
      (pct > 90 ? " danger" : pct > 70 ? " warning" : "");
  } catch {}
}

/* ========================= IMAGE CACHE ========================= */
async function getCachedImage(url) {
  if (!url || !cacheEnabled) return url;
  try {
    const cached = await ipcRenderer.invoke("cache:getImage", url);
    return cached || url;
  } catch {
    return url;
  }
}

async function preloadVisibleImages() {
  if (!cacheEnabled) return;

  const urls = filteredItems
    .slice(0, 100)
    .map(
      (item) =>
        item.stream_icon ||
        item.cover ||
        item.cover_big ||
        item["tvg-logo"] ||
        item.logo
    )
    .filter(Boolean);

  if (urls.length === 0) return;

  const panel = document.getElementById("preloadPanel");
  const status = document.getElementById("preloadStatus");
  panel.style.display = "block";
  status.textContent = `Préchargement de ${urls.length} images...`;

  try {
    const result = await ipcRenderer.invoke("cache:preloadImages", urls);
    status.textContent = `✓ ${result.success} images en cache`;
    toast(`${result.success} images préchargées`, "💾");
    setTimeout(() => {
      panel.style.display = "none";
    }, 2000);
    updateCacheStats();
  } catch (err) {
    status.textContent = `Erreur: ${err.message}`;
    setTimeout(() => {
      panel.style.display = "none";
    }, 3000);
  }
}

/* ========================= NETWORK QUALITY ========================= */
async function checkNetworkQuality() {
  const indicator = document.getElementById("networkIndicator");
  const bars = document.getElementById("qualityBars");
  const statusEl = document.getElementById("networkStatus");
  const latencyEl = document.getElementById("networkLatency");

  if (!xtCreds) {
    statusEl.textContent = "Non connecté";
    bars.className = "quality-bars";
    latencyEl.textContent = "";
    return;
  }

  try {
    const testUrl = `${baseUrl(xtCreds.domain)}/player_api.php?username=${
      xtCreds.username
    }&password=${xtCreds.password}`;
    const stats = await ipcRenderer.invoke("network:checkQuality", testUrl);

    const levelMap = { excellent: 4, good: 3, fair: 2, poor: 1, bad: 1 };
    const level = levelMap[stats.quality] || 0;

    bars.className = `quality-bars level-${level}`;
    statusEl.textContent =
      stats.quality === "excellent"
        ? "Excellent"
        : stats.quality === "good"
        ? "Bon"
        : stats.quality === "fair"
        ? "Moyen"
        : stats.quality === "poor"
        ? "Faible"
        : "Mauvais";
    latencyEl.textContent = stats.latency > 0 ? `${stats.latency}ms` : "";
  } catch {
    statusEl.textContent = "Erreur";
    bars.className = "quality-bars";
  }
}

/* ========================= STREAM QUALITY TEST ========================= */
async function testCurrentStream() {
  if (!currentStreamUrl) {
    toast("Sélectionnez d'abord un flux", "⚠️");
    return;
  }

  const speedEl = document.getElementById("streamSpeed");
  const latencyEl = document.getElementById("streamLatency");
  const recEl = document.getElementById("streamRecommended");
  const statusEl = document.getElementById("streamStatus");

  speedEl.textContent = "...";
  latencyEl.textContent = "...";
  recEl.textContent = "...";
  statusEl.textContent = "Test...";

  try {
    const result = await ipcRenderer.invoke(
      "network:testStream",
      currentStreamUrl
    );

    if (result.success) {
      speedEl.textContent = result.speedMbps;
      latencyEl.textContent = result.firstByteMs;
      recEl.textContent = result.recommendedQuality;
      statusEl.textContent = "✓ OK";
      statusEl.style.color = "#20c997";
    } else {
      speedEl.textContent = "--";
      latencyEl.textContent = "--";
      recEl.textContent = "--";
      statusEl.textContent = "✗ Erreur";
      statusEl.style.color = "#ff5b6e";
    }
  } catch (err) {
    statusEl.textContent = "✗ Erreur";
    statusEl.style.color = "#ff5b6e";
  }
}

/* ========================= PAGINATION ========================= */
function getTotalPages() {
  return Math.max(1, Math.ceil(filteredItems.length / itemsPerPage));
}
function getPageItems() {
  const start = (currentPage - 1) * itemsPerPage;
  return filteredItems.slice(start, start + itemsPerPage);
}

function updatePaginationUI() {
  const total = getTotalPages();
  document.getElementById(
    "pageInfo"
  ).textContent = `Page ${currentPage} / ${total}`;

  const sel = document.getElementById("pageSelect");
  sel.innerHTML = "";
  for (let i = 1; i <= total; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = i;
    if (i === currentPage) opt.selected = true;
    sel.appendChild(opt);
  }

  document.getElementById("pageFirst").disabled = currentPage <= 1;
  document.getElementById("pagePrev").disabled = currentPage <= 1;
  document.getElementById("pageNext").disabled = currentPage >= total;
  document.getElementById("pageLast").disabled = currentPage >= total;
}

function goToPage(page) {
  const newPage = Math.max(1, Math.min(getTotalPages(), page));
  if (newPage !== currentPage) {
    currentPage = newPage;
    renderCurrentPage();
  }
}

/* ========================= DETAILS PANEL ========================= */
function setDetails({
  title,
  poster,
  metaBadges = [],
  synopsis = "",
  isCached = false,
} = {}) {
  document.getElementById("detailsTitle").textContent = title || "Détails";

  const posterEl = document.getElementById("detailsPoster");
  posterEl.innerHTML = "";
  if (poster) {
    const img = document.createElement("img");
    img.alt = title || "Poster";

    if (cacheEnabled) {
      getCachedImage(poster).then((src) => {
        img.src = src;
      });
    } else {
      img.src = poster;
    }
    posterEl.appendChild(img);

    if (isCached) {
      const badge = document.createElement("span");
      badge.className = "badge cached";
      badge.style.cssText = "position:absolute;top:8px;right:8px;";
      badge.textContent = "💾 En cache";
      posterEl.appendChild(badge);
    }
  } else {
    posterEl.textContent = "Aucune jaquette";
  }

  const metaEl = document.getElementById("detailsMeta");
  metaEl.innerHTML = "";
  metaBadges.forEach((t) => {
    const b = document.createElement("span");
    b.className = "badge";
    b.textContent = t;
    metaEl.appendChild(b);
  });

  document.getElementById("detailsSynopsis").textContent = synopsis || "";
  document.getElementById("epgSection").style.display = "none";
  document.getElementById("streamQuality").style.display = "none";
}

function secondsToHhMm(total) {
  const s = Number(total);
  if (!Number.isFinite(s) || s <= 0) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

/* ========================= EPG ========================= */
async function fetchEPG(streamId) {
  if (!xtCreds || !streamId) return null;
  const cached = epgCache[streamId];
  if (cached && Date.now() - cached.fetchedAt < EPG_CACHE_DURATION)
    return cached.data;

  try {
    const result = await ipcRenderer.invoke("xtream:getShortEPG", {
      ...xtCreds,
      stream_id: streamId,
      limit: 5,
    });
    const epgData = result?.epg_listings || [];
    epgCache[streamId] = { data: epgData, fetchedAt: Date.now() };
    return epgData;
  } catch {
    return null;
  }
}

function formatEPGTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function decodeEPGTitle(title) {
  if (!title) return "";
  try {
    return atob(title);
  } catch {
    return title;
  }
}

function isCurrentProgram(start, end) {
  const now = Date.now() / 1000;
  return now >= Number(start) && now < Number(end);
}

function calculateProgress(start, end) {
  const now = Date.now() / 1000;
  const s = Number(start),
    e = Number(end);
  if (now < s) return 0;
  if (now > e) return 100;
  return Math.round(((now - s) / (e - s)) * 100);
}

async function showEPGForStream(streamId) {
  const section = document.getElementById("epgSection");
  const content = document.getElementById("epgContent");
  if (!epgEnabled) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  content.innerHTML = '<div class="epgLoading">Chargement EPG...</div>';

  const data = await fetchEPG(streamId);
  if (!data || !data.length) {
    content.innerHTML = '<div class="epgLoading">Aucun programme</div>';
    return;
  }

  content.innerHTML = "";
  data.forEach((prog) => {
    const start = prog.start_timestamp || prog.start;
    const end = prog.stop_timestamp || prog.end || prog.stop;
    const title = decodeEPGTitle(prog.title) || prog.title || "Programme";
    const isCurrent = isCurrentProgram(start, end);

    const item = document.createElement("div");
    item.className = "epgItem";

    const time = document.createElement("div");
    time.className = `epgTime${isCurrent ? " now" : ""}`;
    time.textContent = `${formatEPGTime(start)} - ${formatEPGTime(end)}`;

    const titleEl = document.createElement("div");
    titleEl.className = "epgTitle";
    titleEl.textContent = title;

    if (isCurrent) {
      const badge = document.createElement("span");
      badge.className = "badge live";
      badge.textContent = "EN COURS";
      badge.style.marginLeft = "8px";
      badge.style.fontSize = "10px";
      titleEl.appendChild(badge);

      const progress = document.createElement("div");
      progress.className = "epgProgress";
      const bar = document.createElement("div");
      bar.className = "epgProgressBar";
      bar.style.width = `${calculateProgress(start, end)}%`;
      progress.appendChild(bar);
      titleEl.appendChild(progress);
    }

    item.appendChild(time);
    item.appendChild(titleEl);
    content.appendChild(item);
  });
}

function getCurrentEPGTitle(streamId) {
  const cached = epgCache[streamId];
  if (!cached?.data) return null;
  const now = Date.now() / 1000;
  const current = cached.data.find((p) => {
    const s = p.start_timestamp || p.start;
    const e = p.stop_timestamp || p.end || p.stop;
    return now >= Number(s) && now < Number(e);
  });
  return current ? decodeEPGTitle(current.title) || current.title : null;
}

/* ========================= M3U ========================= */
function parseM3U(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const items = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      const name = line.split(",").slice(1).join(",").trim();
      const attrs = {};
      for (const m of line.split(",")[0].matchAll(/(\w[\w-]*)="([^"]*)"/g))
        attrs[m[1]] = m[2];
      current = { name: name || "Sans nom", ...attrs, url: "" };
    } else if (!line.startsWith("#") && current) {
      current.url = line;
      items.push(current);
      current = null;
    }
  }
  return items;
}

function itemKeyM3U(ch) {
  return `m3u:${ch.url}`;
}

async function renderM3UPage(list) {
  setListMeta(list.length, filteredItems.length);
  const root = document.getElementById("list");
  root.innerHTML = "";

  for (const [idx, ch] of list.entries()) {
    const key = itemKeyM3U(ch);
    const row = document.createElement("div");
    row.className = "item";
    row.tabIndex = 0;
    row.dataset.idx = String(idx);

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const icon = ch["tvg-logo"] || ch.logo || "";

    if (icon && cacheEnabled) {
      getCachedImage(icon).then((src) => {
        const img = document.createElement("img");
        img.src = src;
        img.onerror = () => {
          thumb.textContent = "M3U";
        };
        thumb.innerHTML = "";
        thumb.appendChild(img);
      });
      thumb.textContent = "...";
    } else if (icon) {
      const img = document.createElement("img");
      img.src = icon;
      img.onerror = () => {
        thumb.textContent = "M3U";
      };
      thumb.appendChild(img);
    } else {
      thumb.textContent = "M3U";
    }

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = ch.name;
    const sub = document.createElement("div");
    sub.className = "sub";
    if (ch["group-title"]) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = ch["group-title"];
      sub.appendChild(b);
    }
    info.appendChild(name);
    info.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "actions";

    const playBtn = document.createElement("button");
    playBtn.textContent = "Lire";
    playBtn.onclick = () => {
      const resume = loadResume();
      currentSelectedItem = { key, type: "m3u", title: ch.name, url: ch.url };
      saveResume({
        key,
        type: "m3u",
        title: ch.name,
        url: ch.url,
        ts: resume?.key === key ? resume.ts : 0,
      });
      playMedia(ch.url, ch.name, resume?.key === key ? resume.ts : 0);
    };

    const favBtn = document.createElement("button");
    favBtn.textContent = isFav(key) ? "⭐" : "☆";
    favBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFav(key, { key, type: "m3u", title: ch.name, url: ch.url });
      favBtn.textContent = isFav(key) ? "⭐" : "☆";
      toast(
        isFav(key) ? "Ajouté aux favoris" : "Retiré",
        isFav(key) ? "⭐" : "☆"
      );
      if (favOnly) applyFiltersAndRender();
    };

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "📋";
    copyBtn.title = "Copier le lien";
    copyBtn.onclick = () => copyLink(ch.url);

    actions.appendChild(playBtn);
    actions.appendChild(favBtn);
    actions.appendChild(copyBtn);

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(actions);
    root.appendChild(row);

    row.addEventListener("focus", () => {
      markActiveRow(row);
      setDetails({
        title: ch.name,
        poster: icon,
        metaBadges: [ch["group-title"] || "M3U"],
      });
      currentStreamUrl = ch.url;
      document.getElementById("streamQuality").style.display = "block";
    });

    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") playBtn.click();
    });
  }

  updatePaginationUI();
}

async function loadM3UFromUrl(url) {
  channels = parseM3U(await ipcRenderer.invoke("m3u:loadUrl", url));
  applyFiltersAndRender();
}

/* ========================= XTREAM HELPERS ========================= */
function getCountry(item) {
  const match = (item.name || item.title || "").match(
    /^(?:\[[^\]]+\]\s*)?([A-Z]{2,3})\s*\|/
  );
  return match ? match[1] : "";
}

function stripPrefix(title) {
  return (title || "")
    .replace(/^\[[^\]]+\]\s*/g, "")
    .replace(/^[A-Z]{2,3}\s*\|\s*/g, "")
    .trim();
}

function getQualityLabel(item) {
  const raw = (item.name || item.title || "").trim();
  const bracket = raw.match(/^\[([^\]]+)\]/);
  if (bracket) return bracket[1].toUpperCase();
  const name = raw.toLowerCase();
  if (name.includes("4k") || name.includes("2160") || name.includes("uhd"))
    return "4K";
  if (name.includes("1080") || name.includes("fhd")) return "FHD";
  if (name.includes("720") || name.includes("hd")) return "HD";
  return (item.container_extension || "").toString().toUpperCase() || "";
}

function baseUrl(domain) {
  return (/^https?:\/\//i.test(domain) ? domain : `http://${domain}`).replace(
    /\/+$/,
    ""
  );
}

function buildLiveUrl({ domain, username, password, stream, format }) {
  if (stream.direct_source) return stream.direct_source;
  const id = stream.stream_id || stream.id;
  return `${baseUrl(domain)}/live/${encodeURIComponent(
    username
  )}/${encodeURIComponent(password)}/${id}.${format}`;
}

function buildVodUrl({ domain, username, password, vod }) {
  if (vod.direct_source) return vod.direct_source;
  const id = vod.stream_id || vod.id;
  const ext = (vod.container_extension || "m3u8").toString().toLowerCase();
  return `${baseUrl(domain)}/movie/${encodeURIComponent(
    username
  )}/${encodeURIComponent(password)}/${id}.${ext}`;
}

function buildEpisodeUrl({ domain, username, password, episode }) {
  if (episode.direct_source) return episode.direct_source;
  const id = episode.id || episode.stream_id;
  const ext = (episode.container_extension || "m3u8").toString().toLowerCase();
  return `${baseUrl(domain)}/series/${encodeURIComponent(
    username
  )}/${encodeURIComponent(password)}/${id}.${ext}`;
}

async function xtreamLoadByType(type) {
  if (!xtCreds) throw new Error("Non connecté");
  const hello = await ipcRenderer.invoke("xtream:handshake", xtCreds);
  if (!hello?.user_info) throw new Error("Authentification échouée");

  const cacheKey = `xtream_${type}_${xtCreds.domain}_${xtCreds.username}`;

  // Try cache first
  if (cacheEnabled) {
    const cached = await ipcRenderer.invoke("cache:getData", cacheKey);
    if (cached && !cached.expired) {
      toast("Chargé depuis le cache", "💾");
      return cached.data;
    }
  }

  let result;
  if (type === "live") {
    const cats = await ipcRenderer.invoke("xtream:getLiveCategories", xtCreds);
    const items = await ipcRenderer.invoke("xtream:getLiveStreams", xtCreds);
    result = { cats: cats || [], items: items || [] };
  } else if (type === "vod") {
    const cats = await ipcRenderer.invoke("xtream:getVodCategories", xtCreds);
    const items = await ipcRenderer.invoke("xtream:getVodStreams", xtCreds);
    result = { cats: cats || [], items: items || [] };
  } else if (type === "series") {
    const cats = await ipcRenderer.invoke(
      "xtream:getSeriesCategories",
      xtCreds
    );
    const items = await ipcRenderer.invoke("xtream:getSeries", xtCreds);
    result = { cats: cats || [], items: items || [] };
  } else {
    result = { cats: [], items: [] };
  }

  // Save to cache
  if (cacheEnabled) {
    await ipcRenderer.invoke("cache:setData", {
      key: cacheKey,
      data: result,
      maxAge: 30 * 60 * 1000,
    });
  }

  return result;
}

function fillCategories(cats) {
  const sel = document.getElementById("categories");
  const prev = sel.value;
  sel.innerHTML = '<option value="">Toutes</option>';
  cats.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.category_id;
    opt.textContent = c.category_name || `Cat ${c.category_id}`;
    sel.appendChild(opt);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function fillCountries(items) {
  const sel = document.getElementById("country");
  const prev = sel.value;
  const set = new Set();
  items.forEach((it) => {
    const c = getCountry(it);
    if (c) set.add(c);
  });
  sel.innerHTML = '<option value="">Tous</option>';
  Array.from(set)
    .sort()
    .forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

/* ========================= SERIES VIEW ========================= */
function normalizeEpisodes(info) {
  const eps = info?.episodes || {};
  const bySeason = {};
  for (const [s, arr] of Object.entries(eps))
    bySeason[s] = Array.isArray(arr) ? arr : [];
  return bySeason;
}

function episodeKey(seriesId, season, epId) {
  return `xt:ep:${seriesId}:${season}:${epId}`;
}

function renderSeriesSeasons(title, seriesId, episodes) {
  setListMeta(Object.keys(episodes).length);
  const root = document.getElementById("list");
  root.innerHTML = "";
  document.querySelector(".pagination").style.display = "none";

  const back = document.createElement("button");
  back.textContent = "← Retour";
  back.className = "btn btn-ghost";
  back.style.marginBottom = "10px";
  back.onclick = () => {
    viewMode = "list";
    currentSeries = null;
    document.querySelector(".pagination").style.display = "flex";
    applyFiltersAndRender();
  };
  root.appendChild(back);

  const h = document.createElement("div");
  h.style.cssText = "font-weight:bold;margin:10px 0;";
  h.textContent = title;
  root.appendChild(h);

  setDetails({ title, metaBadges: ["Série"], synopsis: "Choisir une saison" });

  Object.keys(episodes)
    .sort((a, b) => Number(a) - Number(b))
    .forEach((s, idx) => {
      const row = document.createElement("div");
      row.className = "item";
      row.tabIndex = 0;

      const thumb = document.createElement("div");
      thumb.className = "thumb";
      thumb.textContent = `S${s}`;

      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = `Saison ${s}`;
      const sub = document.createElement("div");
      sub.className = "sub";
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = `${episodes[s].length} épisodes`;
      sub.appendChild(b);
      info.appendChild(name);
      info.appendChild(sub);

      const actions = document.createElement("div");
      actions.className = "actions";
      const openBtn = document.createElement("button");
      openBtn.textContent = "Ouvrir";
      openBtn.onclick = () =>
        renderSeasonEpisodes(title, seriesId, s, episodes);
      actions.appendChild(openBtn);

      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(actions);
      root.appendChild(row);

      row.addEventListener("focus", () => {
        markActiveRow(row);
        setDetails({
          title: `${title} - Saison ${s}`,
          metaBadges: ["Série", `S${s}`],
        });
      });
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") openBtn.click();
      });
    });
}

function renderSeasonEpisodes(title, seriesId, season, episodes) {
  const root = document.getElementById("list");
  root.innerHTML = "";

  const back = document.createElement("button");
  back.textContent = "← Saisons";
  back.className = "btn btn-ghost";
  back.style.marginBottom = "10px";
  back.onclick = () => renderSeriesSeasons(title, seriesId, episodes);
  root.appendChild(back);

  const eps = episodes[season] || [];
  setListMeta(eps.length);

  eps.forEach((ep, idx) => {
    const epNum = ep.episode_num ?? ep.episode_number ?? idx + 1;
    const q = getQualityLabel(ep);
    const epId = ep.id || ep.stream_id || idx;
    const key = episodeKey(seriesId, season, epId);

    const row = document.createElement("div");
    row.className = "item";
    row.tabIndex = 0;

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.textContent = `E${epNum}`;

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `${q ? `[${q}] ` : ""}Épisode ${epNum}`;
    info.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "actions";

    const playBtn = document.createElement("button");
    playBtn.textContent = "Lire";
    playBtn.onclick = () => {
      const url = buildEpisodeUrl({ ...xtCreds, episode: ep });
      const resume = loadResume();
      const episodeTitle = `${title} S${season}E${epNum}`;
      currentSelectedItem = { key, type: "episode", title: episodeTitle, url };
      saveResume({
        key,
        type: "episode",
        title: episodeTitle,
        url,
        seriesId,
        season,
        episodeId: epId,
        ts: resume?.key === key ? resume.ts : 0,
      });
      playMedia(url, episodeTitle, resume?.key === key ? resume.ts : 0);
    };

    const favBtn = document.createElement("button");
    favBtn.textContent = isFav(key) ? "⭐" : "☆";
    favBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFav(key, {
        key,
        type: "episode",
        title: `${title} S${season}E${epNum}`,
      });
      favBtn.textContent = isFav(key) ? "⭐" : "☆";
    };

    actions.appendChild(playBtn);
    actions.appendChild(favBtn);

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(actions);
    root.appendChild(row);

    row.addEventListener("focus", () => {
      markActiveRow(row);
      setDetails({
        title: `${title} S${season}E${epNum}`,
        metaBadges: ["Épisode", `S${season}`, q].filter(Boolean),
      });
      currentStreamUrl = buildEpisodeUrl({ ...xtCreds, episode: ep });
      document.getElementById("streamQuality").style.display = "block";
    });
  });
}

/* ========================= XTREAM LIST ========================= */
function itemKeyXtream(item) {
  return `xt:${xtContentType}:${
    item.stream_id || item.series_id || item.id || ""
  }`;
}

function markActiveRow(row) {
  document
    .querySelectorAll("#list .item.is-active")
    .forEach((n) => n.classList.remove("is-active"));
  row.classList.add("is-active");
}

async function renderXtreamPage(items) {
  setListMeta(items.length, filteredItems.length);
  const root = document.getElementById("list");
  root.innerHTML = "";
  const format = document.getElementById("format")?.value || "ts";

  for (const [idx, item] of items.entries()) {
    const q = getQualityLabel(item);
    const rawTitle = item.name || item.title || "Sans nom";
    const cleanTitle = stripPrefix(rawTitle);
    const year = item.year || "";
    const country = getCountry(item);
    const poster = item.stream_icon || item.cover || item.cover_big || "";
    const streamId = item.stream_id || item.id;
    const key = itemKeyXtream(item);

    const row = document.createElement("div");
    row.className = "item";
    row.tabIndex = 0;
    row.dataset.streamId = streamId;

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.textContent = xtContentType.slice(0, 3).toUpperCase();

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `${q ? `[${q}] ` : ""}${cleanTitle}`;

    const sub = document.createElement("div");
    sub.className = "sub";
    if (country) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = country;
      sub.appendChild(b);
    }
    if (year) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = year;
      sub.appendChild(b);
    }
    if (xtContentType === "series") {
      const b = document.createElement("span");
      b.className = "badge accent";
      b.textContent = "Série";
      sub.appendChild(b);
    }

    info.appendChild(name);
    info.appendChild(sub);

    if (xtContentType === "live" && epgEnabled) {
      const epgNow = document.createElement("div");
      epgNow.className = "epg-now";
      epgNow.dataset.streamId = streamId;
      const cached = getCurrentEPGTitle(streamId);
      if (cached) epgNow.textContent = `📺 ${cached}`;
      info.appendChild(epgNow);
    }

    const actions = document.createElement("div");
    actions.className = "actions";

    const playBtn = document.createElement("button");
    playBtn.textContent = xtContentType === "series" ? "Ouvrir" : "Lire";
    playBtn.onclick = async () => {
      if (xtContentType === "series") {
        const seriesId = item.series_id || item.id;
        const info = await ipcRenderer.invoke("xtream:getSeriesInfo", {
          ...xtCreds,
          series_id: seriesId,
        });
        viewMode = "series";
        currentSeries = {
          title: cleanTitle,
          episodesBySeason: normalizeEpisodes(info),
          seriesId,
        };
        renderSeriesSeasons(
          cleanTitle,
          seriesId,
          currentSeries.episodesBySeason
        );
        return;
      }
      const url =
        xtContentType === "live"
          ? buildLiveUrl({ ...xtCreds, stream: item, format })
          : buildVodUrl({ ...xtCreds, vod: item });
      const resume = loadResume();
      currentSelectedItem = {
        key,
        type: xtContentType,
        title: cleanTitle,
        url,
      };
      saveResume({
        key,
        type: xtContentType,
        title: cleanTitle,
        url,
        ts: resume?.key === key ? resume.ts : 0,
      });
      playMedia(url, cleanTitle, resume?.key === key ? resume.ts : 0);
    };

    const favBtn = document.createElement("button");
    favBtn.textContent = isFav(key) ? "⭐" : "☆";
    favBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFav(key, {
        key,
        type: xtContentType,
        title: cleanTitle,
        poster,
        id: streamId,
      });
      favBtn.textContent = isFav(key) ? "⭐" : "☆";
      toast(isFav(key) ? "Ajouté" : "Retiré", isFav(key) ? "⭐" : "☆");
      if (favOnly) applyFiltersAndRender();
    };

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "📋";
    copyBtn.onclick = () => {
      if (xtContentType === "live")
        copyLink(buildLiveUrl({ ...xtCreds, stream: item, format }));
      else if (xtContentType === "vod")
        copyLink(buildVodUrl({ ...xtCreds, vod: item }));
    };

    actions.appendChild(playBtn);
    actions.appendChild(favBtn);
    actions.appendChild(copyBtn);

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(actions);
    root.appendChild(row);

    row.addEventListener("focus", () => {
      markActiveRow(row);
      currentSelectedItem = item;

      if (xtContentType === "live") {
        currentStreamUrl = buildLiveUrl({ ...xtCreds, stream: item, format });
      } else if (xtContentType === "vod") {
        currentStreamUrl = buildVodUrl({ ...xtCreds, vod: item });
      } else {
        currentStreamUrl = null;
      }

      setDetails({
        title: cleanTitle,
        poster,
        metaBadges: [
          xtContentType === "live"
            ? "Live"
            : xtContentType === "vod"
            ? "Film"
            : "Série",
          q,
          country,
          year,
        ].filter(Boolean),
        synopsis: item.plot || item.description || "",
      });

      if (xtContentType === "live" && epgEnabled) showEPGForStream(streamId);
      if (currentStreamUrl)
        document.getElementById("streamQuality").style.display = "block";
    });
  }

  updatePaginationUI();
  if (xtContentType === "live" && epgEnabled) prefetchEPG(items.slice(0, 10));
}

async function prefetchEPG(items) {
  for (const item of items) {
    const id = item.stream_id || item.id;
    if (!id || epgCache[id]) continue;
    await fetchEPG(id);
    const el = document.querySelector(`.epg-now[data-stream-id="${id}"]`);
    if (el) {
      const t = getCurrentEPGTitle(id);
      if (t) el.textContent = `📺 ${t}`;
    }
  }
}

/* ========================= MAIN RENDER ========================= */
function renderCurrentPage() {
  if (viewMode === "series" && currentSeries) {
    renderSeriesSeasons(
      currentSeries.title,
      currentSeries.seriesId,
      currentSeries.episodesBySeason
    );
    return;
  }
  const items = getPageItems();
  if (xtCreds) renderXtreamPage(items);
  else renderM3UPage(items);
}

function applyFiltersAndRender() {
  if (viewMode === "series" && currentSeries) {
    renderSeriesSeasons(
      currentSeries.title,
      currentSeries.seriesId,
      currentSeries.episodesBySeason
    );
    return;
  }

  const q = (document.getElementById("search")?.value || "")
    .toLowerCase()
    .trim();
  const favKeys = getFavKeysSet();

  if (xtCreds) {
    const catId = document.getElementById("categories")?.value || "";
    const country = document.getElementById("country")?.value || "";
    let list = xtItems;
    if (catId) list = list.filter((it) => String(it.category_id) === catId);
    if (country) list = list.filter((it) => getCountry(it) === country);
    if (q)
      list = list.filter((it) =>
        (it.name || it.title || "").toLowerCase().includes(q)
      );
    if (favOnly) list = list.filter((it) => favKeys.has(itemKeyXtream(it)));
    filteredItems = list;
  } else {
    let list = q
      ? channels.filter((c) => (c.name || "").toLowerCase().includes(q))
      : channels;
    if (favOnly) list = list.filter((c) => favKeys.has(itemKeyM3U(c)));
    filteredItems = list;
  }

  currentPage = 1;
  renderCurrentPage();
}

/* ========================= TV NAV ========================= */
function setupTvNav() {
  document.addEventListener("keydown", (e) => {
    const items = [...document.querySelectorAll("#list .item[tabindex='0']")];
    if (!items.length) return;
    const idx = items.findIndex((n) => n === document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[Math.min(items.length - 1, idx + 1)]?.focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      items[Math.max(0, idx - 1)]?.focus();
    }
    if (e.key === "PageDown") {
      e.preventDefault();
      goToPage(currentPage + 1);
    }
    if (e.key === "PageUp") {
      e.preventDefault();
      goToPage(currentPage - 1);
    }
  });
}

/* ========================= MODAL ========================= */
function openClearCacheModal() {
  document.getElementById("clearCacheModal").classList.add("show");
}
function closeClearCacheModal() {
  document.getElementById("clearCacheModal").classList.remove("show");
}

/* ========================= EVENTS ========================= */
window.addEventListener("DOMContentLoaded", () => {
  const saved = loadCreds();
  if (saved) {
    document.getElementById("xtDomain").value = saved.domain || "";
    document.getElementById("xtUser").value = saved.username || "";
    document.getElementById("xtPass").value = saved.password || "";
  }

  // Load player preference
  defaultPlayer = loadPlayerPref();
  const playerSelect = document.getElementById("defaultPlayer");
  if (playerSelect) {
    playerSelect.value = defaultPlayer;
    playerSelect.addEventListener("change", (e) => {
      defaultPlayer = e.target.value;
      savePlayerPref(defaultPlayer);
      toast(
        `Lecteur : ${defaultPlayer === "internal" ? "Intégré" : "VLC"}`,
        "🎬"
      );
    });
  }

  updateCacheStats();
  setupTvNav();
  setDetails({ title: "Bienvenue", synopsis: "Connectez-vous pour commencer" });

  // Feature toggles
  document.getElementById("toggleFavOnly")?.addEventListener("click", () => {
    favOnly = !favOnly;
    document.getElementById("toggleFavOnly").textContent = `⭐ Favoris : ${
      favOnly ? "ON" : "OFF"
    }`;
    applyFiltersAndRender();
  });

  document.getElementById("toggleEPG")?.addEventListener("click", () => {
    epgEnabled = !epgEnabled;
    document.getElementById("toggleEPG").textContent = `📺 EPG : ${
      epgEnabled ? "ON" : "OFF"
    }`;
    if (!epgEnabled)
      document.getElementById("epgSection").style.display = "none";
    applyFiltersAndRender();
  });

  document.getElementById("toggleCache")?.addEventListener("click", () => {
    cacheEnabled = !cacheEnabled;
    document.getElementById("toggleCache").textContent = `💾 Cache : ${
      cacheEnabled ? "ON" : "OFF"
    }`;
    toast(`Cache ${cacheEnabled ? "activé" : "désactivé"}`, "💾");
  });

  // Pagination
  document
    .getElementById("pageFirst")
    ?.addEventListener("click", () => goToPage(1));
  document
    .getElementById("pagePrev")
    ?.addEventListener("click", () => goToPage(currentPage - 1));
  document
    .getElementById("pageNext")
    ?.addEventListener("click", () => goToPage(currentPage + 1));
  document
    .getElementById("pageLast")
    ?.addEventListener("click", () => goToPage(getTotalPages()));
  document
    .getElementById("pageSelect")
    ?.addEventListener("change", (e) => goToPage(parseInt(e.target.value)));
  document.getElementById("perPage")?.addEventListener("change", (e) => {
    itemsPerPage = parseInt(e.target.value) || 50;
    currentPage = 1;
    renderCurrentPage();
  });

  // Cache controls
  document
    .getElementById("preloadImages")
    ?.addEventListener("click", preloadVisibleImages);
  document
    .getElementById("clearCache")
    ?.addEventListener("click", openClearCacheModal);

  document
    .getElementById("clearImages")
    ?.addEventListener("click", async () => {
      await ipcRenderer.invoke("cache:clear", "images");
      closeClearCacheModal();
      updateCacheStats();
      toast("Images supprimées", "🗑️");
    });

  document.getElementById("clearData")?.addEventListener("click", async () => {
    await ipcRenderer.invoke("cache:clear", "data");
    closeClearCacheModal();
    updateCacheStats();
    toast("Données supprimées", "🗑️");
  });

  document.getElementById("clearAll")?.addEventListener("click", async () => {
    await ipcRenderer.invoke("cache:clear", "all");
    closeClearCacheModal();
    updateCacheStats();
    toast("Cache vidé", "🗑️");
  });

  // Network indicator
  document
    .getElementById("networkIndicator")
    ?.addEventListener("click", checkNetworkQuality);

  // Stream test
  document
    .getElementById("testStream")
    ?.addEventListener("click", testCurrentStream);

  // Filters
  document
    .getElementById("search")
    ?.addEventListener("input", applyFiltersAndRender);
  document
    .getElementById("categories")
    ?.addEventListener("change", applyFiltersAndRender);
  document
    .getElementById("country")
    ?.addEventListener("change", applyFiltersAndRender);
  document
    .getElementById("format")
    ?.addEventListener("change", applyFiltersAndRender);

  // Xtream
  document.getElementById("xtForget")?.addEventListener("click", () => {
    clearCreds();
    document.getElementById("xtPass").value = "";
    toast("Identifiants supprimés", "🗑️");
  });

  document.getElementById("xtLoad")?.addEventListener("click", async () => {
    const domain = document.getElementById("xtDomain")?.value.trim();
    const username = document.getElementById("xtUser")?.value.trim();
    const password = document.getElementById("xtPass")?.value.trim();
    if (!domain || !username || !password)
      return alert("Remplissez tous les champs");

    try {
      xtCreds = { domain, username, password };
      saveCreds(xtCreds);
      viewMode = "list";
      currentSeries = null;
      document.querySelector(".pagination").style.display = "flex";

      const { cats, items } = await xtreamLoadByType(xtContentType);
      xtCats = cats;
      xtItems = items;
      fillCategories(xtCats);
      fillCountries(xtItems);
      applyFiltersAndRender();
      toast(`${items.length} éléments chargés`, "✓");

      checkNetworkQuality();
      updateCacheStats();
    } catch (e) {
      alert("Erreur: " + e.message);
    }
  });

  document
    .getElementById("contentType")
    ?.addEventListener("change", async (e) => {
      xtContentType = e.target.value;
      if (!xtCreds) return;

      try {
        viewMode = "list";
        currentSeries = null;
        document.querySelector(".pagination").style.display = "flex";

        const { cats, items } = await xtreamLoadByType(xtContentType);
        xtCats = cats;
        xtItems = items;
        document.getElementById("categories").value = "";
        document.getElementById("country").value = "";
        fillCategories(xtCats);
        fillCountries(xtItems);
        applyFiltersAndRender();
        toast(`${items.length} ${xtContentType} chargés`, "✓");
      } catch (e) {
        alert("Erreur: " + e.message);
      }
    });

  // M3U
  document.getElementById("loadUrl")?.addEventListener("click", async () => {
    const url = document.getElementById("m3uUrl")?.value.trim();
    if (!url) return alert("Entrez une URL M3U");
    try {
      xtCreds = null;
      viewMode = "list";
      document.querySelector(".pagination").style.display = "flex";
      await loadM3UFromUrl(url);
      toast("M3U chargé", "✓");
    } catch (e) {
      alert("Erreur: " + e.message);
    }
  });

  document.getElementById("file")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    xtCreds = null;
    viewMode = "list";
    document.querySelector(".pagination").style.display = "flex";
    channels = parseM3U(fs.readFileSync(file.path, "utf-8"));
    applyFiltersAndRender();
    toast("Fichier chargé", "✓");
  });
});
