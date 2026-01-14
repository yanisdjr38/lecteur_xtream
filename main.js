const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

function downloadText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));

    const lib = url.startsWith("https") ? https : http;

    const req = lib.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          Connection: "keep-alive",
        },
      },
      (res) => {
        const code = res.statusCode || 0;
        console.log("HTTP", code, "URL:", url);

        // Redirections
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(downloadText(nextUrl, redirectCount + 1));
        }

        // Choix du flux (décompression si nécessaire)
        let stream = res;
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (enc.includes("deflate"))
          stream = res.pipe(zlib.createInflate());

        let data = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => (data += chunk));
        stream.on("end", () => {
          if (code >= 200 && code < 300) return resolve(data);
          reject(new Error(`HTTP ${code} - ${data.slice(0, 300)}`));
        });
        stream.on("error", reject);
      }
    );

    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout")));
    req.end();
  });
}

ipcMain.handle("m3u:loadUrl", async (_event, url) => {
  if (typeof url !== "string" || !url.startsWith("http")) {
    throw new Error("URL invalide");
  }
  return await downloadText(url);
});

function xtreamBase(domain) {
  const d = (domain || "").trim().replace(/\/+$/, "");
  if (!d) throw new Error("Domaine Xtream manquant");
  return /^https?:\/\//i.test(d) ? d : `http://${d}`;
}

async function xtreamJson({ domain, username, password, params = {} }) {
  if (!username || !password) throw new Error("Username/password manquants");
  const base = xtreamBase(domain);
  const u = new URL(`${base}/player_api.php`);
  u.searchParams.set("username", username);
  u.searchParams.set("password", password);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));

  const txt = await downloadText(u.toString());
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`Réponse non JSON (preview): ${txt.slice(0, 200)}`);
  }
}

ipcMain.handle("xtream:handshake", async (_e, payload) => {
  return xtreamJson(payload);
});

ipcMain.handle("xtream:getLiveCategories", async (_e, payload) => {
  return xtreamJson({ ...payload, params: { action: "get_live_categories" } });
});

ipcMain.handle("xtream:getLiveStreams", async (_e, payload) => {
  const params = { action: "get_live_streams" };
  if (payload.category_id) params.category_id = payload.category_id;
  return xtreamJson({ ...payload, params });
});

ipcMain.handle("xtream:getVodCategories", async (_e, payload) => {
  return xtreamJson({ ...payload, params: { action: "get_vod_categories" } });
});

ipcMain.handle("xtream:getVodStreams", async (_e, payload) => {
  const params = { action: "get_vod_streams" };
  if (payload.category_id) params.category_id = payload.category_id;
  return xtreamJson({ ...payload, params });
});

ipcMain.handle("xtream:getSeriesCategories", async (_e, payload) => {
  return xtreamJson({
    ...payload,
    params: { action: "get_series_categories" },
  });
});

ipcMain.handle("xtream:getSeries", async (_e, payload) => {
  const params = { action: "get_series" };
  if (payload.category_id) params.category_id = payload.category_id;
  return xtreamJson({ ...payload, params });
});

ipcMain.handle("xtream:getSeriesInfo", async (_e, payload) => {
  if (!payload.series_id) throw new Error("series_id manquant");
  return xtreamJson({
    ...payload,
    params: { action: "get_series_info", series_id: payload.series_id },
  });
});

/* =========================
   EPG (Guide des programmes)
========================= */
ipcMain.handle("xtream:getShortEPG", async (_e, payload) => {
  // EPG court pour une chaîne spécifique (programme en cours + suivants)
  if (!payload.stream_id) throw new Error("stream_id manquant pour EPG");
  return xtreamJson({
    ...payload,
    params: { action: "get_short_epg", stream_id: payload.stream_id, limit: payload.limit || 4 },
  });
});

ipcMain.handle("xtream:getSimpleDataTable", async (_e, payload) => {
  // EPG complet pour toutes les chaînes (peut être volumineux)
  return xtreamJson({
    ...payload,
    params: { action: "get_simple_data_table", stream_id: payload.stream_id || "" },
  });
});

ipcMain.handle("xtream:getEPG", async (_e, payload) => {
  // EPG XML complet (XMLTV format)
  if (!payload.stream_id) throw new Error("stream_id manquant pour EPG");
  return xtreamJson({
    ...payload,
    params: { action: "get_epg", stream_id: payload.stream_id },
  });
});

/* =========================
   VOD Info détaillée
========================= */
ipcMain.handle("xtream:getVodInfo", async (_e, payload) => {
  if (!payload.vod_id) throw new Error("vod_id manquant");
  return xtreamJson({
    ...payload,
    params: { action: "get_vod_info", vod_id: payload.vod_id },
  });
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
