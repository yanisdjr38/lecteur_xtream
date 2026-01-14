/*************************************************
 * renderer.js
 * + Panneau détails (jaquette/stream_icon, synopsis, année, durée)
 * + Focus item -> détails à droite
 * + Favoris ⭐ (localStorage) + filtre Favoris
 * + Reprendre: mémoriser dernier item/episode + timestamp (partiel)
 * + Navigation TV (↑ ↓ ← →, OK/Enter, Back/Escape)
 * + EPG (Guide des programmes) pour chaînes Live
 * + Pagination pour naviguer dans les listes volumineuses
 *************************************************/

const { execFile } = require("child_process");
const fs = require("fs");
const { ipcRenderer, clipboard } = require("electron");

/* =========================
   STATE
========================= */
let channels = [];
let xtCreds = null;
let xtContentType = "live";
let xtCats = [];
let xtItems = [];
const STORAGE_KEY = "xtream_creds_v1";

let viewMode = "list";
let currentSeries = null;

/* =========================
   PAGINATION STATE
========================= */
let currentPage = 1;
let itemsPerPage = 50;
let filteredItems = [];

/* =========================
   EPG STATE
========================= */
let epgEnabled = true;
let epgCache = {};
const EPG_CACHE_DURATION = 5 * 60 * 1000;

/* =========================
   FAVORIS + REPRISE
========================= */
const FAV_KEY = "iptv_favs_v1";
const RESUME_KEY = "iptv_resume_v1";
let favOnly = false;

function loadFavs() {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY)) || {};
  } catch { return {}; }
}
function saveFavs(map) { localStorage.setItem(FAV_KEY, JSON.stringify(map)); }
function isFav(key) { return !!loadFavs()[key]; }
function toggleFav(key, payload) {
  const map = loadFavs();
  if (map[key]) delete map[key];
  else map[key] = payload || { key, addedAt: Date.now() };
  saveFavs(map);
}
function getFavKeysSet() { return new Set(Object.keys(loadFavs())); }
function loadResume() {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY)); } catch { return null; }
}
function saveResume(obj) { localStorage.setItem(RESUME_KEY, JSON.stringify(obj)); }

/* =========================
   UTIL
========================= */
function copyLink(url) { clipboard.writeText(url); toast("Lien copié."); }

function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 1400);
}

function playInVLC(url, startTimeSeconds = 0) {
  const args = ["--network-caching=3000", "--file-caching=3000", "--live-caching=3000"];
  if (startTimeSeconds && Number(startTimeSeconds) > 0) {
    args.push(`--start-time=${Math.floor(Number(startTimeSeconds))}`);
  }
  args.push(url);
  execFile("vlc", args, (err) => { if (err) alert("Erreur VLC: " + err.message); });
}

function saveCreds(creds) { localStorage.setItem(STORAGE_KEY, JSON.stringify(creds)); }
function loadCreds() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function clearCreds() { localStorage.removeItem(STORAGE_KEY); }

function setListMeta(count, total = null) {
  const el = document.getElementById("listMeta");
  if (!el) return;
  el.textContent = total !== null && total !== count 
    ? `${count} affichés / ${total} total` 
    : `${count} élément${count > 1 ? "s" : ""}`;
}

/* =========================
   PAGINATION
========================= */
function getTotalPages() { return Math.max(1, Math.ceil(filteredItems.length / itemsPerPage)); }
function getPageItems() {
  const start = (currentPage - 1) * itemsPerPage;
  return filteredItems.slice(start, start + itemsPerPage);
}

function updatePaginationUI() {
  const totalPages = getTotalPages();
  const pageInfo = document.getElementById("pageInfo");
  const pageSelect = document.getElementById("pageSelect");
  
  if (pageInfo) pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
  
  if (pageSelect) {
    pageSelect.innerHTML = "";
    for (let i = 1; i <= totalPages; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `${i}`;
      if (i === currentPage) opt.selected = true;
      pageSelect.appendChild(opt);
    }
  }
  
  const first = document.getElementById("pageFirst");
  const prev = document.getElementById("pagePrev");
  const next = document.getElementById("pageNext");
  const last = document.getElementById("pageLast");
  
  if (first) first.disabled = currentPage <= 1;
  if (prev) prev.disabled = currentPage <= 1;
  if (next) next.disabled = currentPage >= totalPages;
  if (last) last.disabled = currentPage >= totalPages;
}

