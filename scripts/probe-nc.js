// Probe tạm: chạy trên GitHub runner để xem NguonC trả gì và đường nào dự phòng được.
// Không đọc/ghi Supabase, không dùng secret.
const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
  Referer: "https://phim.nguonc.com/",
  Origin: "https://phim.nguonc.com",
};

const API = "https://phim.nguonc.com/api/films/phim-moi-cap-nhat?page=1";
const enc = encodeURIComponent(API);

const TARGETS = [
  ["direct", API],
  ["www", API.replace("https://phim.nguonc.com", "https://www.phim.nguonc.com")],
  ["bare", API.replace("https://phim.nguonc.com", "https://nguonc.com")],
  ["allorigins", `https://api.allorigins.win/raw?url=${enc}`],
  ["codetabs", `https://api.codetabs.com/v1/proxy?quest=${enc}`],
  ["corsproxy", `https://corsproxy.io/?${API}`],
  ["jina", `https://r.jina.ai/http://phim.nguonc.com/api/films/phim-moi-cap-nhat?page=1`],
];

async function probe(name, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: H });
    const text = await r.text();
    let info = "";
    try {
      const d = JSON.parse(text);
      info = `items=${(d.items || []).length}`;
    } catch {
      info = `non-json(len=${text.length})`;
    }
    console.log(`${name.padEnd(10)} status=${r.status} type=${r.headers.get("content-type") || "-"} ${info} head=${JSON.stringify(text.slice(0, 100))}`);
    if (r.status === 403) console.log(`${name} 403-body=${JSON.stringify(text.slice(0, 500))}`);
  } catch (e) {
    console.log(`${name.padEnd(10)} ERR ${e.name}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  for (const [name, url] of TARGETS) await probe(name, url);
})();
