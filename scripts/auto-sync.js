// Auto-sync NHẸ cho NhotPhim — chạy ngầm bằng GitHub Actions, không cần mở admin.
//
// Khác với scripts/sync.js (quét toàn bảng lúc 22h), script này chỉ:
//   1. Đọc page 1 của danh sách "phim mới cập nhật" của NguonC / KKPhim / VodPhim.
//   2. So mốc modified.time với mốc đã lưu ở bảng public.auto_sync_state.
//   3. Phim đã có trong DB -> sync 3 server RIÊNG BIỆT bằng helper của sync.js
//      (NguonC -> link, KKPhim -> link2, VodPhim -> link3; không thay thế chéo).
//   4. Phim chưa có -> thêm tối đa 1 phim Trung Quốc (năm >= 2026) mỗi lượt,
//      CHỈ lấy từ KKPhim/VodPhim (NguonC bị Cloudflare chặn trên runner).
//
// Lần chạy đầu CHỈ ghi mốc (baseline), không import hàng loạt.
// Lịch thực tế: 30 phút/lượt (khung :00/:30) do máy nhà dispatch.
// Trạng thái lưu ở bảng riêng auto_sync_state, KHÔNG nằm trong app_settings để
// không làm trigger touch_site_version() đổi cờ và bắt web tải lại danh sách.
//
// Biến môi trường:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  (bắt buộc, lấy từ sync.js)
//   DRY_RUN=1                           chỉ log, không ghi DB
//   AUTO_ADD_MIN_YEAR                   mặc định 2026
//   AUTO_ADD_COUNTRY                    mã quốc gia cần thêm, mặc định "cn" (Trung Quốc)
//   MAX_ADD_PER_RUN / MAX_ADD_DETAILS   số phim thêm / số detail tối đa mỗi lượt
//   SWEEP_EVERY                         mỗi N lượt quét lại page 1 bỏ qua mốc (mặc định 4 = 2h)
//   NGUONC_BASE / KKPHIM_BASE / VODPHIM_BASE  (tùy chọn, dùng khi test)

const S = require("./sync.js");
const {
  SB_URL, SB_HEADERS, DRY_RUN,
  fetchJson, fetchNcJson, resetNcDirectBlock, isNcDirectBlocked, getNcCacheAgeMs,
  dedupKey, keysMatch, isDuplicateMovie, extractEpNum, pickVietsubServerData,
  patchMovie, pushNotifs, syncFromAllSources, insertMovie,
  setNcDetailCache, getNcDetail, normalizeNcDetail, parseExtra,
  GENRE_IMPORT_MAP, COUNTRY_IMPORT_MAP, sleep,
} = S;

const NGUONC_BASE = process.env.NGUONC_BASE || "https://phim.nguonc.com/api";
const KKPHIM_BASE = process.env.KKPHIM_BASE || "https://phimapi.com";
const VODPHIM_BASE = process.env.VODPHIM_BASE || "https://api.xink.pro/api/content";

const MAX_SYNC_MOVIES = parseInt(process.env.MAX_SYNC_MOVIES) || 8; // phim đã có sync / lượt
const MAX_ADD_PER_RUN = parseInt(process.env.MAX_ADD_PER_RUN) || 1; // phim mới / lượt
const MAX_DETAILS = parseInt(process.env.MAX_ADD_DETAILS) || 12;    // giới hạn gọi detail / lượt
const MIN_YEAR = parseInt(process.env.AUTO_ADD_MIN_YEAR) || 2026;
const AUTO_ADD_COUNTRY = (process.env.AUTO_ADD_COUNTRY || "cn").toLowerCase(); // cn = Trung Quốc
const SOURCE_FAIL_LIMIT = 2; // 1 nguồn lỗi 2 lần liên tiếp -> bỏ nguồn đó trong lượt này
const SWEEP_EVERY = parseInt(process.env.SWEEP_EVERY) || 4; // mỗi 4 lượt (2h) quét lại page 1
const NC_FRESH_MS = 45 * 60 * 1000; // cache nc-cache tươi trong 45 phút

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
  const cols = "id,title,titleen,year,type,ep,poster,country,epstatus,currentep,totalep,ophim_slug,extra";
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
function scalar(v) {
  return v !== null && v !== undefined && typeof v !== "object" ? String(v) : "";
}