function goToPage(page) {
  const newPage = Math.max(1, Math.min(getTotalPages(), page));
  if (newPage !== currentPage) {
    currentPage = newPage;
    renderCurrentPage();
  }
}

/* =========================
   DETAILS PANEL
========================= */
function setDetails({ title, poster, metaBadges = [], synopsis = "" } = {}) {
  const titleEl = document.getElementById("detailsTitle");
  const posterEl = document.getElementById("detailsPoster");
  const metaEl = document.getElementById("detailsMeta");
  const synEl = document.getElementById("detailsSynopsis");

  if (titleEl) titleEl.textContent = title || "Détails";
  if (posterEl) {
    posterEl.innerHTML = "";
    if (poster) {
      const img = document.createElement("img");
      img.src = poster;
      img.alt = title || "Poster";
      posterEl.appendChild(img);
    } else {
      posterEl.textContent = "Aucune jaquette";
    }
  }
  if (metaEl) {
    metaEl.innerHTML = "";
    metaBadges.forEach((t) => {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = t;
      metaEl.appendChild(b);
    });
  }
  if (synEl) synEl.textContent = synopsis || "";
  
  const epgSection = document.getElementById("epgSection");
  if (epgSection) epgSection.style.display = "none";
}

function secondsToHhMm(total) {
  const s = Number(total);
  if (!Number.isFinite(s) || s <= 0) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

/* =========================
   EPG FUNCTIONS
========================= */
async function fetchEPG(streamId) {
  if (!xtCreds || !streamId) return null;
  
  const cached = epgCache[streamId];
  if (cached && (Date.now() - cached.fetchedAt) < EPG_CACHE_DURATION) return cached.data;
  
  try {
    const result = await ipcRenderer.invoke("xtream:getShortEPG", {
      ...xtCreds, stream_id: streamId, limit: 5
    });
    const epgData = result?.epg_listings || [];
    epgCache[streamId] = { data: epgData, fetchedAt: Date.now() };
    return epgData;
  } catch (err) {
    console.warn("EPG fetch error:", err.message);
    return null;
  }
}

function formatEPGTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function decodeEPGTitle(title) {
  if (!title) return "";
  try { return atob(title); } catch { return title; }
}

function calculateProgress(start, end) {
  const now = Date.now() / 1000;
  const startTs = Number(start), endTs = Number(end);
  if (now < startTs) return 0;
  if (now > endTs) return 100;
  return Math.round(((now - startTs) / (endTs - startTs)) * 100);
}

function isCurrentProgram(start, end) {
  const now = Date.now() / 1000;
  return now >= Number(start) && now < Number(end);
}

async function showEPGForStream(streamId) {
  const epgSection = document.getElementById("epgSection");
  const epgContent = document.getElementById("epgContent");
  
  if (!epgSection || !epgContent || !epgEnabled) {
    if (epgSection) epgSection.style.display = "none";
    return;
  }
  
  epgSection.style.display = "block";
  epgContent.innerHTML = '<div class="epgLoading">Chargement EPG...</div>';
  
  const epgData = await fetchEPG(streamId);
  
  if (!epgData || epgData.length === 0) {
    epgContent.innerHTML = '<div class="epgLoading">Aucun programme disponible</div>';
    return;
  }
  
  epgContent.innerHTML = "";
  
  epgData.forEach((prog) => {
    const startTs = prog.start_timestamp || prog.start;
    const endTs = prog.stop_timestamp || prog.end || prog.stop;
    const title = decodeEPGTitle(prog.title) || prog.title || "Programme inconnu";
    const isCurrent = isCurrentProgram(startTs, endTs);
    const progress = isCurrent ? calculateProgress(startTs, endTs) : 0;
    
    const item = document.createElement("div");
    item.className = "epgItem";
    
    const timeEl = document.createElement("div");
    timeEl.className = `epgTime${isCurrent ? " now" : ""}`;
    timeEl.textContent = `${formatEPGTime(startTs)} - ${formatEPGTime(endTs)}`;
    
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
      
      const progressDiv = document.createElement("div");
      progressDiv.className = "epgProgress";
      const progressBar = document.createElement("div");
      progressBar.className = "epgProgressBar";
      progressBar.style.width = `${progress}%`;
      progressDiv.appendChild(progressBar);
      titleEl.appendChild(progressDiv);
    }
    
    item.appendChild(timeEl);
    item.appendChild(titleEl);
    epgContent.appendChild(item);
  });
}

