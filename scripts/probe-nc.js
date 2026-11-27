// Probe tạm: chạy trên GitHub runner để xem NguonC trả gì và đường nào dự phòng được.
// Không đọc/ghi Supabase, không dùng secret.
const dns = require("node:dns");
const { execFileSync } = require("node:child_process");

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

const TR = (u) => u.replace("https://phim.nguonc.com", "https://phim-nguonc-com.translate.goog") + (u.includes("?") ? "&" : "?") + "_x_tr_sl=vi&_x_tr_tl=en&_x_tr_hl=en";
const TARGETS = [
  ["direct", API],
  ["translate", TR(API)],
  ["trans-detail", TR("https://phim.nguonc.com/api/film/bao-chau")],
];

function cfInfo(text) {
  const code = text.match(/Error (code|number)\s*:?\s*(\d+)/i) || text.match(/\b(10\d\d)\b/);
  const ray = text.match(/Ray ID\s*:?\s*([a-f0-9]+)/i);
  return `cf=${code ? code[2] || code[1] : "-"} ray=${ray ? ray[1] : "-"}`;
}

async function probe(name, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: H });
    const text = await r.text();
    let info = "";
    try {
      const d = JSON.parse(text);
      info = `items=${(d.items || (d.data && d.data.items) || []).length}`;
    } catch {
      info = `non-json(len=${text.length}) ${cfInfo(text)}`;
    }
    console.log(`${name.padEnd(10)} status=${r.status} ${info} head=${JSON.stringify(text.slice(0, 80))}`);
  } catch (e) {
    console.log(`${name.padEnd(10)} ERR ${e.name}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function probeCurl() {
  try {
    const args = ["-sS", "-L", "--max-time", "20", "-o", "/tmp/nc.json", "-w", "%{http_code}"];
    for (const [k, v] of Object.entries(H)) args.push("-H", `${k}: ${v}`);
    args.push(API);
    const code = execFileSync("curl", args, { encoding: "utf8" }).trim();
    const text = require("node:fs").readFileSync("/tmp/nc.json", "utf8");
    let info = "";
    try { info = `items=${JSON.parse(text).items.length}`; } catch { info = `non-json(len=${text.length}) ${cfInfo(text)}`; }
    console.log(`curl       status=${code} ${info} head=${JSON.stringify(text.slice(0, 80))}`);
  } catch (e) {
    console.log(`curl       ERR ${e.message}`);
  }
}

(async () => {
  await probe("direct", API);
  probeCurl();
  dns.setDefaultResultOrder("ipv6first");
  await probe("ipv6", API);
  for (const [name, url] of TARGETS.slice(1)) await probe(name, url);
})();
