// Sync tập mới cho NhotPhim — chạy bằng GitHub Actions (Node 20+, không cần cài thư viện).
// 3 nguồn = 3 MÁY CHỦ của CÙNG MỘT phim, KHÔNG thay thế cho nhau:
//   NguonC -> link (SV1), KKPhim -> link2 (SV2), VodPhim/api.xink.pro -> link3 (SV3).
// NguonC bị Cloudflare chặn trên runner nên detail/tập được đọc từ cache nc-latest.json
// (do máy nhà fetch bằng scripts/update-nc-cache.ps1) — tuyệt đối không lấy link của
// server khác đắp vào SV1.
// Ngoài sync tập mới, script còn:
//   - Tự thêm phim MỚI (hiện chỉ lọc quốc gia Hàn Quốc) từ VodPhim, nếu DB chưa có
//   - Bổ sung link còn thiếu cho cả 3 server của phim ĐÃ "Hoàn thành" (không đụng
//     tới trạng thái/tập hiện tại của phim)
//   - Tự rà soát và sửa ảnh poster bị lỗi (404/410) trong DB
//
// Biến môi trường:
//   SUPABASE_URL           vd https://tlbumpjugtltznzuwqwt.supabase.co
//   SUPABASE_SERVICE_KEY   service_role key (CHỈ để trong GitHub Secrets)
//   DRY_RUN=1              (tùy chọn) chỉ in log, không ghi vào DB
//   SKIP_POSTER_FIX=1      (tùy chọn) bỏ qua bước rà soát/sửa ảnh poster lỗi
//   SKIP_BACKFILL_SV=1     (tùy chọn) bỏ qua bước bổ sung link 3 server cho phim đã hoàn thành
//   SKIP_AUTO_ADD=1        (tùy chọn) bỏ qua bước tự thêm phim mới
//   AUTO_ADD_COUNTRY_SLUG  (tùy chọn) slug quốc gia bên VodPhim, mặc định "han-quoc"
//   AUTO_ADD_PAGES         (tùy chọn) số trang mới nhất quét mỗi lần chạy, mặc định 2
//   AUTO_ADD_MIN_YEAR      (tùy chọn) chỉ thêm phim có năm >= giá trị này, mặc định 2026

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const DRY_RUN = process.env.DRY_RUN === "1";
const SKIP_POSTER_FIX = process.env.SKIP_POSTER_FIX === "1";
const SKIP_BACKFILL_SV = process.env.SKIP_BACKFILL_SV === "1";
const SKIP_AUTO_ADD = process.env.SKIP_AUTO_ADD === "1";
const AUTO_ADD_COUNTRY_SLUG = process.env.AUTO_ADD_COUNTRY_SLUG || "han-quoc"; // slug quốc gia bên VodPhim
const AUTO_ADD_PAGES = parseInt(process.env.AUTO_ADD_PAGES) || 2; // số trang mới nhất quét mỗi lần chạy
const AUTO_ADD_MIN_YEAR = parseInt(process.env.AUTO_ADD_MIN_YEAR) || 2026; // chỉ thêm phim có năm >= giá trị này

