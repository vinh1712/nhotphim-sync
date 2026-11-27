// Auto-sync NHẸ cho NhotPhim — chạy ngầm bằng GitHub Actions, không cần mở admin.
//
// Khác với scripts/sync.js (quét toàn bảng lúc 22h), script này chỉ:
//   1. Đọc page 1 của danh sách "phim mới cập nhật" của NguonC / KKPhim / VodPhim.
//   2. So mốc modified.time với mốc đã lưu ở bảng public.auto_sync_state.
//   3. Phim đã có trong DB -> sync tiếp 3 nguồn bằng helper của sync.js (chỉ vài phim).
//   4. Phim chưa có -> thêm tối đa 1 phim Hàn Quốc (năm >= 2026) mỗi lượt, xoay vòng nguồn.
//
// Lần chạy đầu CHỈ ghi mốc (baseline), không import hàng loạt.
// Trạng thái lưu ở bảng riêng auto_sync_state, KHÔNG nằm trong app_settings để
// không làm trigger touch_site_version() đổi cờ và bắt web tải lại danh sách.
//
// Biến môi trường:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  (bắt buộc, lấy từ sync.js)
//   DRY_RUN=1                           chỉ log, không ghi DB
//   AUTO_ADD_MIN_YEAR                   mặc định 2026
//   NGUONC_BASE / KKPHIM_BASE / VODPHIM_BASE  (tùy chọn, dùng khi test)

const S = require("./sync.js");
const {
  SB_URL, SB_HEADERS, DRY_RUN,
  fetchJson, dedupKey, keysMatch, isDuplicateMovie, extractEpNum, pickVietsubServerData,
  patchMovie, pushNotifs, syncFromKKOnly, insertMovie,
  GENRE_IMPORT_MAP, COUNTRY_IMPORT_MAP, sleep,
} = S;

const NGUONC_BASE = process.env.NGUONC_BASE || "https://phim.nguonc.com/api";
const KKPHIM_BASE = process.env.KKPHIM_BASE || "https://phimapi.com";
const VODPHIM_BASE = process.env.VODPHIM_BASE || "https://api.xink.pro/api/content";

const MAX_SYNC_MOVIES = 8;   // giới hạn phim đã có được sync trong 1 lượt
const MAX_ADD_PER_RUN = 1;   // 1 phim mới / 15 phút -> web fetch lại danh sách tối đa 1 lần
const MAX_DETAILS = 6;       // giới hạn gọi detail khi chưa tìm thấy ứng viên hợp lệ
const MIN_YEAR = parseInt(process.env.AUTO_ADD_MIN_YEAR) || 2026;

const SOURCES = [
  { src: "nc", url: `${NGUONC_BASE}/films/phim-moi-cap-nhat?page=1`, referer: "https://phim.nguonc.com/" },
  { src: "kk", url: `${KKPHIM_BASE}/danh-sach/phim-moi-cap-nhat?page=1`, referer: "https://phimapi.com/" },
  { src: "vp", url: `${VODPHIM_BASE}/phim-moi-cap-nhat?page=1`, referer: "https://vodphim.com/" },
];

// ---------- Supabase ----------
async function sbFetch(path, opts = {}) {
  const r = await fetch(`${SB_URL}${path}`, {
    ...opts,
    headers: { ...SB_HEADERS, ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} lỗi ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function loadState() {
  const rows = await sbFetch("/rest/v1/auto_sync_state?select=state&id=eq.1");
  const s = rows && rows[0] && rows[0].state;
  return s && typeof s === "object" ? s : {};
}

async function saveState(state) {
  if (DRY_RUN) { console.log("[DRY_RUN] sẽ lưu state:", Object.keys(state).join(",")); return; }
  await sbFetch("/rest/v1/auto_sync_state", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: 1, state, updated_at: new Date().toISOString() }),
  });
}

