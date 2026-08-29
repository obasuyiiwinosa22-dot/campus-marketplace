/* ============================================================
   CampusMarket — backend server (Node + PostgreSQL)
   REST API + SSE real-time chat + PostgreSQL data layer (pg)
   ============================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "server-data");
const SECRET_FILE = path.join(DATA_DIR, "secret.key");
const PORT = process.env.PORT || 3000;

/* ---------------- PostgreSQL connection ---------------- */
if (!process.env.DATABASE_URL) {
  console.error("\n  [FATAL] DATABASE_URL is not set.\n  Set it to your PostgreSQL connection string (e.g. Aiven) before starting the server.\n");
  process.exit(1);
}

/* Enable SSL for production (Aiven requires it). rejectUnauthorized:false
   keeps the handshake smooth against Aiven's CA while still encrypting. */
const useSsl =
  process.env.NODE_ENV === "production" ||
  /aiven|sslmode=require|amazonaws|rds\.amazon/i.test(process.env.DATABASE_URL || "");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 20,
});

async function q(text, params = []) {
  return pool.query(text, params);
}

/* ---------------- Auth secret ---------------- */
function loadOrCreateSecret() {
  if (process.env.SECRET && process.env.SECRET.length >= 16) return process.env.SECRET;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SECRET_FILE)) {
    const s = fs.readFileSync(SECRET_FILE, "utf8").trim();
    if (s) return s;
  }
  const generated = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  console.log("\n  [SECURITY] Generated a new random auth secret at server-data/secret.key");
  console.log("  For production, set the SECRET env var instead and keep it out of the repo.\n");
  return generated;
}
const SECRET = loadOrCreateSecret();

