// Минимальный сервер: отдаёт index.html, /api/products (товары из BILLZ)
// и принимает заявки на /api/order (отправляет их во второй бот для сотрудников).
// Варианты одного товара (цвет, размер) склеиваются в одну карточку по parent_id.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const BASE = process.env.BILLZ_BASE || "https://api-admin.billz.ai";
const SECRET = process.env.BILLZ_SECRET_KEY;

// --- заявки (задаются в Render -> Environment) ---
const ORDERS_TOKEN = process.env.ORDERS_BOT_TOKEN; // токен бота для заявок
const ORDERS_CHAT = process.env.ORDERS_CHAT_ID;    // id группы сотрудников или менеджера
const WEBAPP_TOKEN = process.env.WEBAPP_BOT_TOKEN; // необязательно: токен @rbooks123_bot, чтобы проверять, что заявка пришла из мини-аппа

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

async function getProducts() {
  if (Date.now() - cache.at > 5 * 60 * 1000) cache = { at: Date.now(), data: await fetchProducts() };
  return cache.data;
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

// ================= ЗАЯВКИ =================

const escHtml = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmtNum = n => new Intl.NumberFormat("ru-RU").format(n);

// ограничение числа запросов с одного адреса за 10 минут (защита от спама)
const hits = new Map();
function limited(key, max = 5) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(key) || []).filter(t => now - t < win);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) if (!arr.some(t => now - t < 10 * 60 * 1000)) hits.delete(ip);
}, 10 * 60 * 1000).unref();

