// Probe tạm: kiểm tra Supabase có RPC cho phép chạy SQL/pg_net hay không.
// Không in secret; chỉ in status và body.
const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.log("Thiếu SUPABASE_URL/SUPABASE_SERVICE_KEY"); process.exit(0); }

const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function rpc(name, body) {
  try {
    const r = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: "POST", headers: H, body: JSON.stringify(body),
    });
    const t = await r.text();
    console.log(`rpc ${name.padEnd(16)} ${r.status} ${JSON.stringify(t.slice(0, 400))}`);
  } catch (e) {
    console.log(`rpc ${name.padEnd(16)} ERR ${e.message}`);
  }
}

async function main() {
  const s = await fetch(`${url}/rest/v1/auto_sync_state?select=id&id=eq.1`, { headers: H });
  console.log(`auto_sync_state     ${s.status} ${JSON.stringify((await s.text()).slice(0, 200))}`);

  const root = await fetch(`${url}/rest/v1/`, { headers: { ...H, Accept: "application/openapi+json" } });
  const spec = await root.text();
  try {
    const paths = Object.keys(JSON.parse(spec).paths || {});
    console.log(`openapi             ${root.status} rpc=${JSON.stringify(paths.filter((p) => p.includes("/rpc/")))}`);
    console.log(`openapi tables      ${JSON.stringify(paths.filter((p) => !p.includes("/rpc/")))}`);
  } catch {
    console.log(`openapi             ${root.status} ${JSON.stringify(spec.slice(0, 300))}`);
  }
  for (const name of ["exec_sql", "exec", "run_sql", "query", "sql", "http_get"]) {
    await rpc(name, { sql: "select 1 as ok", query: "select 1 as ok" });
  }
}
main();
