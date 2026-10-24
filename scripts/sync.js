// Sync tập mới cho NhotPhim — chạy bằng GitHub Actions (Node 20+, không cần cài thư viện).
// Logic port từ batchAutoFillLinks() trong file HTML.
// Nguồn dữ liệu: KKPhim (SV2) là nguồn chính, VodPhim/api.xink.pro (SV3) bổ sung.
// NguonC (SV1) ĐÃ BỊ CHẶN BOT nên không còn dùng để sync tập nữa — code NguonC vẫn
// giữ lại (chỉ dùng làm phương án cuối khi tìm ảnh poster thay thế, nếu còn ophim_slug cũ).
// Ngoài sync tập mới, script còn:
//   - Tự thêm phim MỚI (hiện chỉ lọc quốc gia Hàn Quốc) từ VodPhim, nếu DB chưa có
//   - Bổ sung link2/link3 còn thiếu cho phim ĐÃ "Hoàn thành" (vì lúc đó SV2/SV3
//     chưa có, không đụng tới trạng thái/tập hiện tại của phim)
//   - Tự rà soát và sửa ảnh poster bị lỗi (404/410) trong DB
//
// Biến môi trường:
//   SUPABASE_URL           vd https://tlbumpjugtltznzuwqwt.supabase.co
//   SUPABASE_SERVICE_KEY   service_role key (CHỈ để trong GitHub Secrets)
//   DRY_RUN=1              (tùy chọn) chỉ in log, không ghi vào DB
//   SKIP_POSTER_FIX=1      (tùy chọn) bỏ qua bước rà soát/sửa ảnh poster lỗi
//   SKIP_BACKFILL_SV=1     (tùy chọn) bỏ qua bước bổ sung SV2/SV3 cho phim đã hoàn thành
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