function readJson(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return reject(new Error("too large"));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// Проверка подписи Telegram: если задан WEBAPP_BOT_TOKEN, берём данные пользователя только из подписанного initData
function verifyInitData(initData) {
  if (!WEBAPP_TOKEN || !initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dcs = [...params.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(WEBAPP_TOKEN).digest();
    const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
    if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - Number(params.get("auth_date") || 0) > 24 * 3600) return null;
    return JSON.parse(params.get("user") || "null");
  } catch (e) {
    return null;
  }
}

async function handleOrder(req, res) {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (!ORDERS_TOKEN || !ORDERS_CHAT) return send(503, { error: "orders not configured" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (limited("o:" + ip, 5)) return send(429, { error: "too many requests" });

  let b;
  try { b = await readJson(req); } catch (e) { return send(400, { error: "bad request" }); }

  const name = String(b.name || "").trim().slice(0, 80);
  const phone = String(b.phone || "").replace(/[^\d+]/g, "").slice(0, 20);
  const digits = phone.replace(/\D/g, "");
  const phoneOk = digits.startsWith("998") ? digits.length === 12 : digits.length >= 9;
  const qty = Math.min(99, Math.max(1, parseInt(b.qty, 10) || 1));
  const comment = String(b.comment || "").trim().slice(0, 500);
  if (!name || !phoneOk) return send(400, { error: "invalid name or phone" });

  // цену и название берём из каталога, а не от клиента
  let prod = null, variant = null;
  try {
    const list = await getProducts();
    prod = list.find(p => String(p.id) === String(b.productId)) || null;
    variant = prod ? prod.variants.find(v => String(v.id) === String(b.variantId)) || null : null;
  } catch (e) {
    console.error("catalog lookup failed", e && e.message);
  }
  let productName, variantText, price, verified = true;
  if (prod && variant) {
    productName = prod.name;
    variantText = Object.entries(variant.attrs).map(([k, v]) => `${k}: ${v}`).join(", ");
    price = variant.price;
  } else {
    verified = false;
    productName = String(b.productName || "").slice(0, 120) || "—";
    variantText = String(b.variantText || "").slice(0, 120);
    price = Math.max(0, Number(b.price) || 0);
  }

  // данные Telegram-пользователя: подписанные, если можем проверить, иначе то, что прислал клиент
  const signedUser = verifyInitData(String(b.initData || ""));
  const tgUser = signedUser || (b.user && typeof b.user === "object" ? b.user : null);
  let tgLine = "—";
  if (tgUser && tgUser.id) {
    const uname = String(tgUser.username || "").replace(/[^\w]/g, "");
    const label = uname ? "@" + uname : "профиль";
    const link = uname ? `https://t.me/${uname}` : `tg://user?id=${Number(tgUser.id) || 0}`;
    tgLine = `<a href="${link}">${escHtml(label)}</a>` + (signedUser ? "" : " (не проверено)");
  }

  const when = new Date().toLocaleString("ru-RU", { timeZone: "Asia/Tashkent" });
  const lines = [
    "🛒 <b>Новый заказ</b>",
    "",
    `<b>Товар:</b> ${escHtml(productName)}`,
    variantText ? `<b>Вариант:</b> ${escHtml(variantText)}` : null,
    `<b>Количество:</b> ${qty}`,
    price ? `<b>Цена:</b> ${fmtNum(price)} сум` : null,
    price ? `<b>Итого:</b> ${fmtNum(price * qty)} сум` : null,
    verified ? null : "⚠️ Цена и товар не сверены с каталогом",
    "",
    `<b>Клиент:</b> ${escHtml(name)}`,
    `<b>Телефон:</b> ${escHtml(phone.startsWith("+") ? phone : "+" + phone)}`,
    `<b>Telegram:</b> ${tgLine}`,
    comment ? `<b>Комментарий:</b> ${escHtml(comment)}` : null,
    "",
    `🕒 ${when}`,
  ].filter(l => l !== null);

  try {
    const r = await fetch(`https://api.telegram.org/bot${ORDERS_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ORDERS_CHAT,
        text: lines.join("\n"),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!r.ok) {
      console.error("telegram sendMessage failed:", r.status, await r.text());
      return send(502, { error: "telegram error" });
    }
  } catch (e) {
    console.error("telegram request failed:", e && e.message);
    return send(502, { error: "telegram error" });
  }
  send(200, { ok: true });
}

// ================= КЕШБЭК-КАРТА =================

const PLATFORM_ID = process.env.BILLZ_PLATFORM_ID || "7d4a4c38-dd84-4902-b744-0488b80a4c01";
// выключить поиск баланса по номеру телефона: CASHBACK_PHONE_LOOKUP=off
const PHONE_LOOKUP = String(process.env.CASHBACK_PHONE_LOOKUP || "on").toLowerCase() !== "off";

async function billzGet(pathAndQuery) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!token || Date.now() - tokenAt > 20 * 3600 * 1000) await login();
    const r = await fetch(`${BASE}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}`, "platform-id": PLATFORM_ID },
    });
    if (r.status === 401) { token = null; continue; }
    if (!r.ok) throw new Error("BILLZ " + pathAndQuery.split("?")[0] + " failed: " + r.status);
    return r.json();
  }
  throw new Error("BILLZ auth failed");
}

async function findClient(params) {
  const q = new URLSearchParams({ limit: "1", page: "1", ...params });
  const j = await billzGet(`/v1/client?${q}`);
  const list = j.clients || j.data?.clients || [];
  return list[0] || null;
}

async function findClientByPhone(digits) {
  // в каком формате Billz хранит номер, заранее неизвестно: пробуем несколько вариантов
  const variants = [...new Set([digits, "+" + digits, digits.slice(-9)])];
  for (const v of variants) {
    const c = await findClient({ phone_number: v });
    if (c) return c;
  }
  return null;
}

// суммы покупок по номеру телефона (без входа через Telegram) отдаём только если включено явно
const PURCHASES_BY_PHONE = String(process.env.PURCHASES_BY_PHONE || "off").toLowerCase() === "on";

async function getPurchases(c) {
  let total = null;
  try {
    if (c.id) {
      const j = await billzGet(`/v1/customer/${encodeURIComponent(c.id)}`);
      const d = j.data || j;
      if (d && d.purchase_amount != null) total = Math.max(0, Math.round(Number(d.purchase_amount) || 0));
    }
  } catch (e) {
    console.error("customer details failed:", e && e.message);
  }
  const last = String(c.last_transaction_date || "").trim();
  const lastOk = last && !last.startsWith("0001") && last !== "0";
  if (total === null && !lastOk) return null;
  return { total, last: lastOk ? last : "" };
}

function cardInfo(c, withName) {
  const out = {
    found: true,
    balance: Math.max(0, Math.round(Number(c.balance) || 0)),
    card: (c.cards && c.cards[0]) ? String(c.cards[0].code || c.cards[0]) : "",
  };
  if (withName) out.name = String(c.first_name || "").slice(0, 40);
  return out;
}

async function handleCashback(req, res) {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (limited("c:" + ip, 20)) return send(429, { error: "too many requests" });

  let b;
  try { b = await readJson(req); } catch (e) { return send(400, { error: "bad request" }); }

  try {
    // 1) по подписанному Telegram id (безопасно, нужен WEBAPP_BOT_TOKEN)
    const user = verifyInitData(String(b.initData || ""));
    if (user && user.id) {
      const c = await findClient({ chat_id: String(user.id) });
      if (c) {
        const out = cardInfo(c, true);
        out.purchases = await getPurchases(c);
        return send(200, out);
      }
    }
    // 2) по номеру телефона, показываем только баланс и номер карты, без имени
    const digits = String(b.phone || "").replace(/\D/g, "");
    const phoneOk = digits.startsWith("998") ? digits.length === 12 : digits.length >= 9;
    if (PHONE_LOOKUP && digits && phoneOk) {
      const c = await findClientByPhone(digits);
      if (c) {
        const out = cardInfo(c, false);
        if (PURCHASES_BY_PHONE) out.purchases = await getPurchases(c);
        return send(200, out);
      }
      return send(200, { found: false, reason: "not_found" });
    }
    return send(200, { found: false, reason: digits ? "bad_phone" : "need_phone" });
  } catch (e) {
    console.error("cashback lookup failed:", e && e.message);
    return send(502, { error: "billz error" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = String(req.url || "").split("?")[0];

  if (url === "/api/cashback") {
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
    try { await handleCashback(req, res); } catch (e) {
      console.error(e);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
    return;
  }

  if (url === "/api/products") {
    try {
      const data = await getProducts();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error(e);
      res.writeHead(502); res.end("billz error");
    }
    return;
  }

  if (url === "/api/order") {
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
    try { await handleOrder(req, res); } catch (e) {
      console.error(e);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(path.join(__dirname, "index.html")));
});

if (require.main === module) {
  server.listen(PORT, () => console.log("http://localhost:" + PORT));
}
module.exports = { groupProducts, server };