if (!SB_URL || !SB_KEY) {
  console.error("Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const NGUONC_BASE = process.env.NGUONC_BASE || "https://phim.nguonc.com/api";
const KKPHIM_BASE = process.env.KKPHIM_BASE || "https://phimapi.com";
const VODPHIM_BASE = process.env.VODPHIM_BASE || "https://api.xink.pro/api/content";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Cache NguonC (do máy nhà fetch, runner chỉ đọc) ----------
// slug -> raw JSON của /api/film/{slug}. Có cache thì KHÔNG gọi NguonC trên runner.
let NC_DETAIL_CACHE = Object.create(null);
let NC_LIST_CACHE = [];

function parseExtra(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function setNcDetailCache(details = {}, items = []) {
  NC_DETAIL_CACHE = details && typeof details === "object" ? details : Object.create(null);
  NC_LIST_CACHE = Array.isArray(items) ? items : [];
}

function getNcDetail(slug) {
  return slug ? NC_DETAIL_CACHE[slug] || null : null;
}

// Ưu tiên slug đã lưu trong DB; nếu chưa có thì dò trong danh sách/detail cache
// theo tên + năm (khớp hệt, không đoán mò để tránh gắn nhầm phim trùng tên).
function findNcSlugFromCache(m) {
  if (!m) return "";
  const extra = parseExtra(m.extra);
  const explicit = String(m.ophim_slug || (extra.sourceSlug && extra.sourceSlug.nc) || extra.ophim_slug || "");
  if (explicit && NC_DETAIL_CACHE[explicit]) return explicit;

  const q = normalizeStr(String(m.title || m.titleen || "").trim());
  const year = parseInt(m.year) || 0;
  const yearOk = (rawYear) => {
    const iy = parseInt(rawYear) || 0;
    return !year || !iy || Math.abs(iy - year) <= 1;
  };

  const hit = NC_LIST_CACHE.find((it) => {
    const n = normalizeStr(String(it.name || it.original_name || it.originalName || "").trim());
    return q && n === q && yearOk(it.year || it.release_year || it.nam || it.releaseYear);
  });
  if (hit && hit.slug) return String(hit.slug);

  // Detail cache đôi khi có nhiều slug hơn danh sách page 1.
  for (const [slug, d] of Object.entries(NC_DETAIL_CACHE)) {
    const mv = d && d.movie;
    if (!mv) continue;
    const n = normalizeStr(String(mv.name || mv.original_name || "").trim());
    if (q && n === q && yearOk(mv.year || mv.release_year)) return slug;
  }
  // Vẫn trả slug cũ để thử fetch trực tiếp (trường hợp chạy ở máy nhà).
  return explicit;
}

// Cho phép chạy sync.js thủ công với cùng file cache mà auto-sync dùng.
if (process.env.NGUONC_LIST_FILE) {
  try {
    const fs = require("fs");
    const cached = JSON.parse(fs.readFileSync(process.env.NGUONC_LIST_FILE, "utf8"));
    setNcDetailCache(cached.details || {}, cached.items || []);
    console.log(`[nc] đã nạp cache chi tiết: ${Object.keys(NC_DETAIL_CACHE).length} phim`);
  } catch (e) {
    console.warn(`[nc] không đọc được cache chi tiết: ${e.message}`);
  }
}

// Map tên thể loại/quốc gia từ nguồn (tiếng Việt) sang mã nội bộ của web — copy
// nguyên từ GENRE_IMPORT_MAP/COUNTRY_MAP trong file HTML admin để đồng bộ đúng chuẩn.
const GENRE_IMPORT_MAP = {
  "hành động": "action", "tình cảm": "romance", "hài hước": "comedy",
  "cổ trang": "costumes", "tâm lý": "psychology", "hình sự": "crime",
  "chiến tranh": "war", "thể thao": "sport", "võ thuật": "martial",
  "viễn tưởng": "fantasy", "phiêu lưu": "adventure", "khoa học viễn tưởng": "scifi", "khoa học": "scifi",
  "kinh dị": "horror", "âm nhạc": "music", "thần thoại": "myth",
  "tài liệu": "documentary", "gia đình": "family", "chính kịch": "drama",
  "bí ẩn": "mystery", "học đường": "school", "kinh điển": "classic",
  "18+": "adult", "anime": "anime", "hoạt hình": "anime", "tv shows": "tvshow",
};
const COUNTRY_IMPORT_MAP = {
  "hàn quốc": "kr", "han quoc": "kr", "korea": "kr", "south korea": "kr", "south-korea": "kr", "han-quoc": "kr",
  "trung quốc": "cn", "trung quoc": "cn", "china": "cn", "trung-quoc": "cn",
  "đài loan": "tw", "dai loan": "tw", "taiwan": "tw", "dai-loan": "tw",
  "hồng kông": "hk", "hong kong": "hk", "hong-kong": "hk",
  "nhật bản": "jp", "nhat ban": "jp", "japan": "jp", "nhat-ban": "jp",
  "âu mỹ": "us", "au my": "us", "au-my": "us",
  "mỹ": "us", "my": "us", "usa": "us", "america": "us", "united states": "us", "united-states": "us",
  "anh": "us", "uk": "us", "anh quốc": "us", "united kingdom": "us", "united-kingdom": "us",
  "pháp": "us", "phap": "us", "france": "us",
  "đức": "us", "duc": "us", "germany": "us",
  "úc": "us", "uc": "us", "australia": "us",
  "canada": "us", "tây ban nha": "us", "tay ban nha": "us", "spain": "us",
  "ý": "us", "italy": "us", "nga": "us", "russia": "us",
  "châu âu": "us", "chau au": "us", "europe": "us", "au-my-tay-au": "us",
  "indonesia": "us", "philippines": "us", "malaysia": "us", "singapore": "us",
  "ấn độ": "in", "an do": "in", "india": "in",
  "việt nam": "vn", "viet nam": "vn", "vietnam": "vn", "viet-nam": "vn",
  "thái lan": "th", "thai lan": "th", "thailand": "th", "thai-lan": "th",
};

// ---------- helpers ----------
function normalizeStr(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D");
}
// Chuẩn hóa mạnh tay hơn normalizeStr, dùng riêng cho việc dò trùng phim: bỏ phần
// trong ngoặc (năm, "Thuyết Minh"...), bỏ hết ký tự đặc biệt/khoảng trắng thừa —
// để "Hạ Cánh Nơi Anh (2019)" và "Hạ cánh nơi anh - Thuyết minh" vẫn được coi là
// cùng một phim thay vì lệch 1 ký tự là bị thêm trùng.
function dedupKey(s) {
  return normalizeStr(s)
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(thuyet minh|vietsub|long tieng|full|hd|phan\s*\d+|season\s*\d+|phần\s*\d+)\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
// So khớp 2 key đã chuẩn hóa: khớp y hệt, HOẶC 1 chuỗi chứa trọn chuỗi kia (bắt
// được trường hợp nguồn gắn thêm tiền tố/hậu tố quảng cáo, vd VodPhim hay thêm
// "Play Me: " trước tên gốc — "play me buoi dien tap cua chung ta" chứa trọn
// "buoi dien tap cua chung ta" đã lưu trong DB). Yêu cầu chuỗi ngắn hơn phải đủ
// dài (>=6 ký tự) để tránh khớp nhầm với tên quá ngắn kiểu "Yêu", "Hè"...
function keysMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 6 && longer.includes(shorter);
}
function isDuplicateMovie(candTitle, candTitleEn, candYear, existingList) {
  const ct = dedupKey(candTitle);
  const ce = candTitleEn ? dedupKey(candTitleEn) : "";
  const cy = parseInt(candYear) || 0;
  return existingList.some((e) => {
    const yearOk = !cy || !e.year || Math.abs(cy - e.year) <= 1;
    if (!yearOk) return false;
    if (keysMatch(ct, e.titleKey) || keysMatch(ct, e.titleEnKey)) return true;
    if (ce && (keysMatch(ce, e.titleKey) || keysMatch(ce, e.titleEnKey))) return true;
    return false;
  });
}
function extractEpNum(str) {
  const m = String(str || "").match(/\d+/);
  return m ? parseInt(m[0]) : 0;
}
function isNguoncUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "nguonc.com" || host.endsWith(".nguonc.com");
  } catch {
    return false;
  }
}

async function rpcCall(name, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { ...SB_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`RPC ${name} ${r.status}: ${text.slice(0, 180)}`);
  return text ? JSON.parse(text) : null;
}

// GitHub runner bị Cloudflare chặn (403). Gọi lại qua pg_net trên Supabase —
// chỉ setup khi chạy supabase/nc_proxy.sql; nếu chưa có RPC thì lỗi sẽ rõ ràng.
async function fetchJsonViaSupabase(url) {
  let lastErr;
  // Cloudflare đôi khi chặn cả IP Supabase -> pg_net treo đến 15s rồi ghi error_msg.
  // Thử lại vài lượt với request_id MỚI; lượt nào cũng có xác suất qua được.
  for (let round = 1; round <= 2; round++) {
    let id;
    try {
      id = await rpcCall("nc_http_request", { p_url: url });
      if (!id) throw new Error("nc_http_request không trả request_id");
      // nc_http_result() tự pg_sleep tới 15s nên dễ bị Supabase cắt bởi statement
      // timeout (~10s, mã 57014). Response của pg_net vẫn được ghi vào
      // net._http_response sau đó, nên gọi lại CHUNG request_id ở lượt sau là có.
      for (let i = 0; i < 4; i++) {
        try {
          const rows = await rpcCall("nc_http_result", { p_id: id });
          const row = Array.isArray(rows) ? rows[0] : rows;
          if (row && row.status_code) {
            if (row.status_code !== 200) throw new Error(`HTTP ${row.status_code}`);
            if (!row.content) throw new Error("Supabase proxy trả nội dung rỗng");
            return JSON.parse(row.content);
          }
          if (row && row.error_msg) throw new Error(row.error_msg);
        } catch (e) {
          lastErr = e;
          // 403 là chặn cố định, không thử lại; các lỗi timeout thì tiếp tục.
          if (/HTTP 403/.test(e.message)) throw e;
          if (!/57014|statement timeout|timeout/i.test(e.message)) throw e;
        }
        await sleep(500);
      }
    } catch (e) {
      lastErr = e;
      if (/HTTP 403/.test(e.message)) break;
    }
    await sleep(400);
  }
  throw lastErr || new Error("Supabase proxy timeout");
}

async function fetchJson(url, ms = 15000, referer = "") {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const headers = { ...BROWSER_HEADERS };
      if (referer) { headers.Referer = referer; headers.Origin = referer.replace(/\/$/, ""); }
      const r = await fetch(url, { signal: ctrl.signal, headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      // 403/404 thử lại cũng vô ích, chỉ thử lại khi lỗi mạng/timeout/5xx
      if (/HTTP (403|404)/.test(e.message)) break;
      await sleep(1500 * attempt);
    } finally {
      clearTimeout(t);
    }
  }
  if (isNguoncUrl(url) && /HTTP 403/.test(lastErr?.message || "")) {
    try {
      console.warn("[nc] Cloudflare chặn runner, thử qua Supabase proxy…");
      return await fetchJsonViaSupabase(url);
    } catch (e) {
      lastErr = new Error(`${lastErr.message}; Supabase proxy: ${e.message}`);
    }
  }
  throw lastErr;
}
function pickVietsubServerData(eps) {
  if (!Array.isArray(eps) || !eps.length) return [];
  const isVietsub = (name) => {
    const n = (name || "").toLowerCase();
    if (n.includes("lồng tiếng") || n.includes("long tieng") || n.includes("thuyết minh") || n.includes("thuyet minh")) return false;
    return n.includes("vietsub") || n.includes("phụ đề") || n.includes("phu de") || n.includes("sub");
  };
  const vs = eps.filter((sv) => isVietsub(sv.server_name));
  const pool = vs.length ? vs : eps;
  let best = pool[0];
  for (const sv of pool) if ((sv.server_data || []).length > (best.server_data || []).length) best = sv;
  return best?.server_data || [];
}
// ---------- NguonC ----------
async function nguoncSearch(keyword, limit = 10) {
  try {
    const d = await fetchJson(`${NGUONC_BASE}/films/search?keyword=${encodeURIComponent(keyword)}`, 15000, "https://phim.nguonc.com/");
    return (d?.items || []).slice(0, limit).map((it) => ({
      name: it.name || it.original_name || "",
      origin_name: it.original_name || "",
      slug: it.slug || "",
      year: it.year || it.release_year || it.nam || "",
    }));
  } catch (e) {
    console.warn("  NguonC search lỗi:", e.message);
    return [];
  }
}
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

// Chuẩn hóa detail NguonC (từ cache hoặc từ API) về cùng dạng detailKK/detailVP.
function normalizeNcDetail(d, slug = "") {
  const m = d && d.movie;
  if (!m) return { movie: null, episodes: [], slug };
  const { genres, countries } = flattenNguonCCategory(m.category);
  const servers = normEpisodesNC(m.episodes);
  // NguonC trả total_episodes = TỔNG item trên MỌI server (Vietsub + Thuyết minh
  // trùng tập), nên dùng số tập của server dài nhất để làm totalep cho đúng
  // lựa chọn "metadata theo server có nhiều tập nhất".
  const maxServerEps = servers.reduce((mx, sv) => Math.max(mx, sv.server_data.length), 0);
  const total = maxServerEps || parseInt(m.total_episodes || m.episode_total) || 0;
  return {
    movie: {
      name: m.name || "",
      origin_name: m.original_name || "",
      content: m.description || "",
      year: m.year || "",
      type: total > 1 ? "series" : "single",
      thumb_url: m.thumb_url || m.poster_url || "",
      poster_url: m.poster_url || m.thumb_url || "",
      backdrop_url: m.poster_url || m.thumb_url || "",
      category: genres,
      country: countries.length ? countries : (m.country || []),
      lang: m.language || "",
      episode_current: m.current_episode || "",
      episode_total: total,
    },
    episodes: servers,
    slug,
  };
}

async function nguoncDetail(slug) {
  // Ưu tiên tuyệt đối cache: runner không gọi NguonC khi đã có detail trong file.
  const cached = getNcDetail(slug);
  if (cached) return normalizeNcDetail(cached, slug);
  try {
    const d = await fetchJson(`${NGUONC_BASE}/film/${encodeURIComponent(slug)}`, 15000, "https://phim.nguonc.com/");
    return normalizeNcDetail(d, slug);
  } catch (e) {
    console.warn("  NguonC detail lỗi:", e.message);
    return { movie: null, episodes: [], slug, error: true };
  }
}

// ---------- KKPhim ----------
async function kkSearch(keyword) {
  try {
    const d = await fetchJson(`${KKPHIM_BASE}/v1/api/tim-kiem?keyword=${encodeURIComponent(keyword)}`, 15000, "https://phimapi.com/");
    return d?.data?.items || [];
  } catch (e) {
    console.warn("  KKPhim search lỗi:", e.message);
    return [];
  }
}
async function kkDetail(slug) {
  try {
    const d = await fetchJson(`${KKPHIM_BASE}/phim/${slug}`, 15000, "https://phimapi.com/");
    if (!d?.movie) return { movie: null, episodes: [] };
    return {
      movie: {
        // Lưu ý: field "poster_url" của KKPhim mới thật sự là ảnh poster (dọc),
        // còn "thumb_url" của họ là ảnh backdrop/thumb (ngang) — ưu tiên poster_url trước.
        thumb_url: d.movie.poster_url || d.movie.thumb_url || "",
        country: d.movie.country || [],
        episode_current: d.movie.episode_current || "",
        episode_total: parseInt(d.movie.episode_total) || 0,
      },
      episodes: (d.episodes || []).map((sv) => ({
        server_name: sv.server_name || "KKPhim Server",
        server_data: (sv.server_data || []).map((ep) => ({
          name: ep.name || "", link_embed: ep.link_embed || "", link_m3u8: ep.link_m3u8 || "",
        })),
      })),
    };
  } catch (e) {
    console.warn("  KKPhim detail lỗi:", e.message);
    return { movie: null, episodes: [] };
  }
}
// Chỉ nhận kết quả search KHỚP ĐÚNG TÊN (tên hoặc tên gốc) — tuyệt đối không lấy
// đại items[0] khi không khớp, vì tên chung chung (vd "Lời Nói Dối Hoàn Hảo") rất
// dễ trùng với phim khác hẳn (khác quốc gia, khác nội dung) trên KKPhim/VodPhim.
function pickBestMatch(items, m) {
  const q1 = normalizeStr((m.titleen || m.title || "").trim());
  const q2 = normalizeStr((m.title || "").trim());
  return items.find((it) => {
    const n = normalizeStr(it.name || "");
    const o = normalizeStr(it.origin_name || "");
    return (q1 && (n === q1 || o === q1)) || (q2 && (n === q2 || o === q2));
  }) || null;
}
// Kiểm tra quốc gia phim tìm được trên nguồn có khớp với quốc gia đã lưu trong DB
// không (nếu cả 2 bên đều có thông tin) — bắt được trường hợp trùng tên nhưng
// khác quốc gia (remake) mà vẫn lọt qua bước khớp tên ở trên.
function countryMatches(dbCountryCode, sourceCountryArr) {
  if (!dbCountryCode) return true; // DB chưa rõ quốc gia → không chặn
  if (!sourceCountryArr || !sourceCountryArr.length) return true; // nguồn không có info → không chặn
  return sourceCountryArr.some((c) => COUNTRY_IMPORT_MAP[(c.name || "").toLowerCase()] === dbCountryCode);
}
async function getKKFullData(m) {
  const titleEn = (m.titleen || "").trim();
  const titleVi = (m.title || "").trim();
  const title = titleEn || titleVi;
  if (!title) return { movie: null, serverData: [] };
  let items = await kkSearch(title);
  if (!items.length && titleVi && titleVi !== title) items = await kkSearch(titleVi);
  if (!items.length) return { movie: null, serverData: [] };
  const pick = pickBestMatch(items, m);
  if (!pick) { console.warn(`  KKPhim: có kết quả tìm kiếm nhưng không khớp đúng tên "${title}" → bỏ qua, tránh gắn nhầm phim`); return { movie: null, serverData: [] }; }
  const detail = await kkDetail(pick.slug);
  if (!detail.movie) return { movie: null, serverData: [] };
  if (!countryMatches(m.country, detail.movie.country)) {
    console.warn(`  KKPhim: tên khớp nhưng QUỐC GIA không khớp (phim "${detail.movie.name}") → bỏ qua, tránh nhầm phim remake`);
    return { movie: null, serverData: [] };
  }
  return { movie: detail.movie, serverData: pickVietsubServerData(detail.episodes) };
}

// ---------- VodPhim (api.xink.pro) — nguồn cho Server 3 (SV3) ----------
async function vpSearch(keyword) {
  try {
    const d = await fetchJson(`${VODPHIM_BASE}/tim-kiem?q=${encodeURIComponent(keyword)}&page=1&limit=24`, 15000, "https://vodphim.com/");
    return (d?.items || []).map((it) => ({
      name: it.name || "",
      origin_name: it.origin_name || "",
      slug: it.slug || "",
      year: it.year || "",
      thumb_url: it.poster_url || it.thumb_url || "", // VodPhim ngược field giống KKPhim
    }));
  } catch (e) {
    console.warn("  VodPhim search lỗi:", e.message);
    return [];
  }
}
async function vpDetail(slug) {
  try {
    const d = await fetchJson(`${VODPHIM_BASE}/phim/${encodeURIComponent(slug)}`, 15000, "https://vodphim.com/");
    const m = d?.movie;
    if (!m) return { movie: null, episodes: [] };
    return {
      movie: {
        name: m.name || "",
        origin_name: m.origin_name || "",
        content: m.content || "",
        year: m.year || "",
        type: m.type === "single" || m.type === "movie" || m.type === "theater" ? "single" : "series",
        // Lưu ý: giống KKPhim, VodPhim cũng đặt tên field ảnh NGƯỢC so với NguonC —
        // "poster_url" của họ mới thật sự là ảnh poster (dọc), "thumb_url" là backdrop
        // (ngang). Trước đây code lấy thumb_url làm poster → bị lộn ảnh. Sửa lại:
        thumb_url: m.poster_url || m.thumb_url || "",       // ảnh poster thật (dọc)
        backdrop_url: m.thumb_url || m.poster_url || "",    // ảnh backdrop thật (ngang)
        lang: m.lang || "",
        country: m.country || [],
        category: m.category || [],
        episode_current: m.episode_current || "",
        episode_total: parseInt(m.episode_total) || (d.episodes?.[0]?.server_data?.length || 0),
      },
      episodes: (d.episodes || []).map((sv) => ({
        server_name: sv.server_name || "VodPhim Server",
        server_data: (sv.server_data || []).map((ep) => ({
          // VodPhim trả tên tập trong field "filename" (vd "Tập 1"), "name" thường chỉ là số thứ tự
          name: ep.filename || ep.name || "",
          link_embed: ep.link_embed || "",
          link_m3u8: "",
        })),
      })),
    };
  } catch (e) {
    console.warn("  VodPhim detail lỗi:", e.message);
    return { movie: null, episodes: [] };
  }
}

// Quét danh sách phim theo quốc gia trên VodPhim (dùng cho auto-add phim mới).
// LƯU Ý: endpoint "/quoc-gia/{slug}" theo đúng chuẩn phổ biến của các site cùng
// họ Ophim-clone mà VodPhim đang dùng, nhưng chưa gọi thử trực tiếp được từ môi
// trường này (domain api.xink.pro không trong whitelist mạng của sandbox) — nếu
// chạy DRY_RUN mà thấy "0 phim" liên tục dù chắc chắn có phim mới, gửi log lại
// để chỉnh đúng endpoint.
async function vpCountryList(countrySlug, page) {
  try {
    const d = await fetchJson(`${VODPHIM_BASE}/quoc-gia/${encodeURIComponent(countrySlug)}?page=${page}`, 15000, "https://vodphim.com/");
    const items = d?.items || d?.data?.items || [];
    return items.map((it) => ({
      name: it.name || "",
      origin_name: it.origin_name || "",
      slug: it.slug || "",
      year: it.year || "",
    }));
  } catch (e) {
    console.warn(`  VodPhim quốc gia(${countrySlug}) trang ${page} lỗi:`, e.message);
    return [];
  }
}
async function getVPFullData(m) {
  const titleEn = (m.titleen || "").trim();
  const titleVi = (m.title || "").trim();
  const title = titleEn || titleVi;
  if (!title) return { movie: null, serverData: [] };
  let items = await vpSearch(title);
  if (!items.length && titleVi && titleVi !== title) items = await vpSearch(titleVi);
  if (!items.length) return { movie: null, serverData: [] };
  const pick = pickBestMatch(items, m);
  if (!pick) { console.warn(`  VodPhim: có kết quả tìm kiếm nhưng không khớp đúng tên "${title}" → bỏ qua, tránh gắn nhầm phim`); return { movie: null, serverData: [] }; }
  const detail = await vpDetail(pick.slug);
  if (!detail.movie) return { movie: null, serverData: [] };
  if (!countryMatches(m.country, detail.movie.country)) {
    console.warn(`  VodPhim: tên khớp nhưng QUỐC GIA không khớp (phim "${detail.movie.name}") → bỏ qua, tránh nhầm phim remake`);
    return { movie: null, serverData: [] };
  }
  return { movie: detail.movie, serverData: pickVietsubServerData(detail.episodes) };
}

// Tìm slug NguonC theo tên (chỉ nhận khớp tên CHÍNH XÁC, giống bản trên web)
async function findNguoncSlugByTitle(m) {
  const title = (m.title || m.titleen || "").trim();
  if (!title) return null;
  const items = await nguoncSearch(title, 10);
  if (!items.length) return null;
  const q = normalizeStr(title);
  const yearNum = parseInt(m.year) || 0;
  let matches = items.filter((it) => normalizeStr(it.name) === q || normalizeStr(it.origin_name) === q);
  if (matches.length > 1 && yearNum) {
    const byYear = matches.filter((it) => parseInt(it.year) === yearNum);
    if (byYear.length) matches = byYear;
  }
  return matches[0] ? matches[0].slug : null;
}

// Dữ liệu SV1 (NguonC). Slug lấy từ DB/cache — không search trên runner vì bị chặn,
// và cũng không bao giờ dùng link KKPhim/VodPhim để thay cho link NguonC.
async function getNCFullData(m) {
  const slug = findNcSlugFromCache(m);
  if (!slug) return { movie: null, serverData: [], slug: "" };
  const detail = await nguoncDetail(slug);
  if (!detail.movie) return { movie: null, serverData: [], slug };
  if (!countryMatches(m.country, detail.movie.country)) {
    console.warn(`  NguonC: tên khớp nhưng QUỐC GIA không khớp (phim "${detail.movie.name}") → bỏ qua`);
    return { movie: null, serverData: [], slug };
  }
  return { movie: detail.movie, serverData: pickVietsubServerData(detail.episodes), slug };
}

// ---------- Supabase ----------
const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: "Bearer " + SB_KEY,
  "Content-Type": "application/json",
};

