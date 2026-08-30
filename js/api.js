/* ============================================================
   CampusMarket — API client (fetch wrapper with auth token)
   ============================================================ */
window.CM = window.CM || {};

const API = {
  base: "",
  token: localStorage.getItem("cm_token") || null,

  setToken(t) {
    this.token = t;
    if (t) localStorage.setItem("cm_token", t);
    else localStorage.removeItem("cm_token");
  },
  headers(extra) {
    const h = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = "Bearer " + this.token;
    return Object.assign(h, extra || {});
  },
  async req(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      // the server flags a suspended account — let the app force a logout
      if (res.status === 403 && data && data.banned && window.CM && typeof window.CM.onBanned === "function") {
        window.CM.onBanned(data.error || "This account has been suspended.");
      }
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  },
  get(p) { return this.req("GET", p); },
  post(p, b) { return this.req("POST", p, b); },
  put(p, b) { return this.req("PUT", p, b); },
  del(p) { return this.req("DELETE", p); },

  /* auth */
  login(email, password) { return this.post("/api/auth/login", { email, password }); },
  register(payload) { return this.post("/api/auth/register", payload); },
  me() { return this.get("/api/me"); },

  /* products */
  products(params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();
    return this.get("/api/products" + (qs ? "?" + qs : ""));
  },
  product(id) { return this.get("/api/products/" + id); },
  createProduct(body) { return this.post("/api/products", body); },
  updateProduct(id, body) { return this.put("/api/products/" + id, body); },
  deleteProduct(id) { return this.del("/api/products/" + id); },
  contactSeller(id, text) { return this.post("/api/products/" + id + "/contact", { text }); },
  addReview(id, stars, comment) { return this.post("/api/products/" + id + "/reviews", { stars, comment }); },
  markSold(id) { return this.post("/api/products/" + id + "/sold", {}); },
  confirmSale(id) { return this.post("/api/products/" + id + "/confirm", {}); },
  reportProduct(id, reason, text) { return this.post("/api/products/" + id + "/report", { reason, text }); },
  announcements() { return this.get("/api/announcements"); },
  presence() { return this.get("/api/presence"); },

  /* verification */
  verifySend(email) { return this.post("/api/verify/send", { email }); },
  verifyCheck(code) { return this.post("/api/verify/check", { code }); },

  /* admin */
  adminReports() { return this.get("/api/admin/reports"); },
  adminResolveReport(id) { return this.post("/api/admin/reports/resolve", { id }); },
  adminRemoveProduct(pid) { return this.post("/api/admin/products/remove", { productId: pid }); },
  adminUsers() { return this.get("/api/admin/users"); },
  adminDeleteUser(payload) { return this.post("/api/admin/users/delete", payload); },
  adminBan(payload) { return this.post("/api/admin/ban", payload); },
  adminUnban(payload) { return this.post("/api/admin/unban", payload); },
  adminAnnouncements() { return this.get("/api/admin/announcements"); },
  adminPostAnnouncement(text) { return this.post("/api/admin/announcements", { text }); },
  adminToggleAnnouncement(id) { return this.post("/api/admin/announcements/toggle", { id }); },
  adminDeleteAnnouncement(id) { return this.post("/api/admin/announcements/delete", { id }); },

  /* favorites */
  favorites() { return this.get("/api/favorites"); },
  addFavorite(pid) { return this.post("/api/favorites", { productId: pid }); },
  removeFavorite(pid) { return this.del("/api/favorites/" + pid); },

  /* users */
  user(id) { return this.get("/api/users/" + id); },
  userProducts(id) { return this.get("/api/users/" + id + "/products"); },
  updateUser(id, body) { return this.put("/api/users/" + id, body); },
  rateUser(id, stars) { return this.post("/api/users/" + id + "/rating", { stars }); },

  /* conversations / messages */
  conversations() { return this.get("/api/conversations"); },
  conversation(id) { return this.get("/api/conversations/" + id + "/messages"); },
  createConversation(body) { return this.post("/api/conversations", body); },
  sendMessage(id, text) { return this.post("/api/conversations/" + id + "/messages", { text }); },
  readConversation(id) { return this.post("/api/conversations/" + id + "/read", {}); },

  /* notifications */
  notifications() { return this.get("/api/notifications"); },
  readNotifications(id) { return this.post("/api/notifications/read", id ? { id } : {}); },
};

window.API = API;
window.CM.API = API;