function getCurrentEPGTitle(streamId) {
  const cached = epgCache[streamId];
  if (!cached || !cached.data) return null;
  
  const now = Date.now() / 1000;
  const current = cached.data.find(prog => {
    const start = prog.start_timestamp || prog.start;
    const end = prog.stop_timestamp || prog.end || prog.stop;
    return now >= Number(start) && now < Number(end);
  });
  
  return current ? (decodeEPGTitle(current.title) || current.title) : null;
}

/* =========================
   M3U
========================= */
function parseM3U(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      const nameMatch = line.split(",").slice(1).join(",").trim();
      const attrs = {};
      const attrPart = line.split(",")[0];
      for (const m of attrPart.matchAll(/(\w[\w-]*)="([^"]*)"/g)) attrs[m[1]] = m[2];
      current = { name: nameMatch || "Sans nom", ...attrs, url: "" };
    } else if (!line.startsWith("#") && current) {
      current.url = line;
      items.push(current);
      current = null;
    }
  }
  return items;
}

function itemKeyM3U(ch) { return `m3u:${ch.url}`; }

function renderM3UPage(list) {
  setListMeta(list.length, filteredItems.length);
  const root = document.getElementById("list");
  root.innerHTML = "";

  list.forEach((ch, idx) => {
    const key = itemKeyM3U(ch);
    const globalIdx = (currentPage - 1) * itemsPerPage + idx;

    const row = document.createElement("div");
    row.className = "item";
    row.tabIndex = 0;
    row.dataset.idx = String(globalIdx);

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const icon = ch["tvg-logo"] || ch.logo || "";
    if (icon) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = icon;
      img.onerror = () => { thumb.textContent = "M3U"; };
      thumb.appendChild(img);
    } else {
      thumb.textContent = "M3U";
    }

    const info = document.createElement("div");
    info.className = "info";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `${ch["group-title"] ? `[${ch["group-title"]}] ` : ""}${ch.name}`;

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
      const start = resume?.key === key ? resume.ts || 0 : 0;
      saveResume({ key, type: "m3u", title: ch.name, url: ch.url, ts: start });
      playInVLC(ch.url, start);
    };

    const favBtn = document.createElement("button");
    favBtn.textContent = isFav(key) ? "⭐" : "☆";
    favBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFav(key, { key, type: "m3u", title: ch.name, url: ch.url });
      favBtn.textContent = isFav(key) ? "⭐" : "☆";
      toast(isFav(key) ? "Ajouté aux favoris" : "Retiré des favoris");
      if (favOnly) applyFiltersAndRender();
    };

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copier";
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
      setDetails({ title: ch.name, poster: icon, metaBadges: [ch["group-title"] || "M3U"], synopsis: "" });
    });

    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") playBtn.click();
      if (ev.key === "Backspace" || ev.key === "Escape") document.getElementById("search")?.focus();
    });
  });
  
  updatePaginationUI();
}

async function loadM3UFromUrl(url) {
  const text = await ipcRenderer.invoke("m3u:loadUrl", url);
  channels = parseM3U(text);
  applyFiltersAndRender();
}

/* =========================
   XTREAM HELPERS
========================= */
function getCountry(item) {
  const s = (item.name || item.title || "").trim();
  const match = s.match(/^(?:\[[^\]]+\]\s*)?([A-Z]{2,3})\s*\|/);
  return match ? match[1] : "";
}

function stripCountryAndQualityPrefix(title) {
  return (title || "").replace(/^\[[^\]]+\]\s*/g, "").replace(/^[A-Z]{2,3}\s*\|\s*/g, "").trim();
}

function getQualityLabel(item) {
  const raw = (item.name || item.title || "").trim();
  const bracket = raw.match(/^\[([^\]]+)\]/);
  if (bracket) return bracket[1].trim().toUpperCase();
  const name = raw.toLowerCase();
  if (name.includes("2160") || name.includes("4k") || name.includes("uhd")) return "4K";
  if (name.includes("1080") || name.includes("fhd")) return "FHD";
  if (name.includes("720") || name.includes("hd")) return "HD";
  const ext = (item.container_extension || "").toString().trim();
  return ext ? ext.toUpperCase() : "";
}