async function loadSeries() {
  const cols = "id,title,titleen,year,type,ep,poster,episodes,totalep,currentep,epstatus,ophim_slug,country,extra";
  const PAGE = 500;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SB_URL}/rest/v1/movies?select=${cols}&order=id.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) throw new Error(`Đọc bảng movies lỗi: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  // Giống web: chỉ phim bộ, chưa "Hoàn thành"
  return out.filter((m) => m.type !== "movie" && m.epstatus !== "Hoàn thành");
}

// Phim bộ ĐÃ "Hoàn thành" nhưng còn tập thiếu link/link2/link3 (vì lúc đó server
// tương ứng chưa có). loadSeries() ở trên không quét lại các phim này vì chúng đã
// "Hoàn thành" — nên cần vòng riêng.
// (Phim lẻ "type=movie" không dùng mảng episodes[] nên không nằm trong phạm vi này.)
async function loadMissingSVTargets() {
  const cols = "id,title,titleen,year,type,episodes,epstatus,country,ophim_slug,extra";
  const PAGE = 500;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SB_URL}/rest/v1/movies?select=${cols}&order=id.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) throw new Error(`Đọc bảng movies (thiếu link 3 server) lỗi: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out.filter((m) => {
    if (m.type === "movie" || m.epstatus !== "Hoàn thành") return false;
    const eps = parseEpisodes(m.episodes);
    return eps.length > 0 && eps.some((e) => !e.link || !e.link2 || !e.link3);
  });
}