// Chỉ lấy các cột cần thiết — KHÔNG select=* (episodes/extra có row rất nặng).
async function loadMoviesLite() {
  const cols = "id,title,titleen,year,type,ep,poster,country,epstatus,currentep,totalep,ophim_slug";
  const out = [];
  const PAGE = 500;
  for (let offset = 0; ; offset += PAGE) {
    const rows = await sbFetch(`/rest/v1/movies?select=${cols}&order=id.asc&limit=${PAGE}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function loadEpisodesByIds(ids) {
  const map = new Map();
  if (!ids.length) return map;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).join(",");
    const rows = await sbFetch(`/rest/v1/movies?select=id,episodes&id=in.(${chunk})`);
    rows.forEach((r) => map.set(r.id, r.episodes || ""));
  }
  return map;
}

// ---------- Danh sách "phim mới cập nhật" ----------
function modTime(it) {
  const m = it && it.modified;
  return String((m && (m.time || m.at)) || m || (it && it.created) || "");
}

function mapLatest(cfg, d) {
  const list = (d && (d.items || (d.data && d.data.items))) || [];
  return list.slice(0, 30).map((it) => ({
    src: cfg.src,
    slug: String(it.slug || ""),
    modified: modTime(it),
    name: it.name || "",
    origin: it.origin_name || it.original_name || "",
    year: it.year || "",
    country: it.country || it.country_name || [],
  })).filter((it) => it.slug && it.modified);
}

async function fetchLatest(cfg) {
  // NguonC chặn IP GitHub runner. Máy nhà fetch rồi đẩy JSON lên nhánh nc-cache,
  // workflow tải về file này; vẫn tự gọi trực tiếp nếu cache cũ/không có.
  if (cfg.src === "nc" && process.env.NGUONC_LIST_FILE) {
    try {
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync(process.env.NGUONC_LIST_FILE, "utf8"));
      const at = d._fetched_at ? Date.parse(d._fetched_at) : NaN;
      const ageMs = Date.now() - at;
      if (!Number.isFinite(ageMs) || ageMs > 45 * 60 * 1000) {
        throw new Error(`cache cũ (${Math.round(ageMs / 60000)} phút)`);
      }
      console.log(`[nc] dùng cache local (${Math.round(ageMs / 60000)} phút trước)`);
      return mapLatest(cfg, d);
    } catch (e) {
      console.warn(`[nc] cache không dùng được (${e.message}), gọi trực tiếp…`);
    }
  }
  return mapLatest(cfg, await fetchJson(cfg.url, 15000, cfg.referer));
}

// ---------- So khớp phim đã có trong DB ----------
const asExisting = (m) => ({
  id: m.id,
  titleKey: dedupKey(m.title || ""),
  titleEnKey: dedupKey(m.titleen || ""),
  year: parseInt(m.year) || 0,
});

function countryCodes(list) {
  const out = new Set();
  (list || []).forEach((c) => {
    if (!c) return;
    const v = COUNTRY_IMPORT_MAP[String(typeof c === "string" ? c : (c.name || c.slug || "")).toLowerCase()];
    if (v) out.add(v);
  });
  return out;
}

function findMovie(item, movies) {
  // NguonC có ophim_slug được lưu sẵn ở DB — khớp slug trước cho chắc.
  if (item.src === "nc") {
    const hit = movies.find((m) => m.ophim_slug === item.slug);
    if (hit) return hit;
  }
  const candExisting = { titleKey: dedupKey(item.name), titleEnKey: dedupKey(item.origin), year: parseInt(item.year) || 0 };
  const itemCodes = countryCodes(item.country);
  for (const m of movies) {
    const e = asExisting(m);
    const yearOk = !candExisting.year || !e.year || Math.abs(candExisting.year - e.year) <= 1;
    if (!yearOk) continue;
    const nameOk = keysMatch(candExisting.titleKey, e.titleKey) || keysMatch(candExisting.titleKey, e.titleEnKey)
      || (candExisting.titleEnKey && (keysMatch(candExisting.titleEnKey, e.titleKey) || keysMatch(candExisting.titleEnKey, e.titleEnKey)));
    if (!nameOk) continue;
    const dbCodes = countryCodes(typeof m.country === "string" ? m.country.split(",") : m.country);
    if (itemCodes.size && dbCodes.size && ![...itemCodes].some((c) => dbCodes.has(c))) continue;
    return m;
  }
  return null;
}

// ---------- Detail 3 nguồn (đều trả về chuẩn: thumb_url=poster, poster_url=backdrop) ----------
function flattenNguonCCategory(category) {
  const genres = [], countries = [];
  if (category && typeof category === "object") {
    Object.values(category).forEach((g) => {
      const group = String((g && g.group && g.group.name) || "").toLowerCase();
      const list = (g && g.list) || [];
      if (group.includes("the loai")) list.forEach((x) => genres.push({ name: x.name }));
      else if (group.includes("quoc gia")) list.forEach((x) => countries.push({ name: x.name }));
    });
  }
  return { genres, countries };
}

function normEpisodesNC(servers) {
  return (servers || []).map((sv) => ({
    server_name: sv.server_name || "Server #1",
    server_data: (sv.items || sv.server_data || []).map((ep) => ({
      name: ep.name || "", link_embed: ep.embed || ep.link_embed || "", link_m3u8: ep.m3u8 || ep.link_m3u8 || "",
    })),
  }));
}

async function detailNC(slug) {
  try {
    const d = await fetchJson(`${NGUONC_BASE}/film/${slug}`, 15000, "https://phim.nguonc.com/");
    const m = d && d.movie;
    if (!m) return { movie: null, episodes: [] };
    const { genres, countries } = flattenNguonCCategory(m.category);
    return {
      movie: {
        name: m.name || "", origin_name: m.original_name || "", content: m.description || "",
        year: m.year || "",
        type: (parseInt(m.total_episodes || m.episode_total) || 0) > 1 ? "series" : "single",
        thumb_url: m.thumb_url || m.poster_url || "", poster_url: m.poster_url || m.thumb_url || "",
        backdrop_url: m.poster_url || m.thumb_url || "", category: genres,
        country: countries.length ? countries : (m.country || []),
        lang: m.language || "", episode_current: m.current_episode || "", episode_total: parseInt(m.total_episodes) || 0,
      },
      episodes: normEpisodesNC(m.episodes),
    };
  } catch (e) { console.warn(`  NC detail lỗi (${slug}): ${e.message}`); return { movie: null, episodes: [] }; }
}

async function detailKK(slug) {
  try {
    const d = await fetchJson(`${KKPHIM_BASE}/phim/${slug}`, 15000, "https://phimapi.com/");
    const m = d && d.movie;
    if (!m) return { movie: null, episodes: [] };
    const poster = m.poster_url || m.thumb_url || "";
    const backdrop = m.thumb_url || m.poster_url || "";
    return {
      movie: {
        name: m.name || "", origin_name: m.origin_name || "", content: m.content || "",
        year: m.year || "", type: m.type === "single" ? "single" : "series",
        // KKPhim để ngược 2 field ảnh nên phải đảo lại.
        thumb_url: poster, poster_url: backdrop, backdrop_url: backdrop,
        category: m.category || [], country: m.country || [], lang: m.lang || "",
        episode_current: m.episode_current || "", episode_total: parseInt(m.episode_total) || 0,
      },
      episodes: (d.episodes || []).map((sv) => ({
        server_name: sv.server_name || "KKPhim Server",
        server_data: (sv.server_data || []).map((ep) => ({ name: ep.name || "", link_embed: ep.link_embed || "", link_m3u8: ep.link_m3u8 || "" })),
      })),
    };
  } catch (e) { console.warn(`  KK detail lỗi (${slug}): ${e.message}`); return { movie: null, episodes: [] }; }
}

async function detailVP(slug) {
  try {
    const d = await fetchJson(`${VODPHIM_BASE}/phim/${encodeURIComponent(slug)}`, 15000, "https://vodphim.com/");
    const m = d && d.movie;
    if (!m) return { movie: null, episodes: [] };
    const poster = m.poster_url || m.thumb_url || "";
    const backdrop = m.thumb_url || m.poster_url || "";
    return {
      movie: {
        name: m.name || "", origin_name: m.origin_name || "", content: m.content || "",
        year: m.year || "", type: ["single", "movie", "theater"].includes(m.type) ? "single" : "series",
        // VodPhim cũng để ngược 2 field ảnh.
        thumb_url: poster, poster_url: backdrop, backdrop_url: backdrop,
        category: m.category || [], country: m.country || [], lang: m.lang || "",
        episode_current: m.episode_current || "", episode_total: parseInt(m.episode_total) || 0,
      },
      episodes: (d.episodes || []).map((sv) => ({
        server_name: sv.server_name || "VodPhim Server",
        server_data: (sv.server_data || []).map((ep) => ({ name: ep.name || "", link_embed: ep.link_embed || "", link_m3u8: ep.link_m3u8 || "" })),
      })),
    };
  } catch (e) { console.warn(`  VP detail lỗi (${slug}): ${e.message}`); return { movie: null, episodes: [] }; }
}

const DETAILERS = { nc: detailNC, kk: detailKK, vp: detailVP };

// ---------- Thêm phim mới ----------
function isKorean(country) {
  return countryCodes(country).has("kr") || (country || []).some((c) => {
    const n = S.normalizeStr(String(typeof c === "string" ? c : (c.name || c.slug || "")));
    return n.includes("han quoc") || n.includes("han-quoc");
  });
}

function buildNewPayload(movie, episodes, src, slug) {
  const isSingle = movie.type === "single";
  const serverData = pickVietsubServerData(episodes);
  const genres = (movie.category || []).map((g) => GENRE_IMPORT_MAP[String((g && g.name) || "").toLowerCase()]).filter(Boolean).join(",");
  const countryName = String((movie.country && movie.country[0] && movie.country[0].name) || "").toLowerCase();
  const countrySlug = String((movie.country && movie.country[0] && movie.country[0].slug) || "").toLowerCase();
  const countryVal = COUNTRY_IMPORT_MAP[countryName] || COUNTRY_IMPORT_MAP[countrySlug] || "kr";
  const sub = /thuyet minh|thuyết minh|lồng tiếng|long tieng/i.test(movie.lang || "") ? "Thuyết minh" : "Vietsub";
  const slot = src === "nc" ? "link" : src === "kk" ? "link2" : "link3";
  const first = serverData[0] || {};

  const payload = {
    title: movie.name || "", titleen: movie.origin_name || "", year: movie.year || "",
    genre: genres, country: countryVal, type: isSingle ? "movie" : "series", rating: "N/A", sub,
    poster: movie.thumb_url || "", backdrop: movie.poster_url || movie.backdrop_url || null,
    description: String(movie.content || "").replace(/<[^>]*>/g, ""),
    videosource: null,
    embedurl: src === "nc" ? (first.link_embed || null) : null,
    embedurl2: src === "kk" ? (first.link_embed || null) : null,
    embedurl3: src === "vp" ? (first.link_embed || null) : null,
    ophim_slug: src === "nc" ? slug : null,
    series_group: null, part_number: null,
    // Giữ slug từng nguồn để các lần sync tập sau không phải search lại.
    extra: { sourceSlug: { [src]: slug } },
  };

  if (isSingle) {
    payload.ep = "Full"; payload.episodes = null;
    payload.totalep = null; payload.currentep = null; payload.epstatus = null;
  } else {
    const eps = serverData.map((ep, i) => ({
      name: ep.name || `Tập ${i + 1}`, link: "", link2: "", link3: "", [slot]: ep.link_embed || "",
    }));
    const cur = extractEpNum(movie.episode_current) || eps.length;
    const total = parseInt(movie.episode_total) || eps.length;
    const done = /hoàn|full/i.test(movie.episode_current || "");
    payload.episodes = JSON.stringify(eps);
    payload.currentep = cur || null;
    payload.totalep = total || null;
    payload.epstatus = done ? "Hoàn thành" : "Đang chiếu";
    payload.ep = done ? `Full ${total || ""} tập` : `Tập ${cur}${total ? "/" + total : ""}`;
  }
  return payload;
}

async function addNewMovies(candidates, state, movies) {
  if (!candidates.length) return 0;
  const order = ["nc", "kk", "vp"];
  const pref = order[(order.indexOf(state.lastSrc || "") + 1 + order.length) % order.length];
  state.lastSrc = pref; // xoay vòng dù lượt này không thêm được -> cả 3 nguồn đều có lượt
  const ordered = candidates.slice().sort((a, b) => (a.src === pref ? -1 : 0) - (b.src === pref ? -1 : 0));
  const existing = movies.map(asExisting);
  let added = 0, checked = 0;

  for (const it of ordered) {
    if (added >= MAX_ADD_PER_RUN || checked >= MAX_DETAILS) break;
    if ((parseInt(it.year) || 0) < MIN_YEAR) continue;
    if (it.src === "vp" && !isKorean(it.country)) continue;
    try {
      checked++;
      const { movie, episodes } = await DETAILERS[it.src](it.slug);
      if (!movie || !movie.name) continue;
      if ((parseInt(movie.year) || 0) < MIN_YEAR) continue;
      if (!isKorean(movie.country)) continue;
      if (isDuplicateMovie(movie.name, movie.origin_name, movie.year, existing)) {
        console.log(`  = Bỏ qua (đã có trong DB): ${movie.name}`);
        continue;
      }
      const payload = buildNewPayload(movie, episodes, it.src, it.slug);
      if (!payload.title) continue;
      if (await insertMovie(payload)) {
        added++;
        console.log(`  + Phim mới [${it.src}]: ${payload.title} (${payload.year})`);
      }
    } catch (e) {
      console.warn(`  Lỗi thêm phim [${it.src}/${it.slug}]: ${e.message}`);
    }
  }
  return added;
}

// ---------- main ----------
async function main() {
  console.log(`Auto-sync ngắn bắt đầu ${new Date().toISOString()}${DRY_RUN ? " (DRY RUN)" : ""}`);
  const state = await loadState();
  const changed = [];

  const results = await Promise.allSettled(SOURCES.map(fetchLatest));
  results.forEach((res, i) => {
    const src = SOURCES[i].src;
    if (res.status !== "fulfilled") {
      console.warn(`[${src}] bỏ qua lượt này: ${res.reason && res.reason.message || res.reason}`);
      return;
    }
    const bucket = state[src] || (state[src] = {});
    const firstRun = !bucket.__init;
    if (firstRun) bucket.__init = 1;
    res.value.forEach((it) => {
      const prev = bucket[it.slug];
      bucket[it.slug] = it.modified;
      // Lần đầu chỉ ghi mốc — không import cả danh sách "mới cập nhật".
      if (!firstRun && prev && prev !== it.modified) changed.push(it);
    });
  });

  if (!changed.length) {
    await saveState(state);
    console.log("Không có mốc đổi. Xong.");
    return;
  }

  const movies = await loadMoviesLite();
  const targets = [], newCandidates = [], seen = new Set();
  changed.forEach((it) => {
    const m = findMovie(it, movies);
    if (!m) { newCandidates.push(it); return; }
    if (seen.has(m.id)) return;
    seen.add(m.id);
    targets.push(m);
  });
  console.log(`Đổi ${changed.length} mốc → ${targets.length} phim có trong DB, ${newCandidates.length} ứng viên mới.`);

  const notifs = [];
  if (targets.length) {
    const epsMap = await loadEpisodesByIds(targets.map((m) => m.id));
    for (const m of targets.slice(0, MAX_SYNC_MOVIES)) {
      try {
        const full = { ...m, episodes: epsMap.get(m.id) || "" };
        const result = await syncFromKKOnly(full);
        if (!result) continue;
        if (await patchMovie(m.id, result.fields) && result.hasNewEp) {
          console.log(`  ✓ Tập mới: ${m.title} ${m.currentep || 0} → ${result.curNum}`);
          notifs.push({ title: m.title, ep: result.ep, poster: m.poster || "", created_at: new Date().toISOString() });
        }
      } catch (e) {
        console.warn(`  Lỗi sync ${m.title}: ${e.message}`);
      }
      await sleep(300);
    }
    await pushNotifs(notifs);
  }

  const added = await addNewMovies(newCandidates, state, movies);
  await saveState(state);
  console.log(`Xong! Sync ${Math.min(targets.length, MAX_SYNC_MOVIES)} phim, ${notifs.length} tập mới, thêm ${added} phim mới.`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  modTime, findMovie, buildNewPayload, isKorean, countryCodes, fetchLatest, SOURCES,
};