function baseUrl(domain) {
  return (/^https?:\/\//i.test(domain) ? domain : `http://${domain}`).replace(/\/+$/, "");
}

function buildLiveUrl({ domain, username, password, stream, format }) {
  if (stream.direct_source) return stream.direct_source;
  const id = stream.stream_id || stream.id;
  if (!id) throw new Error("stream_id manquant");
  return `${baseUrl(domain)}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${format}`;
}

function getVodExtension(vod) {
  return (vod.container_extension || vod.ext || "").toString().trim().toLowerCase() || "m3u8";
}

function buildVodUrl({ domain, username, password, vod }) {
  if (vod.direct_source) return vod.direct_source;
  const id = vod.stream_id || vod.id;
  if (!id) throw new Error("VOD id manquant");
  return `${baseUrl(domain)}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${getVodExtension(vod)}`;
}

function buildEpisodeUrl({ domain, username, password, episode }) {
  if (episode.direct_source) return episode.direct_source;
  const id = episode.id || episode.stream_id;
  if (!id) throw new Error("episode id manquant");
  const ext = (episode.container_extension || "m3u8").toString().trim().toLowerCase();
  return `${baseUrl(domain)}/series/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.${ext}`;
}

async function xtreamLoadByType(type) {
  if (!xtCreds) throw new Error("Xtream: credentials manquants");
  const hello = await ipcRenderer.invoke("xtream:handshake", xtCreds);
  if (!hello?.user_info) throw new Error("Xtream invalide");

  if (type === "live") {
    const cats = await ipcRenderer.invoke("xtream:getLiveCategories", xtCreds);
    const items = await ipcRenderer.invoke("xtream:getLiveStreams", xtCreds);
    return { cats: cats || [], items: items || [] };
  }
  if (type === "vod") {
    const cats = await ipcRenderer.invoke("xtream:getVodCategories", xtCreds);
    const items = await ipcRenderer.invoke("xtream:getVodStreams", xtCreds);
    return { cats: cats || [], items: items || [] };
  }
  if (type === "series") {
    const cats = await ipcRenderer.invoke("xtream:getSeriesCategories", xtCreds);
    const items = await ipcRenderer.invoke("xtream:getSeries", xtCreds);
    return { cats: cats || [], items: items || [] };
  }
  return { cats: [], items: [] };
}

function fillCategories(cats) {
  const sel = document.getElementById("categories");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">Toutes les catégories</option>`;
  cats.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = String(c.category_id);
    opt.textContent = c.category_name || `Catégorie ${c.category_id}`;
    sel.appendChild(opt);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function fillCountries(items) {
  const sel = document.getElementById("country");
  if (!sel) return;
  const prev = sel.value;
  const set = new Set();
  items.forEach((it) => { const c = getCountry(it); if (c) set.add(c); });
  sel.innerHTML = `<option value="">Tous les pays</option>`;
  Array.from(set).sort().forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

/* =========================
   SERIES VIEW
========================= */
function normalizeEpisodes(info) {
  const eps = info?.episodes || {};
  const bySeason = {};
  for (const [season, arr] of Object.entries(eps)) bySeason[season] = Array.isArray(arr) ? arr : [];
  return bySeason;
}

function episodeKey(seriesId, season, episodeId) { return `xt:ep:${seriesId}:${season}:${episodeId}`; }

function renderSeriesSeasons(seriesTitle, seriesId, episodesBySeason) {
  setListMeta(Object.keys(episodesBySeason).length);
  const root = document.getElementById("list");
  root.innerHTML = "";
  document.querySelector(".pagination").style.display = "none";

  const back = document.createElement("button");
  back.textContent = "← Retour à la liste";
  back.onclick = () => {
    viewMode = "list";
    currentSeries = null;
    document.querySelector(".pagination").style.display = "flex";
    applyFiltersAndRender();
  };
  root.appendChild(back);

  const title = document.createElement("div");
  title.style.margin = "10px 0";
  title.style.fontWeight = "bold";
  title.textContent = seriesTitle;
  root.appendChild(title);

  setDetails({ title: seriesTitle, poster: "", metaBadges: ["Série"], synopsis: "Choisis une saison." });

  Object.keys(episodesBySeason).sort((a, b) => Number(a) - Number(b)).forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "item";
    row.tabIndex = 0;
    row.dataset.idx = String(idx);

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
    b.textContent = `${episodesBySeason[s].length} épisodes`;
    sub.appendChild(b);
    info.appendChild(name);
    info.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "actions";
    const openBtn = document.createElement("button");
    openBtn.textContent = "Ouvrir";
    openBtn.onclick = () => renderSeasonEpisodes(seriesTitle, seriesId, s, episodesBySeason);
    actions.appendChild(openBtn);

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(actions);
    root.appendChild(row);

    row.addEventListener("focus", () => {
      markActiveRow(row);
      setDetails({ title: `${seriesTitle} — Saison ${s}`, poster: "", metaBadges: ["Série", `Saison ${s}`] });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") openBtn.click();
      if (ev.key === "Backspace" || ev.key === "Escape") back.click();
    });
  });

  setTimeout(() => root.querySelector(".item")?.focus(), 0);
}

function renderSeasonEpisodes(seriesTitle, seriesId, seasonNumber, episodesBySeason) {
  const root = document.getElementById("list");
  root.innerHTML = "";

  const back = document.createElement("button");
  back.textContent = "← Retour aux saisons";
  back.onclick = () => renderSeriesSeasons(seriesTitle, seriesId, episodesBySeason);
  root.appendChild(back);

  const title = document.createElement("div");
  title.style.margin = "10px 0";
  title.textContent = `${seriesTitle} — Saison ${seasonNumber}`;
  root.appendChild(title);

  const episodes = episodesBySeason[seasonNumber] || [];
  setListMeta(episodes.length);
  setDetails({ title: `${seriesTitle} — Saison ${seasonNumber}`, poster: "", metaBadges: ["Série", `Saison ${seasonNumber}`], synopsis: "Choisis un épisode." });

  episodes.forEach((ep, idx) => {
    const epNum = ep.episode_num ?? ep.episode_number ?? ep.num ?? "";
    const q = getQualityLabel(ep);
    const epId = ep.id || ep.stream_id || `${idx}`;
    const key = episodeKey(seriesId, seasonNumber, epId);

    const row = document.createElement("div");
    row.className = "item";
    row.tabIndex = 0;
    row.dataset.idx = String(idx);

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.textContent = `E${epNum}`;

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `${q ? `[${q}] ` : ""}Épisode ${epNum}`.trim();
    const sub = document.createElement("div");
    sub.className = "sub";
    const b1 = document.createElement("span");
    b1.className = "badge";
    b1.textContent = `S${seasonNumber}`;
    sub.appendChild(b1);
    info.appendChild(name);
    info.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "actions";

    const playBtn = document.createElement("button");
    playBtn.textContent = "Lire";
    playBtn.onclick = () => {
      try {
        const url = buildEpisodeUrl({ ...xtCreds, episode: ep });
        const resume = loadResume();
        const start = resume?.key === key ? resume.ts || 0 : 0;
        saveResume({ key, type: "episode", title: `${seriesTitle} S${seasonNumber}E${epNum}`, url, seriesId, season: seasonNumber, episodeId: epId, ts: start });
        playInVLC(url, start);
      } catch (e) { alert(e.message); }
    };

    const favBtn = document.createElement("button");
    favBtn.textContent = isFav(key) ? "⭐" : "☆";
    favBtn.onclick = (e) => {
      e.stopPropagation();
      try {
        const url = buildEpisodeUrl({ ...xtCreds, episode: ep });
        toggleFav(key, { key, type: "episode", title: `${seriesTitle} S${seasonNumber}E${epNum}`, url, seriesId, season: seasonNumber, episodeId: epId });
        favBtn.textContent = isFav(key) ? "⭐" : "☆";
        toast(isFav(key) ? "Ajouté aux favoris" : "Retiré des favoris");
      } catch (err) { alert(err.message); }
    };

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copier";
    copyBtn.onclick = () => {
      try { copyLink(buildEpisodeUrl({ ...xtCreds, episode: ep })); } catch (e) { alert(e.message); }
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
      setDetails({ title: `${seriesTitle} — S${seasonNumber}E${epNum}`, poster: "", metaBadges: ["Épisode", `S${seasonNumber}`, q].filter(Boolean) });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") playBtn.click();
      if (ev.key === "Backspace" || ev.key === "Escape") back.click();
    });
  });

  setTimeout(() => root.querySelector(".item")?.focus(), 0);
}

