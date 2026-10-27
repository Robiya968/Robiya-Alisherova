// Минимальный сервер: отдаёт index.html и /api/products (товары из BILLZ).
// Запуск: BILLZ_SECRET_KEY=xxx node server.js   (нужен Node 18+)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const BASE = process.env.BILLZ_BASE || "https://api-admin.billz.ai";
const SECRET = process.env.BILLZ_SECRET_KEY;

let token = null, tokenAt = 0;
let cache = { at: 0, data: [] };

async function login() {
  // ВАЖНО: путь и имя поля взяты по памяти из публичной документации BILLZ v2 — сверьте с вашей докой
  const r = await fetch(`${BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret_token: SECRET }),
  });
  if (!r.ok) throw new Error("BILLZ login failed: " + r.status);
  const j = await r.json();
  token = j.data?.access_token || j.access_token;
  tokenAt = Date.now();
}

async function fetchProducts() {
  if (!token || Date.now() - tokenAt > 20 * 3600 * 1000) await login();
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const r = await fetch(`${BASE}/v2/products?limit=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 401) { token = null; return fetchProducts(); }
    if (!r.ok) throw new Error("BILLZ products failed: " + r.status);
    const j = await r.json();
    const items = j.products || j.data?.products || [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out.map(mapProduct).filter(p => p.price > 0);
}

// Привязка полей BILLZ -> наш формат. Названия полей проверьте на реальном ответе.
function mapProduct(p) {
  const shop = (p.shop_prices || [])[0] || {};
  const retail = Number(shop.retail_price || 0);
  const promo = Number(shop.promo_price || 0);
  const hasPromo = promo > 0 && promo < retail;
  const photo = (p.photos || [])[0];
  const cat = (p.categories || [])[0];
  return {
    id: p.id,
    name: p.name,
    category: (typeof cat === "string" ? cat : cat?.name) || "Прочее",
    description: String(p.description || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(),
    price: hasPromo ? promo : retail,
    oldPrice: hasPromo ? retail : 0,
    image: (typeof photo === "string" ? photo : photo?.photo_url || photo?.url) || p.main_image_url_full || "",
    stock: Number((p.shop_measurement_values || [])[0]?.active_measurement_value ?? 0),
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/products") {
    try {
      if (Date.now() - cache.at > 5 * 60 * 1000) cache = { at: Date.now(), data: await fetchProducts() };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cache.data));
    } catch (e) {
      console.error(e);
      res.writeHead(502); res.end("billz error");
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(path.join(__dirname, "index.html")));
});

server.listen(PORT, () => console.log("http://localhost:" + PORT));