const NGUONC_BASE = "https://phim.nguonc.com/api";
const KKPHIM_BASE = "https://phimapi.com";
const VODPHIM_BASE = "https://api.xink.pro/api/content";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function mergeEpisodes(oldEps, newEps, newLink2List, newLink3List) {
  const oldMap = {};
  (oldEps || []).forEach((e) => { if (e && e.name) oldMap[e.name] = e; });
  return newEps.map((e, i) => {
    const old = oldMap[e.name] || {};
    const auto2 = newLink2List && newLink2List[i] ? newLink2List[i] : "";
    const auto3 = newLink3List && newLink3List[i] ? newLink3List[i] : "";
    return {
      name: e.name,
      link: e.link || old.link || "",
      // Giữ link cũ nếu đã có; chỉ tự điền link mới khi ô đang trống —
      // nhờ vậy khi nguồn SV2/SV3 xuất hiện link mới cho tập trước đó
      // chưa có, lần sync sau sẽ tự điền vào mà không đụng link đã lưu.
      link2: old.link2 || auto2 || "",
      link3: old.link3 || auto3 || "",
    };
  });
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
async function nguoncDetail(slug) {
  try {
    const d = await fetchJson(`${NGUONC_BASE}/film/${slug}`, 15000, "https://phim.nguonc.com/");
    const m = d?.movie;
    if (!m) return { movie: null, episodes: [] };
    return {
      movie: {
        name: m.name || "",
        origin_name: m.original_name || "",
        thumb_url: m.thumb_url || m.poster_url || "",
        episode_total: parseInt(m.total_episodes) || 0,
        episode_current: m.current_episode || "",
      },
      episodes: (m.episodes || []).map((sv) => ({
        server_name: sv.server_name || "Server #1",
        server_data: (sv.items || []).map((ep) => ({
          name: ep.name || "", link_embed: ep.embed || "", link_m3u8: ep.m3u8 || "",
        })),
      })),
    };
  } catch (e) {
    console.warn("  NguonC detail lỗi:", e.message);
    return { movie: null, episodes: [], error: true };
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
async function getKKFullData(m) {
  const titleEn = (m.titleen || "").trim();
  const titleVi = (m.title || "").trim();
  const title = titleEn || titleVi;
  if (!title) return { movie: null, serverData: [] };
  let items = await kkSearch(title);
  if (!items.length && titleVi && titleVi !== title) items = await kkSearch(titleVi);
  if (!items.length) return { movie: null, serverData: [] };
  const detail = await kkDetail(items[0].slug);
  if (!detail.movie) return { movie: null, serverData: [] };
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
  const q = normalizeStr(title);
  const pick = items.find((it) => normalizeStr(it.name) === q || normalizeStr(it.origin_name) === q) || items[0];
  const detail = await vpDetail(pick.slug);
  if (!detail.movie) return { movie: null, serverData: [] };
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

// ---------- Supabase ----------
const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: "Bearer " + SB_KEY,
  "Content-Type": "application/json",
};

async function loadSeries() {
  const cols = "id,title,titleen,year,type,ep,poster,episodes,totalep,currentep,epstatus,ophim_slug";
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

// Phim bộ ĐÃ "Hoàn thành" nhưng còn tập thiếu link2 hoặc link3 (vì lúc đó SV2/SV3
// chưa có link, hoặc tính năng SV3 lúc đó chưa tồn tại). loadSeries() ở trên không
// bao giờ quét lại các phim này vì chúng đã "Hoàn thành" — nên cần vòng riêng.
// (Phim lẻ "type=movie" không dùng mảng episodes[] nên không nằm trong phạm vi này.)
async function loadMissingSVTargets() {
  const cols = "id,title,titleen,year,type,episodes,epstatus";
  const PAGE = 500;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SB_URL}/rest/v1/movies?select=${cols}&order=id.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) throw new Error(`Đọc bảng movies (thiếu SV2/SV3) lỗi: ${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out.filter((m) => {
    if (m.type === "movie" || m.epstatus !== "Hoàn thành") return false;
    const eps = parseEpisodes(m.episodes);
    return eps.length > 0 && eps.some((e) => !e.link2 || !e.link3);
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

// Tính các cột cần cập nhật từ dữ liệu nguồn
function buildUpdate(m, { embedEps, link2Eps, link3Eps, curEpText, totalFromSource, fallbackCount }) {
  const oldEpisodes = parseEpisodes(m.episodes);
  const episodes = mergeEpisodes(oldEpisodes, embedEps, link2Eps, link3Eps);
  const curNum = extractEpNum(curEpText) || fallbackCount;
  const low = (curEpText || "").toLowerCase();
  const epStatus = low.includes("hoàn") || low.includes("full") ? "Hoàn thành" : "Đang chiếu";
  const totalEp = totalFromSource || m.totalep || 0;
  const ep = epStatus === "Hoàn thành"
    ? "Full " + (totalEp || "") + (totalEp ? " tập" : "")
    : "Tập " + curNum + (totalEp ? "/" + totalEp : "");
  const fields = {
    episodes: JSON.stringify(episodes),
    currentep: curNum || null,
    epstatus: epStatus,
    ep,
  };
  if (totalFromSource) fields.totalep = totalFromSource;
  return { fields, curNum, ep, hasNewEp: curNum > (m.currentep || 0) };
}

// Chỉ dùng KKPhim (phim không có trên NguonC): SV1 giữ trống, chỉ điền SV2 + SV3
// Dò tập mới từ KKPhim (SV2) + VodPhim (SV3) — đối xứng, không bắt buộc phải có
// cả 2 nguồn (chỉ 1 nguồn tìm thấy phim vẫn chạy được), và khớp SV2/SV3 vào đúng
// tập theo SỐ TẬP trích từ tên (vd "Tập 5" → 5) thay vì theo vị trí trong mảng —
// vì 2 nguồn có thể lệch số tập đầu (1 nguồn thiếu tập 1, có tập đặc biệt...),
// khớp theo vị trí dễ bị lệch hết các tập phía sau.
async function syncFromKKOnly(m) {
  const kk = await getKKFullData(m);
  const vp = await getVPFullData(m);
  const kkLen = kk.serverData.length;
  const vpLen = vp.serverData.length;

  console.log(`  SV2 (KKPhim): ${kkLen ? `khớp phim, nguồn có ${kkLen} tập` : "không tìm thấy trên KKPhim"}`);
  console.log(`  SV3 (VodPhim): ${vpLen ? `khớp phim, nguồn có ${vpLen} tập` : "không tìm thấy trên VodPhim"}`);

  if (!kkLen && !vpLen) return null; // cả 2 nguồn đều không có phim này, đành chịu

  // Lấy nguồn có nhiều tập hơn làm khung chính (tránh bỏ sót tập mới nếu 1 nguồn
  // ra chậm hơn nguồn kia).
  const useKK = kkLen >= vpLen;
  const backbone = useKK ? kk.serverData : vp.serverData;
  const embedEps = backbone.map((ep, i) => ({ name: ep.name || "Tập " + (i + 1), link: "" }));

  const byEpNum = (serverData) => {
    const map = {};
    serverData.forEach((ep, i) => { map[extractEpNum(ep.name) || i + 1] = ep.link_embed || ""; });
    return map;
  };
  const kkMap = byEpNum(kk.serverData);
  const vpMap = byEpNum(vp.serverData);

  const link2Eps = embedEps.map((ep, i) => kkMap[extractEpNum(ep.name) || i + 1] || "");
  const link3Eps = embedEps.map((ep, i) => vpMap[extractEpNum(ep.name) || i + 1] || "");
  const link2Count = link2Eps.filter(Boolean).length;
  const link3Count = link3Eps.filter(Boolean).length;
  console.log(`  → Điền SV2: ${link2Count}/${embedEps.length} tập, SV3: ${link3Count}/${embedEps.length} tập`);

  const movie = useKK ? kk.movie : vp.movie;
  return buildUpdate(m, {
    embedEps, link2Eps, link3Eps,
    curEpText: movie?.episode_current || "",
    totalFromSource: parseInt(movie?.episode_total) || backbone.length,
    fallbackCount: Math.max(link2Count, link3Count) || backbone.length,
  });
}

// ---------- Sửa ảnh poster bị lỗi ----------
async function loadAllMoviesForPosterCheck() {
  const cols = "id,title,titleen,year,poster,ophim_slug";
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

  // KKPhim và VodPhim thử trước — NguonC để cuối cùng vì hay bị chặn bot, ít khi dùng được
  try {
    const items = await kkSearch(title);
    if (items.length) {
      const { movie } = await kkDetail(items[0].slug);
      if (movie?.thumb_url) return movie.thumb_url;
    }
  } catch {}

  try {
    const items = await vpSearch(title);
    if (items.length) {
      const { movie } = await vpDetail(items[0].slug);
      if (movie?.thumb_url) return movie.thumb_url;
    }
  } catch {}

  try {
    const slug = m.ophim_slug;
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

// ---------- Bổ sung SV2/SV3 còn thiếu cho phim ĐÃ hoàn thành ----------
// Chỉ điền vào ô link2/link3 đang trống, giữ nguyên hoàn toàn link (SV1), tên tập,
// currentep/epstatus/ep/totalep — vì phim đã xong rồi, không cần/không nên tính lại.
async function backfillSV23(m) {
  const oldEpisodes = parseEpisodes(m.episodes);
  if (!oldEpisodes.length) return null;
  const needLink2 = oldEpisodes.some((e) => !e.link2);
  const needLink3 = oldEpisodes.some((e) => !e.link3);
  if (!needLink2 && !needLink3) return null;

  let link2Eps = [];
  let link3Eps = [];
  const byEpNum = (serverData) => {
    const map = {};
    serverData.forEach((ep, i) => { map[extractEpNum(ep.name) || i + 1] = ep.link_embed || ""; });
    return map;
  };

  if (needLink2) {
    const kk = await getKKFullData(m);
    const kkMap = byEpNum(kk.serverData);
    link2Eps = oldEpisodes.map((e, i) => kkMap[extractEpNum(e.name) || i + 1] || "");
    const gained = link2Eps.filter((v, i) => v && !oldEpisodes[i].link2).length;
    console.log(`  SV2 (KKPhim, backfill): ${kk.movie ? `khớp phim, bổ sung thêm ${gained} tập` : "không tìm thấy trên KKPhim"}`);
  }
  if (needLink3) {
    const vp = await getVPFullData(m);
    const vpMap = byEpNum(vp.serverData);
    link3Eps = oldEpisodes.map((e, i) => vpMap[extractEpNum(e.name) || i + 1] || "");
    const gained = link3Eps.filter((v, i) => v && !oldEpisodes[i].link3).length;
    console.log(`  SV3 (VodPhim, backfill): ${vp.movie ? `khớp phim, bổ sung thêm ${gained} tập` : "không tìm thấy trên VodPhim"}`);
  }

  const episodes = mergeEpisodes(
    oldEpisodes,
    oldEpisodes.map((e) => ({ name: e.name, link: e.link })),
    link2Eps,
    link3Eps
  );
  if (JSON.stringify(episodes) === JSON.stringify(oldEpisodes)) return null;
  return { fields: { episodes: JSON.stringify(episodes) } };
}

async function backfillMissingSV() {
  console.log(`\nKiểm tra phim đã hoàn thành còn thiếu link SV2/SV3...`);
  const list = await loadMissingSVTargets();
  console.log(`Có ${list.length} phim cần bổ sung.`);
  let fixedCount = 0, failed = 0;
  for (let idx = 0; idx < list.length; idx++) {
    const m = list[idx];
    console.log(`[Backfill ${idx + 1}/${list.length}] ${m.title}`);
    try {
      const result = await backfillSV23(m);
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
  console.log(`Backfill SV2/SV3: đã bổ sung cho ${fixedCount}/${list.length} phim, ${failed} lỗi.`);
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
      // NguonC (SV1) bị chặn bot nên không dùng nữa — chỉ dựa vào KKPhim (SV2)
      // làm nguồn chính để biết danh sách tập + VodPhim (SV3) bổ sung link.
      const result = await syncFromKKOnly(m);

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
      await backfillMissingSV();
    } catch (e) {
      console.error("Lỗi khi backfill SV2/SV3 cho phim đã hoàn thành:", e.message);
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

main().catch((e) => { console.error(e); process.exit(1); });