/* =========================
   XTREAM LIST RENDER
========================= */
function itemKeyXtream(item) {
  return `xt:${xtContentType}:${item.stream_id || item.series_id || item.id || ""}`;
}

function markActiveRow(row) {
  const root = document.getElementById("list");
  if (!root) return;
  root.querySelectorAll(".item.is-active").forEach((n) => n.classList.remove("is-active"));
  row.classList.add("is-active");
}

function renderXtreamPage(items) {
  setListMeta(items.length, filteredItems.length);
  const root = document.getElementById("list");
  root.innerHTML = "";

  const format = document.getElementById("format")?.value || "ts";

  items.forEach((item, idx) => {
    const q = getQualityLabel(item);
    const rawTitle = item.name || item.title || "Sans nom";
    const cleanTitle = stripCountryAndQualityPrefix(rawTitle);
    const year = item.year || item.releaseDate || item.release_date || "";
    const duration = item.duration_secs || item.duration || item.runtime || "";
    const durationLabel = typeof duration === "number" ? secondsToHhMm(duration) : "";
    const country = getCountry(item);
    const poster = item.stream_icon || item.cover || item.cover_big || item.movie_image || "";
    const streamId = item.stream_id || item.id;
    const key = itemKeyXtream(item);
    const globalIdx = (currentPage - 1) * itemsPerPage + idx;

    const row = document.createElement("div");
    row.className = "item";
    row.tabIndex = 0;
    row.dataset.idx = String(globalIdx);
    row.dataset.streamId = streamId || "";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.textContent = xtContentType.toUpperCase().slice(0, 3);

    const info = document.createElement("div");
    info.className = "info";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `${q ? `[${q}] ` : ""}${cleanTitle}`;

    const sub = document.createElement("div");
    sub.className = "sub";
    if (country) { const b = document.createElement("span"); b.className = "badge"; b.textContent = country; sub.appendChild(b); }
    if (year) { const b = document.createElement("span"); b.className = "badge"; b.textContent = String(year); sub.appendChild(b); }
    if (durationLabel) { const b = document.createElement("span"); b.className = "badge"; b.textContent = durationLabel; sub.appendChild(b); }
    if (xtContentType === "series") { const b = document.createElement("span"); b.className = "badge accent"; b.textContent = "Séries"; sub.appendChild(b); }

    info.appendChild(name);
    info.appendChild(sub);

    // EPG info for live
    if (xtContentType === "live" && epgEnabled && streamId) {
      const epgNow = document.createElement("div");
      epgNow.className = "epg-now";
      epgNow.dataset.streamId = streamId;
      const cachedTitle = getCurrentEPGTitle(streamId);
      if (cachedTitle) epgNow.textContent = `📺 ${cachedTitle}`;
      info.appendChild(epgNow);
    }

    const actions = document.createElement("div");
    actions.className = "actions";

    const playBtn = document.createElement("button");
    playBtn.textContent = xtContentType === "series" ? "Ouvrir" : "Lire";
    playBtn.onclick = async () => {
      try {
        if (xtContentType === "series") {
          const seriesId = item.series_id || item.id;
          const info = await ipcRenderer.invoke("xtream:getSeriesInfo", { ...xtCreds, series_id: seriesId });
          const title = stripCountryAndQualityPrefix(rawTitle) || "Série";
          viewMode = "series";
          currentSeries = { title, episodesBySeason: normalizeEpisodes(info), seriesId };
          renderSeriesSeasons(title, seriesId, currentSeries.episodesBySeason);
          return;
        }
        let url = "";
        if (xtContentType === "live") url = buildLiveUrl({ ...xtCreds, stream: item, format });
        else if (xtContentType === "vod") url = buildVodUrl({ ...xtCreds, vod: item });
        const resume = loadResume();
        const start = resume?.key === key ? (resume.ts || 0) : 0;
        saveResume({ key, type: xtContentType, title: cleanTitle, url, ts: start });
        playInVLC(url, start);
      } catch (e) { alert(e.message); }
    };

    const favBtn = document.createElement("button");
    favBtn.textContent = isFav(key) ? "⭐" : "☆";
    favBtn.onclick = (e) => {
      e.stopPropagation();
      toggleFav(key, { key, type: xtContentType, title: cleanTitle, poster, id: streamId });
      favBtn.textContent = isFav(key) ? "⭐" : "☆";
      toast(isFav(key) ? "Ajouté aux favoris" : "Retiré des favoris");
      if (favOnly) applyFiltersAndRender();
    };

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copier";
    copyBtn.onclick = () => {
      try {
        if (xtContentType === "live") copyLink(buildLiveUrl({ ...xtCreds, stream: item, format }));
        else if (xtContentType === "vod") copyLink(buildVodUrl({ ...xtCreds, vod: item }));
        else alert("Choisis un épisode pour copier.");
      } catch (e) { alert(e.message); }
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
      setDetails({
        title: cleanTitle,
        poster,
        metaBadges: [xtContentType === "live" ? "Live" : xtContentType === "vod" ? "Film" : "Série", q, country, year ? String(year) : "", durationLabel].filter(Boolean),
        synopsis: item.plot || item.description || item.info || "",
      });
      if (xtContentType === "live" && streamId && epgEnabled) showEPGForStream(streamId);
    });

    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") playBtn.click();
      if (ev.key === "Backspace" || ev.key === "Escape") document.getElementById("search")?.focus();
    });
  });

  updatePaginationUI();
  if (xtContentType === "live" && epgEnabled) prefetchEPGForVisibleItems(items);
  setTimeout(() => root.querySelector(".item")?.focus(), 0);
}