function modTime(it) {
  const m = it && it.modified;
  // modified của NguonC là string. Không được đọc m.at khi m là string —
  // lúc đó m.at chính là String.prototype.at (một hàm), ghi vào state sẽ sai.
  if (m && typeof m === "object") {
    return scalar(m.time) || scalar(m.at)
      || (typeof m.toISOString === "function" ? m.toISOString() : "");
  }
  return scalar(m) || scalar(it && it.created);
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
  // workflow chỉ tải file này. Nếu cache cũ thì VẪN GIỮ detail làm fallback rồi
  // thử gọi trực tiếp; 403 thì dùng lại detail đã validate thay vì bỏ trống SV1.
  if (cfg.src === "nc") {
    let cached = null;
    if (process.env.NGUONC_LIST_FILE) {
      try {
        const fs = require("fs");
        cached = JSON.parse(fs.readFileSync(process.env.NGUONC_LIST_FILE, "utf8"));
      } catch (e) {
        console.warn(`[nc] không đọc được cache (${e.message})`);
      }
    }
    const at = cached && cached._fetched_at ? Date.parse(cached._fetched_at) : NaN;
    const ageMs = Number.isFinite(at) ? Date.now() - at : NaN;
    const fresh = cached && Number.isFinite(ageMs) && ageMs <= NC_FRESH_MS;

    if (fresh) {
      setNcDetailCache(cached.details || {}, cached.items || [], cached._fetched_at);
      console.log(`[nc] dùng cache tươi (${Math.round(ageMs / 60000)} phút trước, ${Object.keys(cached.details || {}).length} detail)`);
      return mapLatest(cfg, cached);
    }

    if (cached && Array.isArray(cached.items)) {
      // Giữ detail cũ: link các tập đã đăng trên NguonC không đổi theo thời gian,
      // chỉ cần validate tên/năm khi dùng (xem sync.js::getNCFullData).
      setNcDetailCache(cached.details || {}, cached.items || [], cached._fetched_at);
      console.warn(`[nc] cache cũ (${Number.isFinite(ageMs) ? Math.round(ageMs / 60000) + " phút" : "không rõ mốc"}) — giữ ${Object.keys(cached.details || {}).length} detail làm fallback, thử gọi trực tiếp…`);
    } else {
      setNcDetailCache({}, []);
    }

    try {
      return mapLatest(cfg, await fetchNcJson(cfg.url, cfg.referer));
    } catch (e) {
      if (cached && Array.isArray(cached.items)) {
        console.warn(`[nc] gọi trực tiếp lỗi (${e.message}) → dùng danh sách cache cũ để sync các tập đã biết.`);
        return mapLatest(cfg, cached);
      }
      throw e;
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

// Gắn slug NguonC vừa thấy ở danh sách "mới cập nhật" vào bản copy của phim
// trước khi sync — để SV1 được điền đúng dù DB chưa có ophim_slug/extra.
function withNcSlug(m, slug) {
  if (!slug) return m;
  const extra = parseExtra(m.extra);
  return {
    ...m,
    // Slug vừa thấy ở danh sách mới là nguồn đáng tin nhất — ưu tiên nó hơn
    // ophim_slug cũ trong DB (có row bị lưu sai sang phim khác).
    ophim_slug: slug || m.ophim_slug,
    extra: {
      ...extra,
      sourceSlug: { ...(extra.sourceSlug || {}), nc: slug },
    },
  };
}

function countryCodes(list) {
  const out = new Set();
  // Đa số API trả mảng, nhưng có nguồn trả string ("Hàn Quốc" / "kr") —
  // nếu không chuẩn hóa ở đây thì .forEach() sẽ throw và làm cả lượt sync chết.
  const arr = Array.isArray(list) ? list : typeof list === "string" ? list.split(",") : [];
  const KNOWN = new Set(["kr", "cn", "tw", "hk", "jp", "us", "in", "vn", "th"]);
  arr.forEach((c) => {
    if (!c) return;
    const raw = String(typeof c === "string" ? c : (c.name || c.slug || "")).toLowerCase();
    if (KNOWN.has(raw)) { out.add(raw); return; }
    const v = COUNTRY_IMPORT_MAP[raw];
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
async function detailNC(slug) {
  try {
    const cached = getNcDetail(slug);
    const age = getNcCacheAgeMs();
    let d = null;
    // Detail tươi thì dùng luôn; detail cũ thì thử lấy bản mới, 403 thì đợi
    // fallback ở dưới (getNCFullData/syncFromAllSources cũng dùng chung cache này).
    if (cached && Number.isFinite(age) && age <= NC_FRESH_MS) d = cached;
    if (!d && !isNcDirectBlocked()) {
      try {
        d = await fetchNcJson(`${NGUONC_BASE}/film/${encodeURIComponent(slug)}`, "https://phim.nguonc.com/");
      } catch (e) {
        if (!cached) throw e;
        console.warn(`  NC detail lỗi (${e.message}) → dùng cache cũ cho "${slug}"`);
        d = cached;
      }
    }
    if (!d) d = cached;
    if (!d) return { movie: null, episodes: [] };
    const out = normalizeNcDetail(d, slug);
    return out.movie ? out : { movie: null, episodes: [] };
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
// Mặc định thêm phim Trung Quốc (cn) năm >= 2026. Có thể đổi bằng env
// AUTO_ADD_COUNTRY=kr|us|... ; so khớp cả mã lẫn tên để nguồn trả string vẫn dính.
const COUNTRY_NAMES = { cn: "trung quoc", kr: "han quoc", jp: "nhat ban", us: "au my", vn: "viet nam" };
function isAllowedCountry(country) {
  const arr = Array.isArray(country) ? country : typeof country === "string" ? [country] : [];
  if (countryCodes(arr).has(AUTO_ADD_COUNTRY)) return true;
  const wanted = S.normalizeStr(COUNTRY_NAMES[AUTO_ADD_COUNTRY] || AUTO_ADD_COUNTRY);
  return !!(wanted && arr.some((c) => {
    const n = S.normalizeStr(String(typeof c === "string" ? c : (c.name || c.slug || "")));
    return n.includes(wanted);
  }));
}
// Giữ alias cũ để không phá test/code gọi isKorean.
const isKorean = isAllowedCountry;

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

// NguonC bị Cloudflare chặn trên runner → chỉ dùng để sync tập (SV1), KHÔNG dùng
// để thêm phim mới. Ứng viên mới chỉ lấy từ KKPhim (SV2) và VodPhim (SV3).
const ADD_SOURCES = ["kk", "vp"];

async function addNewMovies(candidates, state, movies) {
  if (!candidates.length) return 0;
  const pool = candidates.filter((it) =>
    ADD_SOURCES.includes(it.src) && (parseInt(it.year) || 0) >= MIN_YEAR);
  if (!pool.length) return 0;

  const cur = ADD_SOURCES.indexOf(state.lastSrc);
  const pref = ADD_SOURCES[(cur + 1) % ADD_SOURCES.length];
  // DRY_RUN không ghi DB nên không được làm xoay nguồn trong state.
  if (!DRY_RUN) state.lastSrc = pref;

  const seen = new Set();
  const bySrc = { kk: [], vp: [] };
  pool.forEach((it) => {
    if (!it.slug) return;
    const key = `${it.src}:${it.slug}`;
    if (seen.has(key)) return;
    seen.add(key);
    bySrc[it.src].push(it);
  });
  // Đan xen 2 nguồn (ưu tiên nguồn đang tới lượt) để KK không chiếm hết quota
  // MAX_DETAILS trước khi VodPhim được xét.
  const other = ADD_SOURCES.find((s) => s !== pref);
  const ordered = [];
  for (let i = 0; ; i++) {
    const a = bySrc[pref][i], b = bySrc[other][i];
    if (!a && !b) break;
    if (a) ordered.push(a);
    if (b) ordered.push(b);
  }

  const existing = movies.map(asExisting);
  let added = 0, checked = 0;
  const failures = { kk: 0, vp: 0 };

  for (const it of ordered) {
    if (added >= MAX_ADD_PER_RUN || checked >= MAX_DETAILS) break;
    // Một nguồn lỗi 2 lần liên tiếp thì bỏ các ứng viên còn lại của nguồn đó
    // trong lượt này, chuyển sang nguồn kia — không để quota cháy trước khi tới VP.
    if (failures[it.src] >= SOURCE_FAIL_LIMIT) continue;
    checked++;
    try {
      const { movie, episodes } = await DETAILERS[it.src](it.slug);
      if (!movie || !movie.name) { failures[it.src]++; continue; }
      if ((parseInt(movie.year) || 0) < MIN_YEAR) continue;
      if (!isAllowedCountry(movie.country)) {
        console.log(`  = Bỏ qua (không phải ${AUTO_ADD_COUNTRY}): ${movie.name}`);
        continue;
      }
      if (isDuplicateMovie(movie.name, movie.origin_name, movie.year, existing)) {
        console.log(`  = Bỏ qua (đã có trong DB): ${movie.name}`);
        continue;
      }
      const payload = buildNewPayload(movie, episodes, it.src, it.slug);
      if (!payload.title) continue;
      if (await insertMovie(payload)) {
        added++;
        console.log(`  ${DRY_RUN ? "[DRY_RUN] sẽ thêm" : "+"} Phim mới [${it.src}]: ${payload.title} (${payload.year})`);
      }
    } catch (e) {
      failures[it.src]++;
      console.warn(`  Lỗi thêm phim [${it.src}/${it.slug}]: ${e.message}`);
    }
  }
  if (failures.kk || failures.vp) {
    console.log(`  Lượt thêm phim: bỏ qua ${failures.kk} ứng viên KK, ${failures.vp} ứng viên VP do lỗi/detail rỗng.`);
  }
  return added;
}

// ---------- main ----------
async function main() {
  console.log(`Auto-sync ngắn bắt đầu ${new Date().toISOString()}${DRY_RUN ? " (DRY RUN)" : ""}`);
  // Mỗi lượt được phép thử lại NguonC từ đầu; trong lượt thì 403 chỉ báo 1 lần.
  resetNcDirectBlock();
  const state = await loadState();
  state.__runs = (parseInt(state.__runs) || 0) + 1;
  const sweep = process.env.FORCE_SWEEP === "1" || state.__runs % SWEEP_EVERY === 0;
  if (sweep) console.log(`Lượt ${state.__runs}: quét lại page 1 (bỏ qua mốc modified) để không sót tập mới.`);
  const changed = [];
  const latestBySrc = {};

  const results = await Promise.allSettled(SOURCES.map(fetchLatest));
  results.forEach((res, i) => {
    const src = SOURCES[i].src;
    if (res.status !== "fulfilled") {
      console.warn(`[${src}] bỏ qua lượt này: ${res.reason && res.reason.message || res.reason}`);
      return;
    }
    latestBySrc[src] = res.value;
    const bucket = state[src] || (state[src] = {});
    const firstRun = !bucket.__init;
    if (firstRun) bucket.__init = 1;
    res.value.forEach((it) => {
      const prev = bucket[it.slug];
      bucket[it.slug] = it.modified;
      // Lần đầu chỉ ghi mốc — không import cả danh sách "mới cập nhật".
      // Lần sau: mốc ĐỔI hoặc SLUG MỚI xuất hiện trên page 1 đều đưa vào xét.
      // Trước đây chỉ xét khi có `prev`, nên phim mới lần đầu bị bỏ qua và
      // không bao giờ được thêm nếu nó không đổi mốc lần nữa.
      if (!firstRun && (!prev || prev !== it.modified)) changed.push(it);
    });
  });

  // Định kỳ (mặc định 2h/lần) quét lại page 1 kể cả khi mốc không đổi — đề phòng
  // nguồn cập nhật tập nhưng quên đổi modified, hoặc lượt trước bị lỗi mạng.
  if (sweep) {
    const seen = new Set(changed.map((it) => `${it.src}:${it.slug}`));
    for (const src of SOURCES.map((s) => s.src)) {
      for (const it of (latestBySrc[src] || []).slice(0, MAX_SYNC_MOVIES)) {
        const key = `${it.src}:${it.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        changed.push(it);
      }
    }
  }

  // KHÔNG return sớm ở đây: dù không có mốc modified đổi, vẫn phải xét toàn bộ
  // page 1 của KK/VodPhim để thêm phim mới (phim mới chỉ xuất hiện 1 lần trên
  // page 1 rồi trôi đi, nên phụ thuộc vào mốc đổi là không bao giờ thêm được).
  if (!changed.length) console.log("Không có mốc đổi — vẫn xét ứng viên phim mới KK/VP…");

  try {
    const movies = await loadMoviesLite();
    const targets = [], seen = new Set();
    const ncSlugByMovieId = new Map();
    changed.forEach((it) => {
      const m = findMovie(it, movies);
      if (!m) return;
      // Nhớ slug NguonC của item vừa đổi để truyền vào sync (điền đúng SV1).
      if (it.src === "nc" && it.slug) ncSlugByMovieId.set(m.id, it.slug);
      if (seen.has(m.id)) return;
      seen.add(m.id);
      targets.push(m);
    });

    // Thêm phim MỚI: xét TOÀN BỘ page 1 của KK/VodPhim, không phụ thuộc vào
    // mốc modified (mốc chỉ dùng để quyết định sync tập cho phim đã có).
    // Loại các slug đã lưu trong extra.sourceSlug để khỏi gọi detail lại mãi.
    const known = { kk: new Set(), vp: new Set() };
    movies.forEach((m) => {
      const slugs = (parseExtra(m.extra) || {}).sourceSlug || {};
      if (slugs.kk) known.kk.add(String(slugs.kk));
      if (slugs.vp) known.vp.add(String(slugs.vp));
    });
    const newCandidates = [];
    const candSeen = new Set();
    for (const src of ADD_SOURCES) {
      for (const it of (latestBySrc[src] || [])) {
        if (!it.slug || known[src].has(it.slug)) continue;
        // Lọc sơ bằng tên/năm có sẵn từ danh sách: DB thường không lưu sourceSlug,
        // nếu không lọc thì 12 lượt gọi detail bị tiêu vào phim đã có trong DB.
        if (findMovie(it, movies)) continue;
        const key = `${src}:${it.slug}`;
        if (candSeen.has(key)) continue;
        candSeen.add(key);
        newCandidates.push(it);
      }
    }
    // Phòng trường hợp item đổi mốc nhưng không còn nằm trong page 1 lúc đọc.
    changed.forEach((it) => {
      if (!ADD_SOURCES.includes(it.src) || !it.slug || known[it.src].has(it.slug)) return;
      const key = `${it.src}:${it.slug}`;
      if (candSeen.has(key)) return;
      candSeen.add(key);
      newCandidates.push(it);
    });
    console.log(`Đổi ${changed.length} mốc → ${targets.length} phim có trong DB; ${newCandidates.length} ứng viên mới KK/VP chưa có slug trong DB.`);

    const notifs = [];
    let synced = 0;
    if (targets.length) {
      const epsMap = await loadEpisodesByIds(targets.map((m) => m.id));
      for (const m of targets.slice(0, MAX_SYNC_MOVIES)) {
        try {
          const full = withNcSlug(
            { ...m, episodes: epsMap.get(m.id) || "" },
            ncSlugByMovieId.get(m.id)
          );
          const result = await syncFromAllSources(full);
          if (!result) continue;
          if (await patchMovie(m.id, result.fields)) {
            synced++;
            if (result.hasNewEp) {
              console.log(`  ✓ Tập mới: ${m.title} ${m.currentep || 0} → ${result.curNum}`);
              notifs.push({ title: m.title, ep: result.ep, poster: m.poster || "", created_at: new Date().toISOString() });
            } else if (result.linksChanged) {
              console.log(`  ~ Chỉ đổi link (số tập giữ nguyên): ${m.title}`);
            }
          }
        } catch (e) {
          console.warn(`  Lỗi sync ${m.title}: ${e.message}`);
        }
        await sleep(300);
      }
      await pushNotifs(notifs);
    }

    const added = await addNewMovies(newCandidates, state, movies);
    console.log(`Xong! Đã sync ${synced}/${Math.min(targets.length, MAX_SYNC_MOVIES)} phim, ${notifs.length} tập mới, ${DRY_RUN ? "sẽ thêm" : "thêm"} ${added} phim mới.`);
  } finally {
    // Luôn lưu mốc đã đọc, kể cả khi sync lỗi giữa chừng → lần sau không xử lý lại cả danh sách.
    await saveState(state);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  modTime, findMovie, buildNewPayload, isKorean, isAllowedCountry, countryCodes,
  fetchLatest, withNcSlug, SOURCES, addNewMovies,
};