function parseEpisodes(raw) {
  try {
    const e = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(e) ? e : [];
  } catch { return []; }
}

async function patchMovie(id, fields) {
  if (DRY_RUN) { console.log("  [DRY_RUN] sẽ ghi:", Object.keys(fields).join(", ")); return true; }
  const r = await fetch(`${SB_URL}/rest/v1/movies?id=eq.${id}`, {
    method: "PATCH", headers: { ...SB_HEADERS, Prefer: "return=minimal" }, body: JSON.stringify(fields),
  });
  if (!r.ok) { console.warn("  Ghi DB lỗi:", r.status, await r.text()); return false; }
  return true;
}

async function pushNotifs(items) {
  if (!items.length) return;
  if (DRY_RUN) { console.log("[DRY_RUN] sẽ tạo thông báo:", items.map((i) => `${i.title} ${i.ep}`).join(" | ")); return; }
  const r = await fetch(`${SB_URL}/rest/v1/ep_notifs`, {
    method: "POST", headers: { ...SB_HEADERS, Prefer: "return=minimal" }, body: JSON.stringify(items),
  });
  if (!r.ok) console.warn("Lỗi lưu ep_notifs:", r.status, await r.text());
}

// ---------- Gộp 3 server của CÙNG MỘT phim ----------
// Khớp tập theo SỐ TẬP (rút từ "Tập 5"/"5"), không theo vị trí mảng — 3 nguồn
// có thể lệch số tập đầu. Mỗi nguồn CHỈ được phép điền đúng cột của nó:
// NguonC -> link, KKPhim -> link2, VodPhim -> link3. Không mượn link chéo.
function mergeAllSourceEpisodes(oldEps, sources) {
  const byNum = new Map();
  const ensure = (num, name, base) => {
    if (!byNum.has(num)) {
      byNum.set(num, {
        ...(base || {}),
        name: (base && base.name) || name || `Tập ${num}`,
        link: (base && base.link) || "",
        link2: (base && base.link2) || "",
        link3: (base && base.link3) || "",
      });
    }
    return byNum.get(num);
  };

  // Tập cũ là khung: giữ nguyên tên/link đã lưu, kể cả khi nguồn trả ít tập hơn.
  (oldEps || []).forEach((e, i) => {
    if (!e || !e.name) return;
    ensure(extractEpNum(e.name) || i + 1, e.name, e);
  });

  const fill = (serverData, slot) => {
    (serverData || []).forEach((ep, i) => {
      const num = extractEpNum(ep.name) || i + 1;
      const target = ensure(num, ep.name);
      const link = slot === "link" ? (ep.link || ep.link_embed || "") : (ep.link_embed || "");
      if (link && !target[slot]) target[slot] = link;
    });
  };
  fill(sources.nc && sources.nc.serverData, "link");
  fill(sources.kk && sources.kk.serverData, "link2");
  fill(sources.vp && sources.vp.serverData, "link3");

  const episodes = [...byNum.values()];
  if (episodes.length && episodes.every((x) => extractEpNum(x.name) > 0)) {
    episodes.sort((a, b) => extractEpNum(a.name) - extractEpNum(b.name));
  }
  return episodes;
}

