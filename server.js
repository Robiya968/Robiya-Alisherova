// Минимальный сервер: отдаёт index.html и /api/products (товары из BILLZ).
// Варианты одного товара (цвет, размер) склеиваются в одну карточку по parent_id.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const BASE = process.env.BILLZ_BASE || "https://api-admin.billz.ai";
const SECRET = process.env.BILLZ_SECRET_KEY;

let token = null, tokenAt = 0;
let cache = { at: 0, data: [] };

async function login() {
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
  return groupProducts(out);
}

function cleanText(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function attrsOf(p) {
  const o = {};
  for (const a of p.product_attributes || []) {
    if (a.attribute_name && a.attribute_value) o[a.attribute_name] = a.attribute_value;
  }
  return o;
}

function mapVariant(p) {
  const shop = (p.shop_prices || [])[0] || {};
  const retail = Number(shop.retail_price || 0);
  const promo = Number(shop.promo_price || 0);
  const hasPromo = promo > 0 && promo < retail;
  const photo = (p.photos || [])[0];
  return {
    id: p.id,
    attrs: attrsOf(p),
    price: hasPromo ? promo : retail,
    oldPrice: hasPromo ? retail : 0,
    image: (typeof photo === "string" ? photo : photo?.photo_url || photo?.url) || p.main_image_url_full || "",
    stock: Number((p.shop_measurement_values || [])[0]?.active_measurement_value ?? 0),
  };
}

// Название без хвоста варианта: "рубашка / красный" -> "рубашка"
function baseName(p, attrs) {
  const name = String(p.name || "");
  const label = Object.values(attrs).join(" / ");
  if (label && name.endsWith(" / " + label)) return name.slice(0, -(label.length + 3));
  if (label) {
    const i = name.indexOf(" / ");
    if (i > 0) return name.slice(0, i);
  }
  return name;
}

function groupProducts(items) {
  const groups = new Map();
  for (const p of items) {
    // склеиваем только товары с атрибутами (цвет, размер); обычные остаются отдельными
    const hasAttrs = Object.keys(attrsOf(p)).length > 0;
    const key = (p.parent_id && hasAttrs) ? p.parent_id : p.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const result = [];
  for (const [key, list] of groups) {
    const first = list[0];
    const variants = list.map(mapVariant).filter(v => v.price > 0);
    if (!variants.length) continue;
    const cat = (first.categories || [])[0];
    result.push({
      id: key,
      name: baseName(first, variants[0].attrs),
      category: (typeof cat === "string" ? cat : cat?.name) || "Прочее",
      description: cleanText(list.map(p => p.description).find(d => cleanText(d))),
      image: variants.map(v => v.image).find(Boolean) || "",
      variants,
    });
  }
  return result;
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

if (require.main === module) {
  server.listen(PORT, () => console.log("http://localhost:" + PORT));
}
module.exports = { groupProducts };