/* ---------------- DB schema (auto-migration) ---------------- */
async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      password_salt TEXT,
      role TEXT DEFAULT 'Student',
      location TEXT DEFAULT 'Main Campus',
      bio TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      is_admin BOOLEAN DEFAULT FALSE,
      rating NUMERIC DEFAULT 0,
      ratings_count INT DEFAULT 0,
      listings INT DEFAULT 0,
      sold INT DEFAULT 0,
      reviews INT DEFAULT 0,
      created_at BIGINT DEFAULT 0,
      email_verified BOOLEAN DEFAULT FALSE,
      verification_code_hash TEXT,
      verification_code_salt TEXT,
      verification_code_expires_at BIGINT,
      verification_email TEXT,
      verify_attempts INT DEFAULT 0,
      verify_cooldown_until BIGINT DEFAULT 0,
      verify_send_count INT DEFAULT 0,
      verify_send_window_start BIGINT DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      seller_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      price NUMERIC DEFAULT 0,
      description TEXT DEFAULT '',
      category TEXT DEFAULT '',
      condition TEXT DEFAULT '',
      location TEXT DEFAULT '',
      status TEXT DEFAULT 'Available',
      images JSONB DEFAULT '[]'::jsonb,
      created_at BIGINT DEFAULT 0,
      sold_at BIGINT,
      rating NUMERIC,
      rating_count INT DEFAULT 0,
      reviews JSONB DEFAULT '[]'::jsonb,
      confirmations JSONB DEFAULT '[]'::jsonb
    )`,
    `CREATE TABLE IF NOT EXISTS favorites (
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, product_id)
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      participant_ids JSONB DEFAULT '[]'::jsonb,
      product_id TEXT,
      messages JSONB DEFAULT '[]'::jsonb,
      last_message TEXT DEFAULT '',
      last_time TEXT DEFAULT '',
      last_created_at BIGINT,
      unread JSONB DEFAULT '{}'::jsonb,
      created_at BIGINT DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      type TEXT DEFAULT '',
      text TEXT DEFAULT '',
      unread BOOLEAN DEFAULT TRUE,
      time TEXT DEFAULT '',
      created_at BIGINT DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      product_id TEXT,
      reporter_id TEXT,
      reason TEXT DEFAULT 'Other',
      text TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      created_at BIGINT DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS banned (
      id SERIAL PRIMARY KEY,
      email TEXT,
      user_id TEXT,
      created_at BIGINT DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at BIGINT DEFAULT 0,
      by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)`,
    `CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`,
    `CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id)`,
    `CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_participants ON conversations USING gin (participant_ids)`,
  ];
  for (const sql of statements) {
    await q(sql);
  }
  console.log("  [db] Schema migrated (CREATE TABLE IF NOT EXISTS applied).");
}

async function seedModerator() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
  const existing = await q("SELECT id FROM users WHERE email=$1", [String(process.env.ADMIN_EMAIL).trim().toLowerCase()]);
  if (existing.rows.length) return;
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(process.env.ADMIN_PASSWORD, salt, 64).toString("hex");
  await q(
    `INSERT INTO users
      (id,name,email,password_hash,password_salt,role,location,bio,avatar,is_admin,rating,ratings_count,listings,sold,reviews,created_at,email_verified)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,0,0,0,0,0,$10,false)`,
    ["u_admin", (process.env.ADMIN_NAME || "Moderator").trim(), String(process.env.ADMIN_EMAIL).trim().toLowerCase(), hash, salt, "Moderator", "Main Campus", "Official CampusMarket moderator.", "", Date.now()]
  );
  console.log("  [seed] Moderator account created for " + process.env.ADMIN_EMAIL);
}

/* ---------------- row mappers ---------------- */
const USER_COLS = "id,name,email,role,location,bio,avatar,is_admin,rating,ratings_count,listings,sold,reviews,created_at,email_verified";

function cleanUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role || "Student",
    location: row.location || "Main Campus",
    bio: row.bio || "",
    avatar: row.avatar || "",
    isAdmin: !!row.is_admin,
    rating: row.rating != null ? Number(row.rating) : 0,
    ratingsCount: row.ratings_count || 0,
    listings: row.listings || 0,
    sold: row.sold || 0,
    reviews: row.reviews || 0,
    createdAt: row.created_at != null ? parseInt(row.created_at) : 0,
    emailVerified: !!row.email_verified,
  };
}
function fullUser(row) {
  if (!row) return null;
  return {
    ...cleanUser(row),
    hash: row.password_hash,
    salt: row.password_salt,
    verificationCodeHash: row.verification_code_hash,
    verificationCodeSalt: row.verification_code_salt,
    verificationCodeExpiresAt: row.verification_code_expires_at != null ? parseInt(row.verification_code_expires_at) : 0,
    verificationEmail: row.verification_email,
    verifyAttempts: row.verify_attempts || 0,
    verifyCooldownUntil: row.verify_cooldown_until != null ? parseInt(row.verify_cooldown_until) : 0,
    verifySendCount: row.verify_send_count || 0,
    verifySendWindowStart: row.verify_send_window_start != null ? parseInt(row.verify_send_window_start) : 0,
  };
}
function rowToProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    sellerId: row.seller_id,
    title: row.title,
    price: row.price != null ? Number(row.price) : 0,
    description: row.description || "",
    category: row.category || "",
    condition: row.condition || "",
    location: row.location || "",
    status: row.status || "Available",
    images: Array.isArray(row.images) ? row.images : (row.images ? JSON.parse(row.images) : []),
    createdAt: row.created_at != null ? parseInt(row.created_at) : 0,
    soldAt: row.sold_at != null ? parseInt(row.sold_at) : null,
    rating: row.rating != null ? Number(row.rating) : undefined,
    ratingCount: row.rating_count || 0,
    reviews: Array.isArray(row.reviews) ? row.reviews : [],
    confirmations: Array.isArray(row.confirmations) ? row.confirmations : [],
  };
}

/* ---------------- user helpers ---------------- */
async function getUserFullById(id) {
  const r = await q("SELECT * FROM users WHERE id=$1", [id]);
  return r.rows[0] ? fullUser(r.rows[0]) : null;
}
async function getUserFullByEmail(email) {
  const r = await q("SELECT * FROM users WHERE email=$1", [String(email || "").trim().toLowerCase()]);
  return r.rows[0] ? fullUser(r.rows[0]) : null;
}
async function getCleanUserById(id) {
  const r = await q(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [id]);
  return r.rows[0] ? cleanUser(r.rows[0]) : null;
}
async function getSellersMap(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};
  const r = await q(`SELECT ${USER_COLS} FROM users WHERE id = ANY($1::text[])`, [uniq]);
  const map = {};
  r.rows.forEach((row) => { const u = cleanUser(row); map[u.id] = u; });
  return map;
}
async function isBannedUser(u) {
  if (!u) return false;
  const email = (u.email || "").toLowerCase();
  const r = await q("SELECT 1 FROM banned WHERE (email=$1) OR (user_id=$2) LIMIT 1", [email || null, u.id || null]);
  return r.rows.length > 0;
}

/* ---------------- auth ---------------- */
function makeToken(userId) {
  const sig = crypto.createHmac("sha256", SECRET).update(userId).digest("hex").slice(0, 32);
  return Buffer.from(userId + "." + sig).toString("base64url");
}
function verifyToken(token) {
  if (!token) return null;
  try {
    const dec = Buffer.from(token, "base64url").toString("utf8");
    const [userId, sig] = dec.split(".");
    if (!userId || !sig) return null;
    const expected = crypto.createHmac("sha256", SECRET).update(userId).digest("hex").slice(0, 32);
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return userId;
  } catch { return null; }
}
function getUserId(req, url) {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) return verifyToken(auth.slice(7));
  const t = url.searchParams.get("token");
  return verifyToken(t);
}
function uid(prefix) { return prefix + crypto.randomBytes(6).toString("hex"); }

/* ---------------- SSE ---------------- */
const clients = new Map(); // userId -> Set<res>
function broadcastPresence() {
  sseBroadcast("presence", { count: clients.size });
}
function sseRegister(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  broadcastPresence();
}
function sseEmit(userId, event, data) {
  const set = clients.get(userId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  set.forEach((res) => { try { res.write(payload); } catch {} });
}
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((set) => set.forEach((res) => { try { res.write(payload); } catch {} }));
}
function sseRemove(userId, res) {
  const set = clients.get(userId);
  if (set) { set.delete(res); if (!set.size) clients.delete(userId); }
  broadcastPresence();
}

/* ---------------- login rate limiting ---------------- */
const loginAttempts = new Map();
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return xf.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}
function checkLoginRateLimit(req, email) {
  const key = getClientIp(req) + "|" + String(email || "").toLowerCase();
  const now = Date.now();
  const rec = loginAttempts.get(key) || { count: 0, firstAt: now, lockedUntil: 0 };
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return { blocked: true, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  if (now - rec.firstAt > 10 * 60 * 1000) { rec.count = 0; rec.firstAt = now; rec.lockedUntil = 0; }
  loginAttempts.set(key, rec);
  return { blocked: false, rec, key };
}
function registerFailedLogin(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return;
  rec.count += 1;
  if (rec.count >= 8) rec.lockedUntil = Date.now() + 5 * 60 * 1000;
  loginAttempts.set(key, rec);
}
function clearLoginAttempts(key) { loginAttempts.delete(key); }

/* ---------------- helpers ---------------- */
function send(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer-when-downgrade",
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 100 * 1024 * 1024) req.destroy(); });
    req.on("end", () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
/* Serialize a value for a PostgreSQL jsonb column. node-postgres renders
   top-level JS arrays as PostgreSQL array literals ({...}) instead of JSON,
   which makes Aiven/Postgres reject the input (SQLSTATE 22P02). Always pass
   a valid JSON *string* explicitly. Already-string values are passed through
   (validated) so we never double-encode. */
function toJson(v) {
  if (typeof v === "string") {
    try { JSON.parse(v); return v; } catch { return JSON.stringify([v]); }
  }
  if (v === null || v === undefined) return "[]";
  return JSON.stringify(v);
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
async function sendVerificationEmail(email, code) {
  const subject = "Verify your seller account";
  const text = `Hello,\n\nYou requested verification for your seller account.\n\nYour verification code is:\n\n${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, you can safely ignore this email.`;
  const html = `<p>Hello,</p><p>You requested verification for your seller account.</p><p>Your verification code is: <b>${code}</b></p><p>This code expires in 10 minutes.</p><p>If you did not request this code, you can safely ignore this email.</p>`;
  const url = process.env.EMAIL_API_URL;
  const key = process.env.EMAIL_API_KEY;
  if (url && key) {
    try {
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify({ to: email, subject, text, html }) });
    } catch (e) { console.error("Email send failed:", e.message); }
  } else {
    console.log(`\n[VERIFICATION EMAIL] To: ${email}\nSubject: ${subject}\nCode: ${code}\n(dev mode — set EMAIL_API_URL + EMAIL_API_KEY to deliver real emails.)\n`);
  }
}
async function addNotification({ userId, type, text, time = "just now", createdAt = Date.now() }) {
  const id = uid("n");
  await q(
    "INSERT INTO notifications (id,user_id,type,text,unread,time,created_at) VALUES ($1,$2,$3,$4,true,$5,$6)",
    [id, userId, type, text, time, createdAt]
  );
  const note = { id, userId, type, text, unread: true, time, createdAt };
  sseEmit(userId, "notification", note);
  return note;
}
function productWithSeller(prod, sellersMap) {
  if (!prod) return null;
  return { ...prod, seller: (sellersMap && sellersMap[prod.sellerId]) || null };
}

/* ---------------- conversations ---------------- */
async function getConversationFull(id) {
  const r = await q("SELECT * FROM conversations WHERE id=$1", [id]);
  return r.rows[0] || null;
}
async function saveConversation(conv) {
  await q(
    "UPDATE conversations SET messages=$1, last_message=$2, last_time=$3, last_created_at=$4, unread=$5, product_id=$6 WHERE id=$7",
    [toJson(conv.messages), conv.last_message, conv.last_time, conv.last_created_at, toJson(conv.unread), conv.product_id, conv.id]
  );
}
async function ensureConversation(a, b, productId) {
  const r = await q("SELECT * FROM conversations WHERE participant_ids @> $1::jsonb", [JSON.stringify([a, b])]);
  let conv = r.rows.find((c) => {
    const ids = c.participant_ids || [];
    const hasBoth = ids.includes(a) && ids.includes(b);
    const prodMatch = productId ? c.product_id === productId : true;
    return hasBoth && prodMatch;
  });
  if (!conv) {
    const id = uid("c");
    conv = {
      id,
      participant_ids: [a, b],
      product_id: productId || null,
      messages: [],
      last_message: "",
      last_time: "",
      last_created_at: null,
      unread: { [a]: 0, [b]: 0 },
      created_at: Date.now(),
    };
    await q(
      "INSERT INTO conversations (id,participant_ids,product_id,messages,last_message,last_time,last_created_at,unread,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, toJson(conv.participant_ids), conv.product_id, toJson(conv.messages), conv.last_message, conv.last_time, conv.last_created_at, toJson(conv.unread), conv.created_at]
    );
    conv = (await q("SELECT * FROM conversations WHERE id=$1", [id])).rows[0];
  }
  return conv;
}
async function appendMessage(conv, senderId, text, image) {
  const other = (conv.participant_ids || []).find((p) => p !== senderId);
  const now = Date.now();
  const time = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const msg = { id: uid("m"), senderId, text, image: image || null, time, createdAt: now };
  conv.messages = conv.messages || [];
  conv.messages.push(msg);
  conv.last_message = text; conv.last_time = time; conv.last_created_at = now;
  conv.unread = conv.unread || {};
  conv.unread[other] = (conv.unread[other] || 0) + 1;
  await saveConversation(conv);
  sseEmit(senderId, "message", { conversationId: conv.id, message: msg });
  sseEmit(other, "message", { conversationId: conv.id, message: msg });
  const sender = await getCleanUserById(senderId);
  await addNotification({ userId: other, type: "msg", text: `<b>${escHtml(sender ? sender.name : "Someone")}</b> sent you a message.`, createdAt: now });
  return msg;
}
async function decorateConversation(conv, me) {
  const otherId = (conv.participant_ids || []).find((p) => p !== me);
  const other = await getCleanUserById(otherId);
  let product = null;
  if (conv.product_id) {
    const pr = await q("SELECT id,title,images FROM products WHERE id=$1", [conv.product_id]);
    const prow = pr.rows[0];
    if (prow) product = { id: prow.id, title: prow.title, image: (Array.isArray(prow.images) && prow.images[0]) || null };
  }
  return {
    id: conv.id,
    productId: conv.product_id,
    other,
    unread: (conv.unread && conv.unread[me]) || 0,
    lastMessage: conv.last_message,
    lastTime: conv.last_time,
    lastCreatedAt: conv.last_created_at || conv.created_at,
    preview: conv.last_message,
    product,
  };
}

/* ---------------- API ---------------- */
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const seg = parts.slice(1);
  const method = req.method;
  const uid_user = getUserId(req, url);

  // block suspended accounts from mutating
  if (uid_user) {
    const au = await getUserFullById(uid_user);
    if (au && (await isBannedUser(au)) && method !== "GET" && seg[0] !== "auth" && seg[0] !== "me") {
      return send(res, 403, { error: "This account has been suspended." });
    }
  }

  // /api/auth/...
  if (seg[0] === "auth") {
    if (seg[1] === "register" && method === "POST") {
      const b = await readBody(req);
      if (!b.name || !b.email || !b.password) return send(res, 400, { error: "Name, email and password are required." });
      const email = String(b.email).trim().toLowerCase();
      const existing = await q("SELECT id FROM users WHERE email=$1", [email]);
      if (existing.rows.length) return send(res, 409, { error: "An account with that email already exists." });
      const bannedCheck = await q("SELECT 1 FROM banned WHERE email=$1 LIMIT 1", [email]);
      if (bannedCheck.rows.length) return send(res, 403, { error: "This email is not allowed to register." });
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(b.password, salt, 64).toString("hex");
      const id = uid("u");
      await q(
        `INSERT INTO users
          (id,name,email,password_hash,password_salt,role,location,bio,avatar,is_admin,rating,ratings_count,listings,sold,reviews,created_at,email_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,0,0,0,0,0,$10,false)`,
        [id, b.name.trim(), email, hash, salt, b.role || "Student", b.location || "Main Campus", b.bio || "", b.avatar || "", Date.now()]
      );
      const user = await getCleanUserById(id);
      return send(res, 201, { token: makeToken(user.id), user });
    }
    if (seg[1] === "login" && method === "POST") {
      const b = await readBody(req);
      const rl = checkLoginRateLimit(req, b.email);
      if (rl.blocked) return send(res, 429, { error: `Too many attempts. Try again in ${rl.retryAfterSec}s.` });
      const user = await getUserFullByEmail(b.email);
      if (!user) { registerFailedLogin(rl.key); return send(res, 401, { error: "Invalid email or password." }); }
      const hash = crypto.scryptSync(b.password, user.salt, 64).toString("hex");
      if (hash !== user.hash) { registerFailedLogin(rl.key); return send(res, 401, { error: "Invalid email or password." }); }
      if (await isBannedUser(user)) return send(res, 403, { error: "This account has been suspended." });
      clearLoginAttempts(rl.key);
      return send(res, 200, { token: makeToken(user.id), user: cleanUser(user) });
    }
    if (seg[1] === "me" && method === "GET") {
      if (!uid_user) return send(res, 401, { error: "Not authenticated." });
      const user = await getCleanUserById(uid_user);
      if (!user) return send(res, 401, { error: "Not authenticated." });
      return send(res, 200, { user });
    }
  }

  // /api/verify/...
  if (seg[0] === "verify") {
    if (!uid_user) return send(res, 401, { error: "Not authenticated." });
    const u = await getUserFullById(uid_user);
    if (!u) return send(res, 401, { error: "Not authenticated." });
    if (seg[1] === "send" && method === "POST") {
      const b = await readBody(req);
      const email = String((b && b.email) || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: "Please enter a valid email address." });
      const now = Date.now();
      u.verifyCooldownUntil = u.verifyCooldownUntil || 0;
      if (now < u.verifyCooldownUntil) {
        const secs = Math.ceil((u.verifyCooldownUntil - now) / 1000);
        return send(res, 429, { error: `Please wait ${secs}s before requesting another code.` });
      }
      u.verifySendWindowStart = u.verifySendWindowStart || 0;
      if (now - u.verifySendWindowStart > 10 * 60 * 1000) { u.verifySendWindowStart = now; u.verifySendCount = 0; }
      if ((u.verifySendCount || 0) >= 5) return send(res, 429, { error: "Too many verification requests. Try again later." });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.scryptSync(code, salt, 64).toString("hex");
      u.verificationCodeHash = hash;
      u.verificationCodeSalt = salt;
      u.verificationCodeExpiresAt = now + 10 * 60 * 1000;
      u.verificationEmail = email;
      u.verifyAttempts = 0;
      u.verifyCooldownUntil = now + 60 * 1000;
      u.verifySendCount = (u.verifySendCount || 0) + 1;
      await q(
        "UPDATE users SET verification_code_hash=$1, verification_code_salt=$2, verification_code_expires_at=$3, verification_email=$4, verify_attempts=$5, verify_cooldown_until=$6, verify_send_count=$7, verify_send_window_start=$8 WHERE id=$9",
        [hash, salt, u.verificationCodeExpiresAt, email, u.verifyAttempts, u.verifyCooldownUntil, u.verifySendCount, u.verifySendWindowStart, u.id]
      );
      await sendVerificationEmail(email, code);
      return send(res, 200, { ok: true });
    }
    if (seg[1] === "check" && method === "POST") {
      const b = await readBody(req);
      const code = String((b && b.code) || "").trim();
      if (!u.verificationCodeHash || !u.verificationCodeSalt || !u.verificationCodeExpiresAt)
        return send(res, 400, { error: "No verification code requested. Request a new code." });
      if (Date.now() > u.verificationCodeExpiresAt)
        return send(res, 400, { error: "This code has expired. Request a new one." });
      if (!/^\d{6}$/.test(code)) return send(res, 400, { error: "Enter the 6-digit code." });
      u.verifyAttempts = (u.verifyAttempts || 0) + 1;
      if (u.verifyAttempts > 5) {
        await q("UPDATE users SET verification_code_hash=NULL, verification_code_salt=NULL, verification_code_expires_at=NULL WHERE id=$1", [u.id]);
        return send(res, 429, { error: "Too many incorrect attempts. Request a new code." });
      }
      const attemptHash = crypto.scryptSync(code, u.verificationCodeSalt, 64).toString("hex");
      if (attemptHash !== u.verificationCodeHash) {
        await q("UPDATE users SET verify_attempts=$1 WHERE id=$2", [u.verifyAttempts, u.id]);
        return send(res, 400, { error: "Incorrect code. Try again." });
      }
      await q(
        "UPDATE users SET email_verified=true, verification_code_hash=NULL, verification_code_salt=NULL, verification_code_expires_at=NULL, verification_email=NULL, verify_attempts=0 WHERE id=$1",
        [u.id]
      );
      const updated = await getCleanUserById(u.id);
      return send(res, 200, { ok: true, verified: true, user: updated });
    }
    return send(res, 404, { error: "Not found." });
  }

  // /api/me
  if (seg[0] === "me" && method === "GET") {
    if (!uid_user) return send(res, 401, { error: "Not authenticated." });
    const user = await getCleanUserById(uid_user);
    if (!user) return send(res, 401, { error: "Not authenticated." });
    return send(res, 200, { user });
  }

  // /api/users/...
  if (seg[0] === "users" && seg[1]) {
    const userId = seg[1];
    if (seg[2] === "products" && method === "GET") {
      const r = await q("SELECT * FROM products WHERE seller_id=$1 AND status <> 'Removed'", [userId]);
      const list = r.rows.map(rowToProduct).sort((a, b) => b.createdAt - a.createdAt);
      const sellers = await getSellersMap(list.map((p) => p.sellerId));
      return send(res, 200, { products: list.map((p) => productWithSeller(p, sellers)) });
    }
    if (seg[2] === "rating" && method === "POST") {
      if (!uid_user) return send(res, 401, { error: "Not authenticated." });
      const b = await readBody(req);
      const stars = Number(b.stars);
      if (!(stars >= 1 && stars <= 5)) return send(res, 400, { error: "Invalid rating." });
      const full = await getUserFullById(userId);
      if (!full) return send(res, 404, { error: "User not found." });
      if (uid_user === userId) return send(res, 400, { error: "You can't rate yourself." });
      const rating = +(((full.rating * full.ratingsCount) + stars) / (full.ratingsCount + 1)).toFixed(2);
      const ratingsCount = full.ratingsCount + 1;
      const reviews = full.reviews + 1;
      await q("UPDATE users SET rating=$1, ratings_count=$2, reviews=$3 WHERE id=$4", [rating, ratingsCount, reviews, userId]);
      return send(res, 200, { rating, ratingsCount });
    }
    if (!seg[2] && method === "GET") {
      const user = await getCleanUserById(userId);
      return send(res, user ? 200 : 404, user ? { user } : { error: "Not found." });
    }
    if (!seg[2] && method === "PUT") {
      if (uid_user !== userId) return send(res, 403, { error: "Forbidden." });
      const b = await readBody(req);
      const sets = []; const params = []; let i = 1;
      ["name", "role", "location", "bio", "avatar"].forEach((k) => {
        if (b[k] !== undefined) { sets.push(`${k}=$${i++}`); params.push(b[k]); }
      });
      if (!sets.length) return send(res, 400, { error: "Nothing to update." });
      params.push(userId);
      await q(`UPDATE users SET ${sets.join(", ")} WHERE id=$${i}`, params);
      const updated = await getCleanUserById(userId);
      return send(res, 200, { user: updated });
    }
  }

  // /api/favorites
  if (seg[0] === "favorites") {
    if (!uid_user) return send(res, 401, { error: "Not authenticated." });
    if (method === "GET") {
      const fr = await q("SELECT product_id FROM favorites WHERE user_id=$1", [uid_user]);
      const ids = fr.rows.map((r) => r.product_id);
      const prods = ids.length ? (await q("SELECT * FROM products WHERE id = ANY($1::text[])", [ids])).rows.map(rowToProduct) : [];
      const sellers = await getSellersMap(prods.map((p) => p.sellerId));
      return send(res, 200, { productIds: ids, products: prods.map((p) => productWithSeller(p, sellers)) });
    }
    if (method === "POST") {
      const b = await readBody(req);
      const pid = b.productId;
      const ex = await q("SELECT 1 FROM favorites WHERE user_id=$1 AND product_id=$2", [uid_user, pid]);
      if (!ex.rows.length) {
        await q("INSERT INTO favorites (user_id,product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [uid_user, pid]);
        const prodRow = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
        if (prodRow && prodRow.seller_id !== uid_user) {
          const seller = await getCleanUserById(uid_user);
          await addNotification({ userId: prodRow.seller_id, type: "fav", text: `<b>${escHtml(seller ? seller.name : "Someone")}</b> saved your <b>${escHtml(prodRow.title)}</b>.`, createdAt: Date.now() });
        }
      }
      return send(res, 200, { ok: true, favorited: true });
    }
  }
  if (seg[0] === "favorites" && seg[1] && method === "DELETE") {
    if (!uid_user) return send(res, 401, { error: "Not authenticated." });
    await q("DELETE FROM favorites WHERE user_id=$1 AND product_id=$2", [uid_user, seg[1]]);
    return send(res, 200, { ok: true, favorited: false });
  }

  // /api/products
  if (seg[0] === "products") {
    if (!seg[1]) {
      if (method === "GET") {
        const qp = url.searchParams;
        const cat = qp.get("cat") || "";
        const cond = qp.get("cond") || "";
        const max = qp.get("max");
        const loc = (qp.get("loc") || "").toLowerCase();
        const seller = qp.get("seller") || "";
        const sort = qp.get("sort") || "new";
        const sqlParams = [];
        let sql = "SELECT * FROM products WHERE status <> 'Removed'";
        if (cat) { sqlParams.push(cat); sql += ` AND category=$${sqlParams.length}`; }
        if (cond) { sqlParams.push(cond); sql += ` AND condition=$${sqlParams.length}`; }
        if (max) { sqlParams.push(Number(max)); sql += ` AND price <= $${sqlParams.length}`; }
        if (loc) { sqlParams.push("%" + loc + "%"); sql += ` AND location ILIKE $${sqlParams.length}`; }
        if (seller) { sqlParams.push(seller); sql += ` AND seller_id=$${sqlParams.length}`; }
        const r = await q(sql, sqlParams);
        let list = r.rows.map(rowToProduct);
        const qterm = (qp.get("q") || "").toLowerCase();
        if (qterm) list = list.filter((x) => x.title.toLowerCase().includes(qterm) || x.description.toLowerCase().includes(qterm));
        if (sort === "new") list.sort((a, b) => b.createdAt - a.createdAt);
        else if (sort === "price-asc") list.sort((a, b) => a.price - b.price);
        else if (sort === "price-desc") list.sort((a, b) => b.price - a.price);
        const sellers = await getSellersMap(list.map((p) => p.sellerId));
        return send(res, 200, { products: list.map((p) => productWithSeller(p, sellers)) });
      }
      if (method === "POST") {
        if (!uid_user) return send(res, 401, { error: "Not authenticated." });
        const b = await readBody(req);
        if (!b.title || !b.category || !b.condition || !b.location)
          return send(res, 400, { error: "Please fill in all required fields." });
        const price = Number(b.price);
        if (!Number.isFinite(price) || price < 0)
          return send(res, 400, { error: "Please enter a valid price." });
        const id = uid("p");
        const images = Array.isArray(b.images) ? b.images : [];
        await q(
          "INSERT INTO products (id,seller_id,title,price,description,category,condition,location,status,images,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [id, uid_user, b.title, price, b.description || "", b.category, b.condition, b.location, b.status || "Available", toJson(images), Date.now()]
        );
        await q("UPDATE users SET listings = listings + 1 WHERE id=$1", [uid_user]);
        const prodRow = (await q("SELECT * FROM products WHERE id=$1", [id])).rows[0];
        const sellers = await getSellersMap([uid_user]);
        return send(res, 201, { product: productWithSeller(rowToProduct(prodRow), sellers) });
      }
    }
    const pid = seg[1];
    if (seg[2] === "favorite" && method === "POST") {
      if (!uid_user) return send(res, 401, { error: "Not authenticated." });
      const ex = await q("SELECT 1 FROM favorites WHERE user_id=$1 AND product_id=$2", [uid_user, pid]);
      if (!ex.rows.length) {
        await q("INSERT INTO favorites (user_id,product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [uid_user, pid]);
        const prodRow = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
        if (prodRow && prodRow.seller_id !== uid_user) {
          const seller = await getCleanUserById(uid_user);
          await addNotification({ userId: prodRow.seller_id, type: "fav", text: `<b>${escHtml(seller ? seller.name : "Someone")}</b> saved your <b>${escHtml(prodRow.title)}</b>.`, createdAt: Date.now() });
        }
      }
      return send(res, 200, { ok: true, favorited: true });
    }
    if (seg[2] === "favorite" && method === "DELETE") {
      if (!uid_user) return send(res, 401, { error: "Not authenticated." });
      await q("DELETE FROM favorites WHERE user_id=$1 AND product_id=$2", [uid_user, pid]);
      return send(res, 200, { ok: true, favorited: false });
    }
    if (seg[2] === "contact" && method === "POST") {
      if (!uid_user) return send(res, 401, { error: "Not authenticated." });
      const prodRow = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      if (!prodRow) return send(res, 404, { error: "Product not found." });
      const b = await readBody(req);
      const conv = await ensureConversation(uid_user, prodRow.seller_id, pid);
      const firstImg = (Array.isArray(prodRow.images) && prodRow.images[0]) || null;
      const text = (b.text && b.text.trim()) ? b.text.trim() : "Is this still available?";
      await appendMessage(conv, uid_user, text, firstImg);
      return send(res, 200, { conversationId: conv.id });
    }
    if (seg[2] === "reviews" && method === "POST") {
      if (!uid_user) return send(res, 401, { error: "Not authenticated." });
      const prodRow = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      if (!prodRow) return send(res, 404, { error: "Product not found." });
      if (prodRow.seller_id === uid_user) return send(res, 400, { error: "You can't review your own item." });
      const b = await readBody(req);
      const starsN = Number(b.stars);
      if (!(starsN >= 1 && starsN <= 5)) return send(res, 400, { error: "Rating must be between 1 and 5 stars." });
      const text = (b.comment || "").trim();
      if (!text) return send(res, 400, { error: "Please add a comment with your review." });
      const u = await getCleanUserById(uid_user);
      const reviewsArr = Array.isArray(prodRow.reviews) ? prodRow.reviews : [];
      const existing = reviewsArr.find((r) => r.userId === uid_user);
      const reviewObj = { id: uid("r"), userId: uid_user, name: u ? u.name : "Anonymous", stars: starsN, comment: text, createdAt: Date.now() };
      if (existing) { existing.stars = starsN; existing.comment = text; existing.name = u ? u.name : "Anonymous"; existing.createdAt = Date.now(); }
      else reviewsArr.push(reviewObj);
      const newRating = +(reviewsArr.reduce((a, r) => a + r.stars, 0) / reviewsArr.length).toFixed(2);
        await q("UPDATE products SET reviews=$1, rating=$2, rating_count=$3 WHERE id=$4", [toJson(reviewsArr), newRating, reviewsArr.length, pid]);
      await addNotification({ userId: prodRow.seller_id, type: "rate", text: `<b>${escHtml(u ? u.name : "Someone")}</b> left a ⭐ ${starsN.toFixed(1)} review on <b>${escHtml(prodRow.title)}</b>.`, createdAt: Date.now() });
      const updated = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      const sellers = await getSellersMap([updated.seller_id]);
      return send(res, 201, { product: productWithSeller(rowToProduct(updated), sellers) });
    }
    if (seg[2] === "sold" && method === "POST") {
      if (!uid_user) return send(res, 401, { error: "Not authenticated." });
      const prodRow = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      if (!prodRow) return send(res, 404, { error: "Product not found." });
      if (prodRow.seller_id !== uid_user) return send(res, 403, { error: "Only the seller can mark this item as sold." });
      if (prodRow.status === "Sold") return send(res, 400, { error: "This item is already marked as sold." });
      await q("UPDATE products SET status='Sold', sold_at=$1 WHERE id=$2", [Date.now(), pid]);
      await q("UPDATE users SET sold = sold + 1 WHERE id=$1", [uid_user]);
      await addNotification({ userId: uid_user, type: "sold", text: `Your <b>${escHtml(prodRow.title)}</b> was marked as sold. ✅`, createdAt: Date.now() });
      const updated = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      const sellers = await getSellersMap([updated.seller_id]);
      return send(res, 200, { product: productWithSeller(rowToProduct(updated), sellers) });
    }
    if (seg[2] === "confirm" && method === "POST") {
      if (!uid_user) return send(res, 401, { error: "Not authenticated." });
      const prodRow = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      if (!prodRow) return send(res, 404, { error: "Product not found." });
      if (prodRow.seller_id === uid_user) return send(res, 400, { error: "You can't confirm your own sale." });
      if (prodRow.status !== "Sold") return send(res, 400, { error: "This item hasn't been marked as sold yet." });
      const confirmations = Array.isArray(prodRow.confirmations) ? prodRow.confirmations : [];
      if (!confirmations.includes(uid_user)) {
        confirmations.push(uid_user);
        await q("UPDATE products SET confirmations=$1 WHERE id=$2", [toJson(confirmations), pid]);
        const u = await getCleanUserById(uid_user);
        await addNotification({ userId: prodRow.seller_id, type: "sold", text: `<b>${escHtml(u ? u.name : "A buyer")}</b> confirmed they received your <b>${escHtml(prodRow.title)}</b>. ✅`, createdAt: Date.now() });
      }
      const updated = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      const sellers = await getSellersMap([updated.seller_id]);
      return send(res, 200, { product: productWithSeller(rowToProduct(updated), sellers) });
    }
    if (seg[2] === "report" && method === "POST") {
      if (!uid_user) return send(res, 401, { error: "Not authenticated." });
      const prodRow = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      if (!prodRow) return send(res, 404, { error: "Product not found." });
      const b = await readBody(req);
      const reason = (b.reason || "Other").toString().trim() || "Other";
      const text = (b.text || "").toString().trim();
      const id = uid("rep");
      await q(
        "INSERT INTO reports (id,product_id,reporter_id,reason,text,status,created_at) VALUES ($1,$2,$3,$4,$5,'open',$6)",
        [id, pid, uid_user, reason, text, Date.now()]
      );
      return send(res, 201, { ok: true });
    }
    if (!seg[2] && method === "GET") {
      const prodRow = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      if (!prodRow) return send(res, 404, { error: "Not found." });
      const sellers = await getSellersMap([prodRow.seller_id]);
      return send(res, 200, { product: productWithSeller(rowToProduct(prodRow), sellers) });
    }
    if (!seg[2] && method === "PUT") {
      const prodRow = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      if (!prodRow) return send(res, 404, { error: "Not found." });
      if (prodRow.seller_id !== uid_user) return send(res, 403, { error: "Forbidden." });
      const b = await readBody(req);
      const allowed = { title: true, price: true, description: true, category: true, condition: true, location: true, status: true, images: true };
      const sets = []; const params = []; let i = 1;
      for (const k of Object.keys(b)) {
        if (k === "price") { sets.push(`price=$${i++}`); params.push(Number(b.price)); }
        else if (k === "images") { sets.push(`images=$${i++}`); params.push(toJson(b.images)); }
        else if (allowed[k] && b[k] !== undefined) { sets.push(`${k}=$${i++}`); params.push(b[k]); }
      }
      if (sets.length) { params.push(pid); await q(`UPDATE products SET ${sets.join(", ")} WHERE id=$${i}`, params); }
      const updated = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      const sellers = await getSellersMap([updated.seller_id]);
      return send(res, 200, { product: productWithSeller(rowToProduct(updated), sellers) });
    }
    if (!seg[2] && method === "DELETE") {
      const prodRow = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      if (!prodRow) return send(res, 404, { error: "Not found." });
      if (prodRow.seller_id !== uid_user) return send(res, 403, { error: "Forbidden." });
      await q("UPDATE products SET status='Removed' WHERE id=$1", [pid]);
      if (prodRow.seller_id) await q("UPDATE users SET listings = GREATEST(0, listings - 1) WHERE id=$1", [prodRow.seller_id]);
      return send(res, 200, { ok: true });
    }
  }

  // /api/conversations
  if (seg[0] === "conversations") {
    if (!uid_user) return send(res, 401, { error: "Not authenticated." });
    if (!seg[1]) {
      if (method === "GET") {
        const r = await q("SELECT * FROM conversations WHERE participant_ids @> $1::jsonb", [JSON.stringify([uid_user])]);
        const list = [];
        for (const conv of r.rows) list.push(await decorateConversation(conv, uid_user));
        list.sort((a, b) => b.lastCreatedAt - a.lastCreatedAt);
        return send(res, 200, { conversations: list });
      }
      if (method === "POST") {
        const b = await readBody(req);
        let other = b.otherId || (b.productId ? ((await q("SELECT seller_id FROM products WHERE id=$1", [b.productId])).rows[0] || {}).seller_id : null);
        if (!other || other === uid_user) return send(res, 400, { error: "Invalid recipient." });
        const conv = await ensureConversation(uid_user, other, b.productId);
        if (b.text && b.text.trim()) await appendMessage(conv, uid_user, b.text.trim());
        return send(res, 200, { conversation: await decorateConversation(conv, uid_user) });
      }
    }
    const cid = seg[1];
    const conv = await getConversationFull(cid);
    if (!conv || !(conv.participant_ids || []).includes(uid_user)) return send(res, 403, { error: "Forbidden." });
    if (seg[2] === "messages" && method === "GET") {
      return send(res, 200, { messages: conv.messages || [] });
    }
    if (seg[2] === "messages" && method === "POST") {
      const b = await readBody(req);
      if (!b.text || !b.text.trim()) return send(res, 400, { error: "Empty message." });
      const msg = await appendMessage(conv, uid_user, b.text.trim(), b.image || null);
      return send(res, 201, { message: msg });
    }
    if (seg[2] === "read" && method === "POST") {
      conv.unread = conv.unread || {};
      conv.unread[uid_user] = 0;
      await saveConversation(conv);
      return send(res, 200, { ok: true });
    }
  }

  // /api/notifications
  if (seg[0] === "notifications") {
    if (!uid_user) return send(res, 401, { error: "Not authenticated." });
    if (method === "GET") {
      const r = await q("SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC", [uid_user]);
      const list = r.rows.map((row) => ({
        id: row.id, userId: row.user_id, type: row.type, text: row.text, unread: row.unread, time: row.time, createdAt: parseInt(row.created_at) || 0,
      }));
      return send(res, 200, { notifications: list, unread: list.filter((x) => x.unread).length });
    }
    if (seg[1] === "read" && method === "POST") {
      const b = await readBody(req);
      if (b.id) await q("UPDATE notifications SET unread=false WHERE user_id=$1 AND id=$2", [uid_user, b.id]);
      else await q("UPDATE notifications SET unread=false WHERE user_id=$1", [uid_user]);
      return send(res, 200, { ok: true });
    }
  }

  // /api/announcements (public)
  if (seg[0] === "announcements" && !seg[1] && method === "GET") {
    const r = await q("SELECT * FROM announcements WHERE active=true ORDER BY created_at DESC");
    const list = r.rows.map((row) => ({ id: row.id, text: row.text, active: row.active, createdAt: parseInt(row.created_at) || 0 }));
    return send(res, 200, { announcements: list });
  }

  // /api/admin/...
  if (seg[0] === "admin") {
    const admin = uid_user ? await getUserFullById(uid_user) : null;
    if (!admin || !admin.isAdmin) return send(res, 403, { error: "Admin access required." });

    if (seg[1] === "reports" && method === "GET") {
      const r = await q(
        `SELECT r.*, p.title AS p_title, p.images AS p_images, p.seller_id AS p_seller
         FROM reports r LEFT JOIN products p ON p.id = r.product_id ORDER BY r.created_at DESC`
      );
      const list = r.rows.map((row) => ({
        id: row.id, productId: row.product_id, reporterId: row.reporter_id, reason: row.reason, text: row.text, status: row.status, createdAt: parseInt(row.created_at) || 0,
        product: row.p_title ? { id: row.product_id, title: row.p_title, image: (Array.isArray(row.p_images) && row.p_images[0]) || null, sellerId: row.p_seller } : null,
        reporter: null,
      }));
      const repIds = [...new Set(list.map((x) => x.reporterId).filter(Boolean))];
      if (repIds.length) {
        const repRows = (await q(`SELECT ${USER_COLS} FROM users WHERE id = ANY($1::text[])`, [repIds])).rows.map(cleanUser);
        const repMap = {}; repRows.forEach((u) => { repMap[u.id] = u; });
        list.forEach((x) => { x.reporter = x.reporterId ? { id: x.reporterId, name: repMap[x.reporterId] ? repMap[x.reporterId].name : "Unknown" } : null; });
      }
      return send(res, 200, { reports: list });
    }
    if (seg[1] === "reports" && seg[2] === "resolve" && method === "POST") {
      const b = await readBody(req);
      await q("UPDATE reports SET status='resolved' WHERE id=$1", [b.id]);
      return send(res, 200, { ok: true });
    }
    if (seg[1] === "products" && seg[2] === "remove" && method === "POST") {
      const b = await readBody(req);
      const pid = b.productId || seg[3];
      const row = (await q("SELECT * FROM products WHERE id=$1", [pid])).rows[0];
      if (!row) return send(res, 404, { error: "Product not found." });
      const removed = rowToProduct(row);
      await q("DELETE FROM products WHERE id=$1", [pid]);
      if (removed.sellerId) await q("UPDATE users SET listings = GREATEST(0, listings - 1) WHERE id=$1", [removed.sellerId]);
      await addNotification({ userId: removed.sellerId, type: "sold", text: `Your listing <b>${escHtml(removed.title)}</b> was removed by a moderator.`, createdAt: Date.now() });
      sseEmit(removed.sellerId, "productRemoved", { productId: removed.id });
      return send(res, 200, { ok: true });
    }
    if (seg[1] === "users" && method === "GET") {
      const ur = await q(`SELECT ${USER_COLS} FROM users`);
      const users = ur.rows.map(cleanUser).map(async (u) => ({ ...u, banned: await isBannedUser(u) }));
      const resolved = await Promise.all(users);
      const br = await q("SELECT email, user_id FROM banned");
      const banned = br.rows.map((row) => ({ email: row.email, userId: row.user_id }));
      return send(res, 200, { users: resolved, banned });
    }
    if (seg[1] === "ban" && method === "POST") {
      const b = await readBody(req);
      const email = b.email ? String(b.email).trim().toLowerCase() : null;
      const userId = b.userId ? String(b.userId).trim() : null;
      if (!email && !userId) return send(res, 400, { error: "Provide an email or user ID." });
      await q("INSERT INTO banned (email,user_id,created_at) VALUES ($1,$2,$3)", [email, userId, Date.now()]);
      const br = await q("SELECT email, user_id FROM banned");
      return send(res, 200, { ok: true, banned: br.rows.map((row) => ({ email: row.email, userId: row.user_id })) });
    }
    if (seg[1] === "unban" && method === "POST") {
      const b = await readBody(req);
      const email = b.email ? String(b.email).trim().toLowerCase() : null;
      const userId = b.userId ? String(b.userId).trim() : null;
      if (email) await q("DELETE FROM banned WHERE email=$1", [email]);
      if (userId) await q("DELETE FROM banned WHERE user_id=$1", [userId]);
      const br = await q("SELECT email, user_id FROM banned");
      return send(res, 200, { ok: true, banned: br.rows.map((row) => ({ email: row.email, userId: row.user_id })) });
    }
    if (seg[1] === "announcements" && method === "GET") {
      const r = await q("SELECT * FROM announcements ORDER BY created_at DESC");
      const list = r.rows.map((row) => ({ id: row.id, text: row.text, active: row.active, createdAt: parseInt(row.created_at) || 0 }));
      return send(res, 200, { announcements: list });
    }
    if (seg[1] === "announcements" && method === "POST") {
      const b = await readBody(req);
      const text = (b.text || "").toString().trim();
      if (!text) return send(res, 400, { error: "Announcement text is required." });
      const id = uid("ann");
      await q("INSERT INTO announcements (id,text,active,created_at,by) VALUES ($1,$2,true,$3,$4)", [id, text, Date.now(), admin.id]);
      const ann = { id, text, active: true, createdAt: Date.now(), by: admin.id };
      sseBroadcast("announcement", ann);
      return send(res, 201, { announcement: ann });
    }
    if (seg[1] === "announcements" && seg[2] === "toggle" && method === "POST") {
      const b = await readBody(req);
      const r = await q("SELECT * FROM announcements WHERE id=$1", [b.id]);
      const ann = r.rows[0];
      if (ann) {
        const active = !ann.active;
        await q("UPDATE announcements SET active=$1 WHERE id=$2", [active, b.id]);
        const out = { id: ann.id, text: ann.text, active, createdAt: parseInt(ann.created_at) || 0 };
        sseBroadcast("announcement", out);
      }
      return send(res, 200, { ok: true });
    }
    if (seg[1] === "announcements" && seg[2] === "delete" && method === "POST") {
      const b = await readBody(req);
      await q("DELETE FROM announcements WHERE id=$1", [b.id]);
      sseBroadcast("announcement", { id: b.id, deleted: true });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "Not found." });
  }

  return send(res, 404, { error: "Not found." });
}

/* ---------------- static + server ---------------- */
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, "index.html"), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end("Not found"); }
        res.writeHead(200, { "Content-Type": "text/html" }); res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/stream") {
      const uid_user = getUserId(req, url);
      if (!uid_user) { res.writeHead(401); return res.end("unauthorized"); }
      res.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("\n");
      sseRegister(uid_user, res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
      req.on("close", () => { clearInterval(ping); sseRemove(uid_user, res); });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); return res.end(); }
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (err) {
    console.error("[API ERROR]", err && err.message, "\n", err && err.stack);
    if (!res.headersSent) send(res, 500, { error: "Server error: " + (err && err.message ? err.message : "unknown") });
  }
});

(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("  [db] Connected to PostgreSQL.");
    await migrate();
    await seedModerator();
  } catch (e) {
    console.error("\n  [FATAL] Could not connect to the database:", e.message);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`\n  CampusMarket running → http://localhost:${PORT}\n`);
  });
})();