// Metadata chung lấy theo server có NHIỀU TẬP NHẤT. maxNum (tập cũ + 3 server)
// chỉ để tránh ghi "Tập 13/6" khi 1 nguồn trả thiếu tập đã lưu.
function buildAllSourcesUpdate(m, sources) {
  const oldEpisodes = parseEpisodes(m.episodes);
  const episodes = mergeAllSourceEpisodes(oldEpisodes, sources);
  const leaders = [
    { src: "NguonC", movie: sources.nc && sources.nc.movie, len: (sources.nc && sources.nc.serverData || []).length },
    { src: "KKPhim", movie: sources.kk && sources.kk.movie, len: (sources.kk && sources.kk.serverData || []).length },
    { src: "VodPhim", movie: sources.vp && sources.vp.movie, len: (sources.vp && sources.vp.serverData || []).length },
  ].filter((x) => x.movie && x.len > 0).sort((a, b) => b.len - a.len);
  const leader = leaders[0] || { src: "", movie: null, len: 0 };

  const maxNum = episodes.reduce((mx, e) => Math.max(mx, extractEpNum(e.name) || 0), 0);
  const curText = (leader.movie && leader.movie.episode_current) || "";
  const curNum = Math.max(extractEpNum(curText) || 0, leader.len, maxNum);
  const totalEp = Math.max(
    parseInt(leader.movie && leader.movie.episode_total) || 0,
    leader.len,
    maxNum
  );
  const epStatus = /hoàn|full/i.test(curText) ? "Hoàn thành" : "Đang chiếu";
  const ep = epStatus === "Hoàn thành"
    ? "Full " + (totalEp || "") + (totalEp ? " tập" : "")
    : "Tập " + curNum + (totalEp ? "/" + totalEp : "");

  const fields = {
    episodes: JSON.stringify(episodes),
    currentep: curNum || null,
    epstatus: epStatus,
    ep,
    totalep: totalEp || null,
  };
  return {
    fields,
    curNum,
    ep,
    hasNewEp: curNum > (parseInt(m.currentep) || 0),
    metaFrom: leader.src,
    filled: {
      link: episodes.filter((e) => e.link).length,
      link2: episodes.filter((e) => e.link2).length,
      link3: episodes.filter((e) => e.link3).length,
    },
    total: episodes.length,
  };
}

async function syncFromAllSources(m) {
  const nc = await getNCFullData(m);
  const kk = await getKKFullData(m);
  const vp = await getVPFullData(m);

  const ncNote = nc.slug ? (getNcDetail(nc.slug) ? " từ cache" : "") : "";
  console.log(`  SV1 (NguonC): ${nc.serverData.length ? `khớp phim, ${nc.serverData.length} tập${ncNote}` : "không có dữ liệu"}`);
  console.log(`  SV2 (KKPhim): ${kk.serverData.length ? `khớp phim, ${kk.serverData.length} tập` : "không tìm thấy"}`);
  console.log(`  SV3 (VodPhim): ${vp.serverData.length ? `khớp phim, ${vp.serverData.length} tập` : "không tìm thấy"}`);

  if (!nc.serverData.length && !kk.serverData.length && !vp.serverData.length) return null;

  const result = buildAllSourcesUpdate(m, { nc, kk, vp });
  console.log(
    `  → Gộp ${result.total} tập | điền link: ${result.filled.link}, link2: ${result.filled.link2}, link3: ${result.filled.link3} | metadata: ${result.metaFrom || "DB"}`
  );
  return result;
}

