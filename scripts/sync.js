// Sync tập mới cho NhotPhim — chạy bằng GitHub Actions (Node 20+, không cần cài thư viện).
// Logic port từ batchAutoFillLinks() trong file HTML.
// Nguồn dữ liệu: NguonC (SV1), KKPhim (SV2), VodPhim/api.xink.pro (SV3 - mới thêm).
// Ngoài sync tập mới, script còn tự rà soát và sửa ảnh poster bị lỗi (404) trong DB.
//
// Biến môi trường:
//   SUPABASE_URL          vd https://tlbumpjugtltznzuwqwt.supabase.co
//   SUPABASE_SERVICE_KEY  service_role key (CHỈ để trong GitHub Secrets)
//   DRY_RUN=1             (tùy chọn) chỉ in log, không ghi vào DB
//   SKIP_POSTER_FIX=1     (tùy chọn) bỏ qua bước rà soát/sửa ảnh poster lỗi

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const DRY_RUN = process.env.DRY_RUN === "1";
const SKIP_POSTER_FIX = process.env.SKIP_POSTER_FIX === "1";

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

// ---------- helpers ----------
function normalizeStr(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D");
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
      thumb_url: it.thumb_url || it.poster_url || "",
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
        thumb_url: m.thumb_url || "",
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
async function syncFromKKOnly(m) {
  const { movie, serverData } = await getKKFullData(m);
  if (!movie || !serverData.length) return null;
  const embedEps = serverData.map((ep, i) => ({ name: ep.name || "Tập " + (i + 1), link: "" }));
  const link2Eps = serverData.map((ep) => ep.link_embed || "");
  const link2Count = link2Eps.filter(Boolean).length;
  const vp = await getVPFullData(m);
  const link3Eps = embedEps.map((_, i) => vp.serverData[i]?.link_embed || "");
  return buildUpdate(m, {
    embedEps, link2Eps, link3Eps,
    curEpText: movie.episode_current,
    totalFromSource: parseInt(movie.episode_total) || serverData.length || 0,
    fallbackCount: link2Count || serverData.length,
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

// Kiểm tra URL ảnh có load được không (HEAD trước, 403/405 thì thử lại bằng GET)
async function checkImageOk(url) {
  if (!url) return false;
  for (const method of ["HEAD", "GET"]) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { method, signal: ctrl.signal, headers: BROWSER_HEADERS, redirect: "follow" });
      clearTimeout(t);
      if (r.ok) return true;
      if (r.status !== 403 && r.status !== 405) return false; // lỗi thật (404, 410, 5xx...) → không cần thử GET
    } catch {
      clearTimeout(t);
      return false;
    }
  }
  return false;
}

// Tìm ảnh poster thay thế: ưu tiên NguonC (nếu có slug) → KKPhim → VodPhim
async function findReplacementPoster(m) {
  const title = (m.titleen || m.title || "").trim();
  if (!title) return "";

  try {
    const slug = m.ophim_slug || (await findNguoncSlugByTitle(m));
    if (slug) {
      const { movie } = await nguoncDetail(slug);
      if (movie?.thumb_url) return movie.thumb_url;
    }
  } catch {}

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
  let checked = 0, broken = 0, fixed = 0;
  await runWithConcurrency(all, 8, async (m) => {
    checked++;
    const ok = await checkImageOk(m.poster);
    if (ok) return;
    broken++;
    console.warn(`  Ảnh lỗi: [${m.id}] ${m.title}`);
    const replacement = await findReplacementPoster(m);
    if (replacement && replacement !== m.poster) {
      if (await patchMovie(m.id, { poster: replacement })) {
        fixed++;
        console.log(`    ✓ Đã thay poster mới`);
      }
    } else {
      console.warn(`    ✗ Không tìm được ảnh thay thế`);
    }
  });
  console.log(`Poster: kiểm tra ${checked}, lỗi ${broken}, đã sửa ${fixed}.`);
}

// ---------- main ----------
async function main() {
  console.log(`Bắt đầu sync${DRY_RUN ? " (DRY RUN)" : ""} — ${new Date().toISOString()}`);
  const targets = await loadSeries();
  console.log(`Có ${targets.length} phim bộ đang chiếu cần kiểm tra.`);

  let success = 0, failed = 0, notFound = 0;
  const notifs = [];

  for (let idx = 0; idx < targets.length; idx++) {
    const m = targets[idx];
    console.log(`[${idx + 1}/${targets.length}] ${m.title}`);
    try {
      let slug = m.ophim_slug;
      let slugChanged = false;
      let result = null;

      if (!slug) {
        slug = await findNguoncSlugByTitle(m);
        if (slug) slugChanged = true;
      }

      if (slug) {
        const { movie, episodes } = await nguoncDetail(slug);
        if (!movie) {
          // NguonC lỗi/bị chặn → vẫn thử lấy tập mới từ KKPhim (SV1 giữ nguyên)
          console.warn("  NguonC không dùng được, thử KKPhim...");
          result = await syncFromKKOnly(m);
          if (!result) { failed++; await sleep(350); continue; }
          slug = null; slugChanged = false;
        }
        if (movie) {
        // Xác minh slug đúng phim
        const q = normalizeStr((m.title || m.titleen || "").trim());
        const n = normalizeStr(movie.name);
        const o = normalizeStr(movie.origin_name);
        if (q && n !== q && o !== q) {
          console.warn(`  Slug không khớp (NguonC trả về: ${movie.name}) → gỡ slug, dùng KKPhim`);
          if (m.ophim_slug) await patchMovie(m.id, { ophim_slug: null });
          result = await syncFromKKOnly(m);
          slug = null; slugChanged = false;
        } else {
          const serverData = pickVietsubServerData(episodes);
          const embedEps = serverData.map((ep, i) => ({ name: ep.name || "Tập " + (i + 1), link: ep.link_embed || "" }));
          const kk = await getKKFullData(m);
          const link2Eps = embedEps.map((_, i) => kk.serverData[i]?.link_embed || "");
          const vp = await getVPFullData(m);
          const link3Eps = embedEps.map((_, i) => vp.serverData[i]?.link_embed || "");
          result = buildUpdate(m, {
            embedEps, link2Eps, link3Eps,
            curEpText: movie.episode_current,
            totalFromSource: movie.episode_total,
            fallbackCount: embedEps.filter((e) => e.link).length,
          });
          if (slugChanged) result.fields.ophim_slug = slug;
        }
        }
      } else {
        result = await syncFromKKOnly(m);
      }

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