async function prefetchEPGForVisibleItems(items) {
  const toFetch = items.slice(0, 10).filter(item => {
    const streamId = item.stream_id || item.id;
    if (!streamId) return false;
    const cached = epgCache[streamId];
    return !cached || (Date.now() - cached.fetchedAt) >= EPG_CACHE_DURATION;
  });
  
  for (const item of toFetch) {
    const streamId = item.stream_id || item.id;
    await fetchEPG(streamId);
    const epgEl = document.querySelector(`.epg-now[data-stream-id="${streamId}"]`);
    if (epgEl) {
      const title = getCurrentEPGTitle(streamId);
      if (title) epgEl.textContent = `📺 ${title}`;
    }
  }
}

/* =========================
   MAIN RENDER
========================= */
function renderCurrentPage() {
  if (viewMode === "series" && currentSeries) {
    renderSeriesSeasons(currentSeries.title, currentSeries.seriesId, currentSeries.episodesBySeason);
    return;
  }
  const pageItems = getPageItems();
  if (xtCreds) renderXtreamPage(pageItems);
  else renderM3UPage(pageItems);
}

function applyFiltersAndRender() {
  if (viewMode === "series" && currentSeries) {
    renderSeriesSeasons(currentSeries.title, currentSeries.seriesId, currentSeries.episodesBySeason);
    return;
  }

  const q = (document.getElementById("search")?.value || "").toLowerCase().trim();
  const favKeys = getFavKeysSet();

  if (xtCreds) {
    const catId = document.getElementById("categories")?.value || "";
    const country = document.getElementById("country")?.value || "";

    let list = xtItems;
    if (catId) list = list.filter((it) => String(it.category_id) === String(catId));
    if (country) list = list.filter((it) => getCountry(it) === country);
    if (q) list = list.filter((it) => (it.name || it.title || "").toLowerCase().includes(q));
    if (favOnly) list = list.filter((it) => favKeys.has(itemKeyXtream(it)));

    filteredItems = list;
  } else {
    let list = !q ? channels : channels.filter((c) => (c.name || "").toLowerCase().includes(q));
    if (favOnly) list = list.filter((c) => favKeys.has(itemKeyM3U(c)));
    filteredItems = list;
  }

  currentPage = 1;
  renderCurrentPage();
}