// ---------- Sửa ảnh poster bị lỗi ----------
async function loadAllMoviesForPosterCheck() {
  const cols = "id,title,titleen,year,poster,ophim_slug,country,extra";
  const PAGE = 500;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SB_URL}/rest/v1/movies?select=${cols}&order=id.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) throw new Error(`Đọc bảng movies (check poster) lỗi: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Kiểm tra URL ảnh có load được không.
// Lưu ý: nhiều CDN ảnh phim không hỗ trợ HEAD đúng chuẩn (trả 400/404/5xx dù ảnh
// vẫn sống) nên dùng GET cho chắc, nhưng hủy tải phần body ngay sau khi có header
// để không tốn băng thông tải cả ảnh. Trả về:
//   "ok"      — ảnh còn sống
//   "broken"  — chắc chắn chết (404/410: tài nguyên không còn tồn tại)
//   "unknown" — lỗi mơ hồ (403/429/5xx/timeout/mạng...) — CÓ THỂ do IP máy chủ
//               Actions bị CDN chặn tạm thời chứ không hẳn ảnh hỏng, không nên
//               coi là lỗi thật để tránh ghi đè nhầm poster đang chạy tốt.
async function checkImageOk(url) {
  if (!url) return "broken";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { ...BROWSER_HEADERS, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
      redirect: "follow",
    });
    try { await r.body?.cancel(); } catch {}
    if (r.ok) return "ok";
    if (r.status === 404 || r.status === 410) return "broken";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(t);
  }
}

// Tìm ảnh poster thay thế: ưu tiên NguonC (nếu có slug) → KKPhim → VodPhim
async function findReplacementPoster(m) {
  const title = (m.titleen || m.title || "").trim();
  if (!title) return "";

  // KKPhim và VodPhim thử trước — NguonC để cuối cùng vì hay bị chặn bot, ít khi dùng được.
  // Chỉ lấy ảnh khi khớp ĐÚNG TÊN và ĐÚNG QUỐC GIA — tránh lấy nhầm poster của
  // phim trùng tên khác quốc gia (remake).
  try {
    const items = await kkSearch(title);
    const pick = pickBestMatch(items, m);
    if (pick) {
      const { movie } = await kkDetail(pick.slug);
      if (movie?.thumb_url && countryMatches(m.country, movie.country)) return movie.thumb_url;
    }
  } catch {}

  try {
    const items = await vpSearch(title);
    const pick = pickBestMatch(items, m);
    if (pick) {
      const { movie } = await vpDetail(pick.slug);
      if (movie?.thumb_url && countryMatches(m.country, movie.country)) return movie.thumb_url;
    }
  } catch {}

  try {
    const slug = findNcSlugFromCache(m);
    if (slug) {
      const { movie } = await nguoncDetail(slug);
      if (movie?.thumb_url) return movie.thumb_url;
    }
  } catch {}

  return "";
}

async function runWithConcurrency(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

async function fixBrokenPosters() {
  console.log(`\nRà soát ảnh poster...`);
  const all = await loadAllMoviesForPosterCheck();
  let checked = 0, broken = 0, unknown = 0, fixed = 0;
  // Concurrency thấp hơn + có khoảng nghỉ nhỏ để không bị CDN ảnh coi là bot rồi chặn hàng loạt
  await runWithConcurrency(all, 4, async (m) => {
    checked++;
    const status = await checkImageOk(m.poster);
    if (status === "ok") return;
    if (status === "unknown") {
      unknown++;
      console.warn(`  ? Không chắc (có thể do mạng/CDN chặn tạm): [${m.id}] ${m.title} — bỏ qua, không sửa`);
      return;
    }
    // status === "broken": chắc chắn ảnh không còn tồn tại (404/410)
    broken++;
    console.warn(`  ✗ Ảnh chết hẳn: [${m.id}] ${m.title}`);
    const replacement = await findReplacementPoster(m);
    if (replacement && replacement !== m.poster) {
      if (await patchMovie(m.id, { poster: replacement })) {
        fixed++;
        console.log(`    ✓ Đã thay poster mới`);
      }
    } else {
      console.warn(`    ✗ Không tìm được ảnh thay thế`);
    }
    await sleep(200);
  });
  console.log(`Poster: kiểm tra ${checked}, chết hẳn ${broken} (đã sửa ${fixed}), không chắc/bỏ qua ${unknown}.`);
}

// ---------- Bổ sung link còn thiếu cho cả 3 server của phim ĐÃ hoàn thành ----------
// Chỉ điền vào ô đang trống của đúng server (link/link2/link3), giữ nguyên tên tập,
// currentep/epstatus/ep/totalep — vì phim đã xong rồi, không tính lại metadata.
async function backfillAllServers(m) {
  const oldEpisodes = parseEpisodes(m.episodes);
  if (!oldEpisodes.length) return null;
  const needLink = oldEpisodes.some((e) => !e.link);
  const needLink2 = oldEpisodes.some((e) => !e.link2);
  const needLink3 = oldEpisodes.some((e) => !e.link3);
  if (!needLink && !needLink2 && !needLink3) return null;

  const empty = { movie: null, serverData: [], slug: "" };
  const nc = needLink ? await getNCFullData(m) : empty;
  const kk = needLink2 ? await getKKFullData(m) : empty;
  const vp = needLink3 ? await getVPFullData(m) : empty;

  if (needLink) console.log(`  SV1 (NguonC, backfill): ${nc.serverData.length ? `khớp phim, ${nc.serverData.length} tập` : "không có dữ liệu"}`);
  if (needLink2) console.log(`  SV2 (KKPhim, backfill): ${kk.serverData.length ? `khớp phim, ${kk.serverData.length} tập` : "không tìm thấy"}`);
  if (needLink3) console.log(`  SV3 (VodPhim, backfill): ${vp.serverData.length ? `khớp phim, ${vp.serverData.length} tập` : "không tìm thấy"}`);

  const episodes = mergeAllSourceEpisodes(oldEpisodes, { nc, kk, vp });
  const changed = episodes.some((e, i) => {
    const num = extractEpNum(e.name);
    const old = (num && oldEpisodes.find((x) => extractEpNum(x.name) === num)) || oldEpisodes[i] || {};
    return ["link", "link2", "link3"].some((k) => (old[k] || "") !== (e[k] || ""));
  });
  if (!changed) return null;
  return { fields: { episodes: JSON.stringify(episodes) } };
}

async function backfillMissingServers() {
  console.log(`\nKiểm tra phim đã hoàn thành còn thiếu link (cả 3 server)...`);
  const list = await loadMissingSVTargets();
  console.log(`Có ${list.length} phim cần bổ sung.`);
  let fixedCount = 0, failed = 0;
  for (let idx = 0; idx < list.length; idx++) {
    const m = list[idx];
    console.log(`[Backfill ${idx + 1}/${list.length}] ${m.title}`);
    try {
      const result = await backfillAllServers(m);
      if (!result) { console.log("  = Không bổ sung được gì mới"); await sleep(200); continue; }
      if (await patchMovie(m.id, result.fields)) {
        fixedCount++;
        console.log("  ✓ Đã bổ sung link còn thiếu");
      } else failed++;
    } catch (e) {
      console.warn("  Lỗi:", e.message);
      failed++;
    }
    await sleep(350);
  }
  console.log(`Backfill 3 server: đã bổ sung cho ${fixedCount}/${list.length} phim, ${failed} lỗi.`);
}

// ---------- Tự thêm phim mới (hiện chỉ phim Hàn Quốc, nguồn VodPhim) ----------

// Lấy "chữ ký" title+year của mọi phim đang có trong DB để dò trùng trước khi thêm mới
async function loadExistingTitleKeys() {
  const cols = "id,title,titleen,year,series_group,part_number";
  const PAGE = 1000;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SB_URL}/rest/v1/movies?select=${cols}&order=id.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) throw new Error(`Đọc bảng movies (check trùng tên) lỗi: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    rows.forEach((m) => {
      out.push({
        id: m.id,
        title: m.title || "",
        titleen: m.titleen || "",
        titleKey: dedupKey(m.title || ""),
        titleEnKey: dedupKey(m.titleen || ""),
        year: parseInt(m.year) || 0,
        series_group: m.series_group || "",
        part_number: parseInt(m.part_number) || 0,
      });
    });
    if (rows.length < PAGE) break;
  }
  return out;
}

// Nhận diện "Mùa N" / "Phần N" / "Season N" trong tên phim (VodPhim hay ghi kiểu
// "[Mùa 2] Tên Phim") → tách ra số phần + tên gốc (không còn tiền tố) để tìm phim
// Phần 1 đã có trong DB và gộp nhóm. Không khớp được thì trả về null — không cố
// đoán mò để tránh gộp nhầm 2 phim không liên quan.
function detectSeasonMarker(title) {
  if (!title) return null;
  const patterns = [
    /\[\s*(?:mùa|mua|season|phần|phan)\s*(\d+)\s*\]/i,
    /\(\s*(?:mùa|mua|season|phần|phan)\s*(\d+)\s*\)/i,
    /\b(?:mùa|mua|season|phần|phan)\s*(\d+)\b/i,
  ];
  for (const re of patterns) {
    const m = title.match(re);
    if (m) {
      const partNum = parseInt(m[1]);
      if (!partNum) continue;
      const baseTitle = title.replace(re, " ").replace(/\s{2,}/g, " ").trim().replace(/^[-:–\s]+|[-:–\s]+$/g, "").trim();
      if (baseTitle) return { partNum, baseTitle };
    }
  }
  return null;
}

// Tìm phim đã có trong DB khớp với tên gốc (sau khi bỏ "[Mùa N]") — dùng để gộp
// nhóm phần với phim mới import. Ưu tiên phim đã có sẵn series_group (gộp đúng
// nhóm hiện có), gần năm nhất nếu có nhiều ứng viên.
function findSiblingForGroup(baseTitle, year, existingList) {
  const bt = dedupKey(baseTitle);
  if (!bt) return null;
  const candidates = existingList.filter((e) => keysMatch(bt, e.titleKey) || keysMatch(bt, e.titleEnKey));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ag = a.series_group ? 0 : 1, bg = b.series_group ? 0 : 1;
    if (ag !== bg) return ag - bg;
    return Math.abs((a.year || 0) - (year || 0)) - Math.abs((b.year || 0) - (year || 0));
  });
  return candidates[0];
}

// Dựng payload tạo phim mới từ dữ liệu VodPhim (theo đúng cấu trúc saveMovieToDB trong web admin)
// groupInfo (nếu có): { seriesGroup, partNumber } — tự nhận từ detectSeasonMarker + findSiblingForGroup
function buildNewMovieFromVP(movie, groupInfo) {
  const isSingle = movie.type === "single";
  const genres = (movie.category || []).map((g) => GENRE_IMPORT_MAP[(g.name || "").toLowerCase()]).filter(Boolean);
  const countryName = (movie.country?.[0]?.name || "").toLowerCase();
  // Mặc định "kr" vì đang quét theo quốc gia Hàn, phòng khi VodPhim không trả field country
  const countryVal = COUNTRY_IMPORT_MAP[countryName] || "kr";
  const lang = (movie.lang || "").toLowerCase();
  const sub = lang.includes("thuyết minh") || lang.includes("lồng tiếng") ? "Thuyết minh" : "Vietsub";

  const payload = {
    title: movie.name,
    titleen: movie.origin_name || "",
    year: movie.year || "",
    genre: genres.join(","),
    country: countryVal,
    type: isSingle ? "movie" : "series",
    rating: "N/A",
    sub,
    poster: movie.thumb_url || "",
    backdrop: movie.backdrop_url || null,
    description: (movie.content || "").replace(/<[^>]*>/g, ""),
    videosource: null,
    // Chưa biết slug NguonC — để trống, lần sync chính tiếp theo sẽ tự tìm & gắn vào
    ophim_slug: null,
    series_group: groupInfo ? groupInfo.seriesGroup : null,
    part_number: groupInfo ? groupInfo.partNumber : null,
  };

  if (isSingle) {
    const sd = pickVietsubServerData(movie._episodes)[0];
    payload.embedurl = null;
    payload.embedurl2 = null;
    payload.embedurl3 = sd?.link_embed || "";
    payload.ep = "Full";
    payload.episodes = null;
    payload.totalep = null;
    payload.currentep = null;
    payload.epstatus = null;
  } else {
    const serverData = pickVietsubServerData(movie._episodes);
    const eps = serverData.map((ep, i) => ({
      name: ep.name || "Tập " + (i + 1),
      link: "", link2: "", link3: ep.link_embed || "",
    }));
    const curNum = extractEpNum(movie.episode_current) || eps.length;
    const totalEp = parseInt(movie.episode_total) || eps.length;
    const low = (movie.episode_current || "").toLowerCase();
    const epStatus = low.includes("hoàn") || low.includes("full") ? "Hoàn thành" : "Đang chiếu";
    payload.episodes = JSON.stringify(eps);
    payload.totalep = totalEp || null;
    payload.currentep = curNum || null;
    payload.epstatus = epStatus;
    payload.ep = epStatus === "Hoàn thành" ? "Full" + (totalEp ? " " + totalEp + " tập" : "") : "Tập " + curNum + (totalEp ? "/" + totalEp : "");
  }
  return payload;
}

async function insertMovie(payload) {
  if (DRY_RUN) { console.log(`  [DRY_RUN] sẽ thêm phim mới: ${payload.title} (${payload.type})`); return true; }
  const r = await fetch(`${SB_URL}/rest/v1/movies`, {
    method: "POST", headers: { ...SB_HEADERS, Prefer: "return=minimal" }, body: JSON.stringify(payload),
  });
  if (!r.ok) { console.warn("  Thêm phim lỗi:", r.status, await r.text()); return false; }
  return true;
}