/* =========================
   TV NAV
========================= */
function setupTvNav() {
  document.addEventListener("keydown", (e) => {
    const root = document.getElementById("list");
    if (!root) return;
    const items = [...root.querySelectorAll(".item[tabindex='0']")];
    if (!items.length) return;
    const currentIdx = items.findIndex((n) => n === document.activeElement);

    if (e.key === "ArrowDown") { e.preventDefault(); items[Math.min(items.length - 1, currentIdx + 1)]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[Math.max(0, currentIdx - 1)]?.focus(); }
    if (e.key === "PageDown") { e.preventDefault(); goToPage(currentPage + 1); }
    if (e.key === "PageUp") { e.preventDefault(); goToPage(currentPage - 1); }
  });
}

/* =========================
   EVENTS
========================= */
window.addEventListener("DOMContentLoaded", () => {
  const saved = loadCreds();
  if (saved) {
    document.getElementById("xtDomain").value = saved.domain || "";
    document.getElementById("xtUser").value = saved.username || "";
    document.getElementById("xtPass").value = saved.password || "";
  }

  document.getElementById("toggleFavOnly")?.addEventListener("click", () => {
    favOnly = !favOnly;
    document.getElementById("toggleFavOnly").textContent = `⭐ Favoris : ${favOnly ? "ON" : "OFF"}`;
    applyFiltersAndRender();
  });

  document.getElementById("toggleEPG")?.addEventListener("click", () => {
    epgEnabled = !epgEnabled;
    document.getElementById("toggleEPG").textContent = `📺 EPG : ${epgEnabled ? "ON" : "OFF"}`;
    if (!epgEnabled) document.getElementById("epgSection").style.display = "none";
    applyFiltersAndRender();
  });

  document.getElementById("pageFirst")?.addEventListener("click", () => goToPage(1));
  document.getElementById("pagePrev")?.addEventListener("click", () => goToPage(currentPage - 1));
  document.getElementById("pageNext")?.addEventListener("click", () => goToPage(currentPage + 1));
  document.getElementById("pageLast")?.addEventListener("click", () => goToPage(getTotalPages()));
  document.getElementById("pageSelect")?.addEventListener("change", (e) => goToPage(parseInt(e.target.value, 10)));
  document.getElementById("perPage")?.addEventListener("change", (e) => {
    itemsPerPage = parseInt(e.target.value, 10) || 50;
    currentPage = 1;
    renderCurrentPage();
  });

  setupTvNav();

  const resume = loadResume();
  if (resume?.title) {
    setDetails({ title: "Reprendre", poster: "", metaBadges: [resume.type || ""], synopsis: `Dernier : ${resume.title}` });
  } else {
    setDetails({ title: "Détails", poster: "", metaBadges: [], synopsis: "" });
  }
});