async function autoAddNewMoviesByCountry() {
  console.log(`\nQuét phim mới từ VodPhim (quốc gia: ${AUTO_ADD_COUNTRY_SLUG}, ${AUTO_ADD_PAGES} trang, chỉ lấy từ năm ${AUTO_ADD_MIN_YEAR} trở lên)...`);
  const existing = await loadExistingTitleKeys();
  let scanned = 0, added = 0, skippedDup = 0, skippedYear = 0, failed = 0;
  for (let page = 1; page <= AUTO_ADD_PAGES; page++) {
    const items = await vpCountryList(AUTO_ADD_COUNTRY_SLUG, page);
    if (!items.length) { console.log(`  Trang ${page}: không có dữ liệu, dừng quét.`); break; }
    for (const it of items) {
      scanned++;
      // Lọc theo năm ngay ở bước danh sách nếu có sẵn year (đỡ phải gọi detail
      // cho phim rõ ràng quá cũ). Nếu list không có year thì để detail quyết.
      const listYear = parseInt(it.year) || 0;
      if (listYear && listYear < AUTO_ADD_MIN_YEAR) {
        skippedYear++;
        continue;
      }
      if (isDuplicateMovie(it.name, it.origin_name, it.year, existing)) {
        console.log(`  = Đã có trong DB, bỏ qua: ${it.name}`);
        skippedDup++;
        continue;
      }
      try {
        const { movie, episodes } = await vpDetail(it.slug);
        if (!movie) { failed++; await sleep(200); continue; }
        movie._episodes = episodes;
        const detailYear = parseInt(movie.year) || 0;
        if (detailYear && detailYear < AUTO_ADD_MIN_YEAR) {
          console.log(`  - Bỏ qua (năm ${detailYear} < ${AUTO_ADD_MIN_YEAR}): ${movie.name}`);
          skippedYear++;
          await sleep(200);
          continue;
        }
        // Kiểm tra lại lần nữa bằng dữ liệu detail đầy đủ (title/năm chi tiết có
        // thể khác với dữ liệu rút gọn ở trang danh sách)
        if (isDuplicateMovie(movie.name, movie.origin_name, movie.year, existing)) {
          console.log(`  = Đã có trong DB (khớp sau khi xem chi tiết), bỏ qua: ${movie.name}`);
          skippedDup++;
          continue;
        }

        // Nhận diện "[Mùa N]"/"Phần N" trong tên → tìm phim gốc đã có trong DB
        // để gộp nhóm phần (series_group/part_number)
        let groupInfo = null;
        let sibling = null;
        const seasonInfo = detectSeasonMarker(movie.name) || detectSeasonMarker(movie.origin_name || "");
        if (seasonInfo) {
          sibling = findSiblingForGroup(seasonInfo.baseTitle, movie.year, existing);
          if (sibling) {
            groupInfo = {
              seriesGroup: sibling.series_group || sibling.title,
              partNumber: seasonInfo.partNum,
            };
            console.log(`  ↳ Nhận diện Phần ${seasonInfo.partNum} của "${sibling.title}" → gộp nhóm "${groupInfo.seriesGroup}"`);
          }
        }

        const payload = buildNewMovieFromVP(movie, groupInfo);
        console.log(`  + Phim mới: ${payload.title} (${payload.type}, ${movie.year || "?"})`);
        if (await insertMovie(payload)) {
          added++;
          existing.push({
            id: null,
            title: payload.title,
            titleen: payload.titleen,
            titleKey: dedupKey(payload.title),
            titleEnKey: dedupKey(payload.titleen),
            year: parseInt(payload.year) || 0,
            series_group: payload.series_group || "",
            part_number: payload.part_number || 0,
          });
          // Phim gốc (Phần 1) thường chưa từng có series_group (vì tính năng này
          // trước giờ chỉ gán tay) — ghi ngược series_group vào phim gốc để 2 phần
          // thực sự được gộp chung nhóm trên web, không chỉ phim mới có.
          if (sibling && !sibling.series_group && sibling.id) {
            const siblingFields = { series_group: groupInfo.seriesGroup, part_number: sibling.part_number || 1 };
            if (await patchMovie(sibling.id, siblingFields)) {
              sibling.series_group = groupInfo.seriesGroup;
              sibling.part_number = sibling.part_number || 1;
              console.log(`    ✓ Đã gán series_group cho phim gốc "${sibling.title}" (id=${sibling.id})`);
            }
          }
        } else failed++;
      } catch (e) {
        console.warn(`  Lỗi khi thêm "${it.name}":`, e.message);
        failed++;
      }
      await sleep(300);
    }
  }
  console.log(`Auto-add (${AUTO_ADD_COUNTRY_SLUG}, >= ${AUTO_ADD_MIN_YEAR}): quét ${scanned}, thêm mới ${added}, trùng bỏ qua ${skippedDup}, năm cũ bỏ qua ${skippedYear}, lỗi ${failed}.`);
}

// ---------- main ----------
async function main() {
  console.log(`Bắt đầu sync${DRY_RUN ? " (DRY RUN)" : ""} — ${new Date().toISOString()}`);

  if (!SKIP_AUTO_ADD) {
    try {
      await autoAddNewMoviesByCountry();
    } catch (e) {
      console.error("Lỗi khi tự thêm phim mới:", e.message);
    }
  }

  const targets = await loadSeries();
  console.log(`Có ${targets.length} phim bộ đang chiếu cần kiểm tra.`);

  let success = 0, failed = 0, notFound = 0;
  const notifs = [];

  for (let idx = 0; idx < targets.length; idx++) {
    const m = targets[idx];
    console.log(`[${idx + 1}/${targets.length}] ${m.title}`);
    try {
      // 3 server riêng biệt: NguonC -> link, KKPhim -> link2, VodPhim -> link3.
      const result = await syncFromAllSources(m);

      if (!result) { notFound++; await sleep(350); continue; }

      if (await patchMovie(m.id, result.fields)) {
        success++;
        if (result.hasNewEp) {
          console.log(`  ✓ Tập mới: ${m.currentep || 0} → ${result.curNum}`);
          notifs.push({ title: m.title, ep: result.ep, poster: m.poster || "", created_at: new Date().toISOString() });
        } else {
          console.log("  = Không có tập mới");
        }
      } else failed++;
    } catch (e) {
      console.warn("  Lỗi:", e.message);
      failed++;
    }
    await sleep(350);
  }

  await pushNotifs(notifs);
  console.log(`Xong! Cập nhật ${success} phim, ${notifs.length} phim có tập mới, ${notFound} chưa có link, ${failed} lỗi.`);

  if (!SKIP_BACKFILL_SV) {
    try {
      await backfillMissingServers();
    } catch (e) {
      console.error("Lỗi khi backfill 3 server cho phim đã hoàn thành:", e.message);
    }
  }

  if (!SKIP_POSTER_FIX) {
    try {
      await fixBrokenPosters();
    } catch (e) {
      console.error("Lỗi khi rà soát/sửa poster:", e.message);
    }
  }

  // Chỉ báo fail cả job khi lỗi quá nhiều (để GitHub gửi email cảnh báo)
  if (targets.length && failed > targets.length / 2) process.exit(1);
}

// Khi được require() từ scripts/auto-sync.js thì KHÔNG tự chạy main() — script
// nền chỉ mượn các helper ở đây để sync đúng phim vừa đổi mốc.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  SB_URL, SB_KEY, SB_HEADERS, DRY_RUN,
  NGUONC_BASE, KKPHIM_BASE, VODPHIM_BASE,
  fetchJson, normalizeStr, dedupKey, keysMatch, isDuplicateMovie, extractEpNum,
  pickVietsubServerData, patchMovie, pushNotifs,
  setNcDetailCache, getNcDetail, findNcSlugFromCache, normalizeNcDetail,
  flattenNguonCCategory, normEpisodesNC, parseExtra,
  syncFromAllSources, buildAllSourcesUpdate, mergeAllSourceEpisodes,
  insertMovie, GENRE_IMPORT_MAP, COUNTRY_IMPORT_MAP, sleep,
};