document.getElementById("xtForget")?.addEventListener("click", () => {
  clearCreds();
  document.getElementById("xtPass").value = "";
  alert("Identifiants supprimés.");
});

document.getElementById("loadUrl")?.addEventListener("click", async () => {
  const url = document.getElementById("m3uUrl")?.value.trim();
  if (!url) return alert("Mets une URL M3U.");
  try {
    xtCreds = null;
    viewMode = "list";
    currentSeries = null;
    document.querySelector(".pagination").style.display = "flex";
    await loadM3UFromUrl(url);
  } catch (e) { alert("Erreur: " + e.message); }
});

document.getElementById("file")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  xtCreds = null;
  viewMode = "list";
  currentSeries = null;
  document.querySelector(".pagination").style.display = "flex";
  channels = parseM3U(fs.readFileSync(file.path, "utf-8"));
  applyFiltersAndRender();
});

document.getElementById("search")?.addEventListener("input", applyFiltersAndRender);
document.getElementById("categories")?.addEventListener("change", applyFiltersAndRender);
document.getElementById("country")?.addEventListener("change", applyFiltersAndRender);
document.getElementById("format")?.addEventListener("change", applyFiltersAndRender);

document.getElementById("xtLoad")?.addEventListener("click", async () => {
  const domain = document.getElementById("xtDomain")?.value.trim();
  const username = document.getElementById("xtUser")?.value.trim();
  const password = document.getElementById("xtPass")?.value.trim();

  if (!domain || !username || !password) return alert("Renseigne domaine, username et password.");

  try {
    xtCreds = { domain, username, password };
    saveCreds(xtCreds);
    viewMode = "list";
    currentSeries = null;
    document.querySelector(".pagination").style.display = "flex";
    epgCache = {};

    const { cats, items } = await xtreamLoadByType(xtContentType);
    xtCats = cats;
    xtItems = items;

    fillCategories(xtCats);
    fillCountries(xtItems);
    applyFiltersAndRender();
    toast(`${items.length} éléments chargés`);
  } catch (e) { alert("Erreur Xtream: " + e.message); }
});

document.getElementById("contentType")?.addEventListener("change", async (e) => {
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
    toast(`${items.length} ${xtContentType} chargés`);
  } catch (err) { alert("Erreur: " + err.message); }
});
