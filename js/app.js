/* ============================================================
   CampusMarket — app.js  (API-driven frontend)
   ============================================================ */
(function () {
  "use strict";

  const { CATEGORIES, CONDITIONS, CAT_MAP, catIcon, gradFor } = window.CM;
  const API = window.API;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const view = $("#view");
  const modalRoot = $("#modalRoot");
  const searchOverlay = $("#searchOverlay");

  /* ---------------- client state ---------------- */
  const State = {
    me: null,
    favs: new Set(),
    conversations: [],
    notifications: [],
    activeConv: null,
    sse: null,
    ready: false,
    verifyPending: false,
  };

  /* ---------------- helpers ---------------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
  function money(n) { return "₦" + Number(n || 0).toLocaleString("en-NG"); }
  function stars(rating) { const f = Math.round(rating || 0); return "★".repeat(f) + "☆".repeat(5 - f); }
  function renderMsg(text) {
    const safe = esc(text);
    return safe.replace(/\d{8,}/g, (m) => `<span class="msg-num" data-num="${m}" title="Tap to copy">${m}</span>`);
  }
  function verifyBadge(u) {
    if (!u) return "";
    if (u.emailVerified) {
      return `<span class="vbadge vbadge--yes" title="Verified seller" aria-label="Verified seller"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>`;
    }
    return `<span class="vbadge vbadge--no" title="Unverified seller" aria-label="Unverified seller"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3z"/></svg></span>`;
  }
  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function currentHash() { return location.hash || "#/"; }

  function mediaHTML({ src, alt, cls = "", seed, emoji }) {
    if (src) return `<img src="${esc(src)}" alt="${esc(alt)}" class="${cls}" loading="lazy" data-seed="${esc(seed)}" data-emoji="${emoji || ""}" onerror="CM.imgFail(this)">`;
    const [c1, c2] = gradFor(seed + emoji);
    return `<div class="${cls} ph" style="background:linear-gradient(135deg,${c1},${c2})">${emoji || ""}</div>`;
  }
  window.CM.imgFail = function (el) {
    const seed = el.getAttribute("data-seed") || el.alt || "x";
    const emoji = el.getAttribute("data-emoji") || "🛍️";
    const [c1, c2] = gradFor(seed + emoji);
    const div = document.createElement("div");
    div.className = (el.className ? el.className + " " : "") + "ph";
    div.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
    div.textContent = emoji;
    el.replaceWith(div);
  };
  function avatarHTML(u, cls = "") {
    const src = u && u.avatar ? u.avatar : (u ? `https://i.pravatar.cc/120?u=${esc(u.id)}` : "");
    return mediaHTML({ src, alt: u ? u.name : "User", cls, seed: u ? u.id : "x", emoji: "🧑" });
  }

  /* ---------------- toasts ---------------- */
  function toast(title, msg, icon = "✓") {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<div class="toast__icon">${icon}</div><div><b>${esc(title)}</b>${msg ? `<span>${esc(msg)}</span>` : ""}</div>`;
    $("#toasts").appendChild(el);
    setTimeout(() => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove()); }, 3400);
  }

  /* ---------------- generic modal ---------------- */
  function openModal(html) { modalRoot.hidden = false; modalRoot.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`; }
  function closeModal() { modalRoot.hidden = true; modalRoot.innerHTML = ""; }
  modalRoot.addEventListener("click", (e) => { if (e.target === modalRoot) closeModal(); });

  /* ---------------- badges ---------------- */
  function updateBadges() {
    const fb = $("#favBadge");
    if (State.favs.size) { fb.textContent = State.favs.size; fb.hidden = false; } else fb.hidden = true;
    const ub = $("#msgBadge");
    const unread = State.conversations.reduce((a, c) => a + (c.unread || 0), 0);
    if (unread) { ub.textContent = unread; ub.hidden = false; } else ub.hidden = true;
    const nb = $("#notifBadge");
    const nu = State.notifications.filter((n) => n.unread).length;
    if (nu) { nb.textContent = nu; nb.hidden = false; } else nb.hidden = true;
  }

  /* ---------------- auth ---------------- */
  function updateNavUser() {
    const a = $(".nav__avatar");
    if (!a) return;
    if (State.me) a.innerHTML = avatarHTML(State.me);
    else a.innerHTML = `<img src="https://i.pravatar.cc/80?img=12" alt="You" onerror="this.style.background='#5b5bd6';this.removeAttribute('src')">`;
    const admin = !!(State.me && State.me.isAdmin);
    [$("#navAdmin"), $("#navAdminMobile")].forEach((el) => { if (el) el.style.display = admin ? "" : "none"; });
  }

  function openAuth(after) {
    let mode = "login";
    function paint() {
      openModal(`
        <div style="display:flex;gap:8px;margin-bottom:18px">
          <button class="btn ${mode === "login" ? "btn--primary" : "btn--ghost"} btn--block" data-mode="login">Log in</button>
          <button class="btn ${mode === "register" ? "btn--primary" : "btn--ghost"} btn--block" data-mode="register">Sign up</button>
        </div>
        <h3 style="font-size:1.4rem;margin-bottom:6px">${mode === "login" ? "Welcome back" : "Join CampusMarket"}</h3>
        <p style="color:var(--muted);margin-bottom:20px">${mode === "login" ? "Log in to buy and sell on campus." : "Create an account to list items and chat with sellers."}</p>
        <form id="authForm" class="form-grid">
          ${mode === "register" ? `<div class="field"><label>Full name</label><input class="field-input" name="name" required placeholder="e.g. Iwinosa"></div>` : ""}
          <div class="field"><label>Email</label><input class="field-input" name="email" type="email" required placeholder="you@campus.edu"></div>
          <div class="field"><label>Password</label><input class="field-input" name="password" type="password" required placeholder="••••••••" minlength="4"></div>
          ${mode === "register" ? `<div class="field"><label>Campus / Location</label><input class="field-input" name="location" placeholder="e.g. Main Campus"></div>` : ""}
          <button class="btn btn--primary btn--block btn--lg" type="submit" style="margin-top:6px">${mode === "login" ? "Log in" : "Create account"}</button>
        </form>
      `);
      modalRoot.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.mode; paint(); }));
      $("#authForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target).entries());
        try {
          let res;
          if (mode === "login") res = await API.login(fd.email, fd.password);
          else res = await API.register({ name: fd.name, email: fd.email, password: fd.password, location: fd.location || "Main Campus", role: "Student" });
          API.setToken(res.token);
          State.me = res.user;
          closeModal();
          updateNavUser();
          await loadUserData();
          updateBadges();
          toast("Welcome" + (State.me.name ? ", " + State.me.name.split(" ")[0] : ""), mode === "register" ? "Account created 🎉" : "You're logged in");
          if (after) after(); else router();
        } catch (err) { toast("Couldn't " + mode, err.message, "⚠️"); }
      });
    }
    paint();
  }

  function requireAuth(action) { if (State.me) action(); else openAuth(action); }

  function logout() {
    API.setToken(null); State.me = null; State.favs = new Set(); State.conversations = []; State.notifications = [];
    if (State.sse) { State.sse.close(); State.sse = null; }
    updateNavUser(); updateBadges(); closeModal();
    toast("Logged out", "See you soon!");
    router();
  }

  /* ---------------- data loading ---------------- */
  async function loadUserData() {
    if (!State.me) return;
    try {
      const [fav, conv, notif] = await Promise.all([API.favorites(), API.conversations(), API.notifications()]);
      State.favs = new Set(fav.productIds || []);
      State.conversations = conv.conversations || [];
      State.notifications = notif.notifications || [];
      updateBadges();
    } catch (e) { console.error(e); }
  }

  function connectSSE() {
    if (!State.me || State.sse) return;
    const es = new EventSource("/api/stream?token=" + encodeURIComponent(API.token));
    State.sse = es;
    es.addEventListener("message", (e) => {
      try { const d = JSON.parse(e.data); onRealtimeMessage(d); } catch {}
    });
    es.addEventListener("notification", (e) => {
      try {
        const d = JSON.parse(e.data);
        State.notifications.unshift(d);
        updateBadges();
        if (currentHash() === "#/notifications") renderNotifications();
        toast("New notification", d.text.replace(/<[^>]+>/g, ""), "🔔");
      } catch {}
    });
    es.addEventListener("announcement", () => { try { renderBanner(); } catch {} });
    es.addEventListener("productRemoved", (e) => {
      try {
        const d = JSON.parse(e.data);
        if (currentHash() === "#/product/" + d.productId) { toast("Listing removed", "This item is no longer available.", "⚠️"); location.hash = "#/marketplace"; }
        if (currentHash() === "#/profile") renderProfile();
      } catch {}
    });
    es.onerror = () => {/* auto-reconnect by browser */};
  }

  async function renderBanner() {
    const el = $("#sysBanner");
    if (!el) return;
    try {
      const { announcements } = await API.announcements();
      if (announcements && announcements.length) {
        el.hidden = false;
        el.innerHTML = announcements.map((a) => `<div class="banner"><span class="banner__icon">📢</span><span>${esc(a.text)}</span></div>`).join("");
      } else { el.hidden = true; el.innerHTML = ""; }
    } catch { el.hidden = true; el.innerHTML = ""; }
  }

  async function onRealtimeMessage({ conversationId, message }) {
    // refresh conversation list + badges
    await refreshConversations();
    if (currentHash() === "#/messages") {
      if (State.activeConv === conversationId) {
        const thread = $("#thread");
        if (thread) {
          const meId = State.me ? State.me.id : null;
          const b = document.createElement("div");
          b.className = "bubble bubble--" + (message.senderId === meId ? "me" : "them");
          b.innerHTML = `${message.image ? `<img class="bubble__img" src="${esc(message.image)}" alt="item" onerror="this.style.display='none'">` : ""}${renderMsg(message.text)}<time>${esc(message.time)}</time>`;
          thread.appendChild(b);
          thread.scrollTop = thread.scrollHeight;
          if (message.senderId !== meId) API.readConversation(conversationId).catch(() => {});
        }
      }
      renderConvList();
    }
  }

  async function refreshConversations() {
    try { const { conversations } = await API.conversations(); State.conversations = conversations; updateBadges(); } catch {}
  }

  async function toggleFav(id, btn) {
    if (!State.me) { openAuth(() => toggleFav(id, btn)); return; }
    const on = State.favs.has(id);
    try {
      if (on) { await API.removeFavorite(id); State.favs.delete(id); }
      else { await API.addFavorite(id); State.favs.add(id); }
    } catch (e) { toast("Error", e.message, "⚠️"); return; }
    updateBadges();
    if (btn) {
      btn.classList.toggle("is-active", !on);
      if (!on) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); }
    }
    $$('[data-fav="' + id + '"]').forEach((b) => {
      if (b === btn) return;
      b.classList.toggle("is-active", !on);
      const s = b.querySelector("svg"); if (s) s.setAttribute("fill", !on ? "currentColor" : "none");
    });
    const prod = btn ? null : null;
    toast(on ? "Removed from favorites" : "Saved to favorites", "", on ? "🗑" : "♥");
  }

  /* ---------------- product card ---------------- */
  function cardHTML(p) {
    const fav = State.favs.has(p.id);
    const src = (p.images && p.images[0]) || "";
    return `
    <article class="card reveal" data-id="${p.id}">
      <a class="card__media" href="#/product/${p.id}" data-link>${mediaHTML({ src, alt: p.title, seed: p.id, emoji: catIcon(p.category) })}
        ${p.status && p.status !== "Available" ? `<span class="card__status">${esc(p.status)}</span>` : ""}
      </a>
      <button class="card__fav ${fav ? "is-active" : ""}" data-fav="${p.id}" aria-label="Save" title="Save">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="${fav ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
      </button>
      <a class="card__body" href="#/product/${p.id}" data-link>
        <span class="card__title">${esc(p.title)}</span>
        <span class="card__price">${money(p.price)}</span>
        ${p.ratingCount ? `<span class="card__rating"><span class="stars">${stars(p.rating)}</span> ${p.rating} <span class="muted">(${p.ratingCount})</span></span>` : ""}
        <span class="card__meta"><span class="cond-pill">${esc(p.condition)}</span><span class="dot"></span><span>📍 ${esc(p.location)}</span></span>
        <span class="card__seller">${avatarHTML(p.seller)}<b>${esc(p.seller ? p.seller.name : "Student")}</b>${verifyBadge(p.seller)}<span>⭐ ${p.seller ? p.seller.rating : "—"}</span></span>
      </a>
    </article>`;
  }
  function skeletonCard() { return `<div class="skel-card"><div class="skel skel-media"></div><div class="skel-body"><div class="skel skel-line w80"></div><div class="skel skel-line w40"></div><div class="skel skel-line w60"></div></div></div>`; }
  function emptyHTML(icon, title, text, href, btn) {
    return `<div class="empty" style="grid-column:1/-1"><div class="empty__icon">${icon}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${href ? `<a class="btn btn--primary" href="${href}" data-link>${esc(btn)}</a>` : ""}</div>`;
  }

  function observeReveals(root = view) {
    if (window.__io) window.__io.disconnect();
    window.__io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); window.__io.unobserve(e.target); } });
    }, { threshold: 0.08, rootMargin: "0px 0px -40px 0px" });
    $$(".reveal", root).forEach((el) => window.__io.observe(el));
  }

  /* ============================================================
     VIEWS
     ============================================================ */
  async function renderHome() {
    const { products } = await API.products();
    const featured = products.slice(0, 8);
    const recent = products.slice(0, 8);
    view.innerHTML = `
      <section class="hero">
        <div class="hero__bg"><span class="hero__blob hero__blob--1"></span><span class="hero__blob hero__blob--2"></span><span class="hero__blob hero__blob--3"></span></div>
        <div class="wrap hero__inner">
          <h1>Find what you need.<br><span class="grad">Sell what you don't.</span></h1>
          <p class="sub">The marketplace built for your campus community.</p>
          <form class="hero__search" id="heroSearch">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            <input type="text" id="heroInput" placeholder="Search textbooks, electronics, fashion and more..." autocomplete="off" />
            <button class="btn btn--primary" type="submit">Search</button>
          </form>
          <div class="hero__chips">
            <a class="hero__chip" href="#/marketplace?cat=books">📚 Books</a>
            <a class="hero__chip" href="#/marketplace?cat=electronics">💻 Electronics</a>
            <a class="hero__chip" href="#/marketplace?cat=phones">📱 Phones</a>
            <a class="hero__chip" href="#/sell" data-link>➕ Sell an Item</a>
          </div>
        </div>
      </section>
      <section class="section wrap">
        <div class="section-head"><div><span class="eyebrow">Browse by category</span><h2 style="margin-top:12px">What are you looking for?</h2></div></div>
        <div class="cat-scroll">
          ${CATEGORIES.map((c) => `<a class="cat-card reveal" href="#/marketplace?cat=${c.id}" data-link><div class="cat-card__icon"><span>${c.icon}</span></div><b>${esc(c.label)}</b><small>${esc(c.tag)}</small></a>`).join("")}
        </div>
      </section>
      <section class="section wrap" style="padding-top:0">
        <div class="section-head"><div><span class="eyebrow">Handpicked</span><h2 style="margin-top:12px">Featured Listings</h2><p>Popular items from students around campus.</p></div>
          <a class="link-arrow" href="#/marketplace" data-link>View All <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a></div>
        <div class="grid grid--4" id="featuredGrid">${featured.length ? featured.map(cardHTML).join("") : emptyHTML("🔍","No listings yet","Be the first to list something.","#/sell","Sell an Item")}</div>
      </section>
      <section class="section wrap" style="padding-top:0">
        <div class="section-head"><div><span class="eyebrow">Fresh</span><h2 style="margin-top:12px">Recent Listings</h2><p>Just added by students near you.</p></div></div>
        <div class="grid grid--4" id="recentGrid">${recent.map(cardHTML).join("")}</div>
      </section>
      <section class="section wrap" style="padding-top:0">
        <div class="reveal" style="background:linear-gradient(120deg,#5b5bd6,#8b5cf6);border-radius:var(--radius-lg);padding:48px;text-align:center;color:#fff;box-shadow:var(--shadow-md)">
          <h2 style="color:#fff;font-size:clamp(1.6rem,3vw,2.2rem)">Got stuff sitting around?</h2>
          <p style="opacity:.9;margin:10px 0 24px">Turn things you no longer need into something another student can use.</p>
          <a class="btn btn--primary" style="background:#fff;color:var(--primary)" href="#/sell" data-link>Sell an Item</a>
        </div>
      </section>`;
    $("#heroSearch").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#heroInput").value.trim(); location.hash = "#/marketplace" + (q ? "?q=" + encodeURIComponent(q) : ""); });
    observeReveals();
  }

  async function renderCategories() {
    const { products } = await API.products();
    const counts = {}; products.forEach((p) => (counts[p.category] = (counts[p.category] || 0) + 1));
    view.innerHTML = `
      <section class="section wrap">
        <div class="section-head"><div><span class="eyebrow">Explore</span><h2 style="margin-top:12px">All Categories</h2><p>Browse the campus marketplace by what you need.</p></div></div>
        <div class="grid grid--4">
          ${CATEGORIES.map((c) => `<a class="cat-card reveal" href="#/marketplace?cat=${c.id}" data-link><div class="cat-card__icon"><span>${c.icon}</span></div><b>${esc(c.label)}</b><small>${counts[c.id] || 0} listings</small></a>`).join("")}
        </div>
      </section>`;
    observeReveals();
  }

  async function renderMarketplace(params) {
    const state = { q: params.q || "", cat: params.cat || "", cond: "", max: "", loc: "", sort: "new" };
    async function load() {
      const list = (await API.products({ q: state.q, cat: state.cat, cond: state.cond, max: state.max, loc: state.loc, sort: state.sort })).products;
      $("#mktCount").innerHTML = `<b>${list.length}</b> item${list.length === 1 ? "" : "s"}${state.cat ? " in " + esc(catLabel(state.cat)) : ""}`;
      const grid = $("#mktGrid");
      grid.innerHTML = list.length ? list.map(cardHTML).join("") : emptyHTML("🔍", "No matches found", "Try adjusting your filters or search terms.", "#/home", "Browse Marketplace");
      observeReveals();
    }
    view.innerHTML = `
      <section class="section wrap" style="padding-bottom:30px">
        <div class="mkt__head">
          <h1 style="font-size:clamp(1.8rem,4vw,2.6rem)">Marketplace</h1>
          <form class="mkt__search" id="mktSearch">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            <input type="text" id="mktQ" placeholder="Search within marketplace..." value="${esc(state.q)}" />
          </form>
          <button class="btn btn--ghost btn--sm mkt__filter-btn" id="openFilters">⚙ Filters</button>
        </div>
        <div class="mkt">
          <aside class="filters" id="filters">
            <h3>🔎 Filters</h3>
            <div class="filters__group"><label>Category</label><div class="chip-row" id="fCat">
              <button class="chip ${!state.cat ? "is-active" : ""}" data-cat="">All</button>
              ${CATEGORIES.map((c) => `<button class="chip ${state.cat === c.id ? "is-active" : ""}" data-cat="${c.id}">${c.icon} ${esc(c.label)}</button>`).join("")}
            </div></div>
            <div class="filters__group"><label>Condition</label><div class="chip-row" id="fCond">
              <button class="chip ${!state.cond ? "is-active" : ""}" data-cond="">Any</button>
              ${CONDITIONS.map((c) => `<button class="chip ${state.cond === c ? "is-active" : ""}" data-cond="${esc(c)}">${esc(c)}</button>`).join("")}
            </div></div>
            <div class="filters__group"><label>Max Price (₦)</label><input class="field-input" type="number" id="fMax" placeholder="e.g. 100000" value="${state.max}"></div>
            <div class="filters__group"><label>Location</label><input class="field-input" type="text" id="fLoc" placeholder="e.g. Main Campus" value="${esc(state.loc)}"></div>
            <div class="filters__group"><label>Sort by</label><div class="chip-row" id="fSort">
              <button class="chip ${state.sort === "new" ? "is-active" : ""}" data-sort="new">Newest</button>
              <button class="chip ${state.sort === "price-asc" ? "is-active" : ""}" data-sort="price-asc">Price ↑</button>
              <button class="chip ${state.sort === "price-desc" ? "is-active" : ""}" data-sort="price-desc">Price ↓</button>
            </div></div>
            <div class="filters__group" style="border-top:1px solid var(--border)"><button class="btn btn--ghost btn--block btn--sm" id="clearFilters">Clear all</button></div>
          </aside>
          <div><p class="mkt__count" id="mktCount"></p><div class="grid grid--3" id="mktGrid"></div></div>
        </div>
      </section>`;

    const search = $("#mktSearch");
    search.addEventListener("submit", (e) => { e.preventDefault(); state.q = $("#mktQ").value.trim(); load(); });
    $("#mktQ").addEventListener("input", (e) => { state.q = e.target.value.trim(); load(); });
    $$("#fCat .chip").forEach((b) => b.addEventListener("click", () => { state.cat = b.dataset.cat; $$("#fCat .chip").forEach((x) => x.classList.toggle("is-active", x === b)); load(); }));
    $$("#fCond .chip").forEach((b) => b.addEventListener("click", () => { state.cond = b.dataset.cond; $$("#fCond .chip").forEach((x) => x.classList.toggle("is-active", x === b)); load(); }));
    $$("#fSort .chip").forEach((b) => b.addEventListener("click", () => { state.sort = b.dataset.sort; $$("#fSort .chip").forEach((x) => x.classList.toggle("is-active", x === b)); load(); }));
    $("#fMax").addEventListener("input", (e) => { state.max = e.target.value; load(); });
    $("#fLoc").addEventListener("input", (e) => { state.loc = e.target.value; load(); });
    $("#clearFilters").addEventListener("click", () => { location.hash = "#/marketplace"; });
    $("#openFilters").addEventListener("click", () => $("#filters").classList.add("is-open"));
    document.addEventListener("click", function closeF(e) {
      const f = $("#filters");
      if (f && f.classList.contains("is-open") && !f.contains(e.target) && e.target.id !== "openFilters") f.classList.remove("is-open");
    });
    await load();
  }

  function timeAgo(ts) {
    if (!ts) return "";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
    const d = Math.floor(h / 24); if (d < 7) return d + "d ago";
    return new Date(ts).toLocaleDateString();
  }
  function reviewsListHTML(reviews) {
    if (!reviews.length) return `<p class="muted">No reviews yet. Be the first to share your opinion!</p>`;
    return reviews.slice().reverse().map((r) => `
      <div class="review">
        <div class="review__head"><b>${esc(r.name)}</b><span class="stars">${stars(r.stars)}</span><time>${timeAgo(r.createdAt)}</time></div>
        <p>${esc(r.comment)}</p>
      </div>`).join("");
  }
  function saleControlsHTML(p) {
    const me = State.me;
    const sellerId = p.seller ? p.seller.id : p.sellerId;
    if (!me) return "";
    if (me.id === sellerId) {
      if (p.status === "Sold") {
        const list = (p.confirmations || []).length
          ? `<ul class="sale__confirmed">${(p.confirmations || []).map(() => `<li>✅ A buyer confirmed they received this item</li>`).join("")}</ul>`
          : `<p class="muted">Waiting for the buyer to confirm they received the item.</p>`;
        return `<div class="pdp__sale pdp__sale--sold"><span class="sale__badge">✅ Marked as sold</span>${list}</div>`;
      }
      return `<div class="pdp__sale"><button class="btn btn--ghost btn--sm" id="markSoldBtn">✅ Mark as Sold</button><span class="muted">Use this once you've completed the sale.</span></div>`;
    }
    if (p.status === "Sold") {
      const done = (p.confirmations || []).includes(me.id);
      if (done) return `<div class="pdp__sale pdp__sale--sold"><span class="sale__badge">✅ You confirmed this purchase</span></div>`;
      return `<div class="pdp__sale"><button class="btn btn--primary btn--sm" id="confirmBtn">✅ Confirm I received / bought this</button><span class="muted">This tells the seller the sale is complete.</span></div>`;
    }
    return "";
  }

  async function renderProduct(id) {
    let data;
    try { data = await API.product(id); } catch { renderNotFound(); return; }
    const p = data.product;
    const u = p.seller;
    const imgs = (p.images && p.images.length ? p.images : [null, null, null, null]);
    while (imgs.length < 4) imgs.push(null);
    const fav = State.favs.has(p.id);
    view.innerHTML = `
      <section class="section wrap" style="padding-top:36px">
        <a class="pdp__back" href="#/marketplace" data-link><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg> Back to Marketplace</a>
        <div class="pdp">
          <div class="pdp__gallery">
            <div class="pdp__main" id="pdpMain">${mediaHTML({ src: imgs[0], alt: p.title, seed: p.id, emoji: catIcon(p.category) })}</div>
            <div class="pdp__thumbs">
              ${imgs.map((g, i) => `<div class="pdp__thumb ${i === 0 ? "is-active" : ""}" data-i="${i}">${mediaHTML({ src: g, alt: p.title, seed: p.id + i, emoji: catIcon(p.category) })}</div>`).join("")}
            </div>
          </div>
          <div class="pdp__info">
            <span class="pdp__cat">${esc(catLabel(p.category))}</span>
            <h1 class="pdp__title">${esc(p.title)}</h1>
            <div class="pdp__rating"><span class="stars">${stars(u ? u.rating : 0)}</span> ${u ? u.rating : "—"} Seller rating</div>
            <div class="pdp__rating"><span class="stars">${stars(p.rating || 0)}</span> ${p.rating || 0} <span style="color:var(--muted)">· ${p.ratingCount || 0} review${p.ratingCount === 1 ? "" : "s"}</span></div>
            <div class="pdp__price">${money(p.price)}</div>
            <div class="pdp__cond"><span class="cond-pill">${esc(p.condition)}</span> Condition</div>
            <div class="pdp__loc"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> ${esc(p.location)}</div>
            <div class="pdp__actions">
              <button class="btn btn--primary btn--lg" id="contactSeller" style="flex:1">💬 Contact Seller</button>
              <button class="btn btn--ghost btn--lg" id="saveBtn" data-fav="${p.id}">${fav ? "♥ Saved" : "♡ Save"}</button>
            </div>
            ${State.me && u && State.me.id !== u.id ? `<button class="btn btn--ghost btn--sm" id="reportBtn" style="margin-top:10px;align-self:flex-start">⚑ Report listing</button>` : ""}
            <div class="pdp__seller">
              <a href="#/user/${u ? u.id : ""}" data-link>${avatarHTML(u)}</a>
              <div><b><a href="#/user/${u ? u.id : ""}" data-link style="color:inherit">${esc(u ? u.name : "Student")}</a></b>${verifyBadge(u)}<small>${esc(u ? u.role : "")} · ⭐ ${u ? u.rating : "—"}</small></div>
              <button class="btn btn--soft btn--sm" style="margin-left:auto" id="msgSeller">Message</button>
            </div>
            <div class="pdp__desc"><h3>Description</h3><p>${esc(p.description)}</p></div>
            ${State.me && u && State.me.id !== u.id ? `<div style="margin-top:18px"><b>Rate this seller:</b> <span id="rateStars" style="cursor:pointer">${"★☆☆☆☆".split("").map((s,i)=>`<span data-r="${i+1}" style="font-size:1.4rem;color:var(--gold)">${i<1?"★":"☆"}</span>`).join("")}</span></div>` : ""}
            ${saleControlsHTML(p)}
            <div class="pdp__reviews" id="reviewsBox">
              <h3 class="pdp__reviews-title">Reviews &amp; Ratings <span class="muted">(${p.ratingCount || 0})</span></h3>
              <div id="reviewsList">${reviewsListHTML(p.reviews || [])}</div>
              ${State.me ? (State.me.id !== u.id ? `
                <form class="review-form" id="reviewForm">
                  <label class="review-form__label">Rate this item</label>
                  <div class="review-form__stars" id="reviewStars" role="radiogroup" aria-label="Star rating">
                    ${[1,2,3,4,5].map((i)=>`<button type="button" class="rstars" data-v="${i}" aria-label="${i} star">☆</button>`).join("")}
                  </div>
                  <textarea class="field-input" id="reviewText" placeholder="Share your opinion about this item — was it as described? Would you recommend it?" rows="3"></textarea>
                  <button class="btn btn--primary btn--sm" type="submit">Post review</button>
                </form>` : `<p class="muted review-form__own">This is your listing — you can't review your own item.</p>`) : `<p class="muted">Log in to leave a review.</p>`}
            </div>
          </div>
        </div>
      </section>`;
    $$(".pdp__thumb").forEach((t) => t.addEventListener("click", () => {
      $$(".pdp__thumb").forEach((x) => x.classList.remove("is-active"));
      t.classList.add("is-active");
      $("#pdpMain").innerHTML = mediaHTML({ src: imgs[+t.dataset.i], alt: p.title, seed: p.id + t.dataset.i, emoji: catIcon(p.category) });
    }));
    $("#contactSeller").addEventListener("click", () => contactSeller(p));
    $("#msgSeller").addEventListener("click", () => contactSeller(p));
    const saveBtn = $("#saveBtn");
    saveBtn.addEventListener("click", () => { const on = State.favs.has(p.id); toggleFav(p.id, saveBtn); saveBtn.textContent = (on ? "♡ Save" : "♥ Saved"); });
    const reportBtn = $("#reportBtn");
    if (reportBtn) reportBtn.addEventListener("click", () => openReportModal(p));
    const rs = $("#rateStars");
    if (rs) rs.addEventListener("click", async (e) => { const r = e.target.dataset.r; if (!r) return; if (!State.me) return openAuth(); try { await API.rateUser(u.id, +r); toast("Rating sent", "Thanks for the feedback ⭐"); } catch (err) { toast("Error", err.message, "⚠️"); } });

    let rv = 0;
    const starWrap = $("#reviewStars");
    if (starWrap) starWrap.addEventListener("click", (e) => {
      const b = e.target.closest("[data-v]"); if (!b) return;
      rv = +b.dataset.v;
      starWrap.querySelectorAll(".rstars").forEach((s) => { const on = +s.dataset.v <= rv; s.textContent = on ? "★" : "☆"; s.classList.toggle("is-on", on); });
    });
    const rf = $("#reviewForm");
    if (rf) rf.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!rv) return toast("Add a rating", "Please select a star rating first.", "⚠️");
      const text = $("#reviewText").value.trim();
      if (!text) return toast("Add a comment", "Please write your review.", "⚠️");
      try { await API.addReview(p.id, rv, text); toast("Review posted", "Thanks for your feedback! ⭐", "✓"); await renderProduct(p.id); }
      catch (err) { toast("Error", err.message, "⚠️"); }
    });
    const ms = $("#markSoldBtn");
    if (ms) ms.addEventListener("click", async () => {
      if (!window.confirm("Mark this item as sold? Buyers will be able to confirm the sale.")) return;
      try { await API.markSold(p.id); toast("Marked as sold", "The item is now marked as sold. ✅", "✅"); await renderProduct(p.id); }
      catch (err) { toast("Error", err.message, "⚠️"); }
    });
    const cf = $("#confirmBtn");
    if (cf) cf.addEventListener("click", async () => {
      try { await API.confirmSale(p.id); toast("Confirmed", "The seller has been notified. ✅", "✅"); await renderProduct(p.id); }
      catch (err) { toast("Error", err.message, "⚠️"); }
    });
  }

  async function contactSeller(p) {
    if (!State.me) return openAuth(() => contactSeller(p));
    try {
      const { conversationId } = await API.contactSeller(p.id, "Is this still available?");
      State.activeConv = conversationId;
      location.hash = "#/messages";
      toast("Chat opened", "Message sent to " + (p.seller ? p.seller.name : "seller"));
    } catch (e) { toast("Error", e.message, "⚠️"); }
  }

  function openReportModal(p) {
    if (!State.me) return openAuth(() => openReportModal(p));
    openModal(`
      <h3>⚑ Report listing</h3>
      <p class="muted">Tell us what's wrong with <b>${esc(p.title)}</b>.</p>
      <form id="reportForm" class="form-grid">
        <div class="field"><label>Reason</label><select class="field-input" name="reason">
          <option>Spam</option><option>Scam / Fraud</option><option>Inappropriate content</option><option>Prohibited item</option><option>Wrong category</option><option>Other</option>
        </select></div>
        <div class="field"><label>Details (optional)</label><textarea class="field-input" name="text" rows="3" placeholder="Add any context that helps our team..."></textarea></div>
        <div class="modal__actions" style="justify-content:flex-end">
          <button class="btn btn--ghost" type="button" onclick="document.getElementById('modalRoot').hidden=true">Cancel</button>
          <button class="btn btn--danger" type="submit">Submit report</button>
        </div>
      </form>`);
    $("#reportForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target).entries());
      try { await API.reportProduct(p.id, fd.reason, fd.text); closeModal(); toast("Reported", "Thanks — our team will review it.", "⚑"); }
      catch (err) { toast("Error", err.message, "⚠️"); }
    });
  }

  async function renderSell() {
    if (!State.me) {
      view.innerHTML = `<section class="section wrap">${emptyHTML("🔐", "Log in to sell", "Create an account or log in to list items on CampusMarket.", null, "")}<div style="text-align:center"><button class="btn btn--primary btn--lg" id="loginToSell">Log in / Sign up</button></div></section>`;
      $("#loginToSell").addEventListener("click", () => openAuth(() => router()));
      return;
    }
    view.innerHTML = `
      <section class="section wrap">
        <div class="sell">
          <div style="text-align:center;margin-bottom:26px"><span class="eyebrow">List an item</span>
            <h1 style="font-size:clamp(1.8rem,4vw,2.6rem);margin-top:12px">Sell an Item</h1>
            <p style="color:var(--muted);margin-top:8px">Turn things you no longer need into something another student can use.</p></div>
          <form class="sell__card" id="sellForm">
            <div class="dropzone" id="dropzone"><p style="margin:0 0 6px"><b>📸 Drag & drop photos here</b></p><p style="margin:0">or <span style="color:var(--primary);font-weight:700">browse</span> to upload</p><input type="file" id="fileInput" accept="image/*" multiple hidden></div>
            <div class="previews" id="previews"></div>
            <div class="form-grid" style="margin-top:22px">
              <div class="field"><label>Product name</label><input class="field-input" name="title" placeholder="e.g. MacBook Air M1" required></div>
              <div class="form-row">
                <div class="field"><label>Category</label><select class="field-input" name="cat" required><option value="" disabled selected>Select category</option>${CATEGORIES.map((c) => `<option value="${c.id}">${c.icon} ${esc(c.label)}</option>`).join("")}</select></div>
                <div class="field"><label>Price (₦)</label><input class="field-input" name="price" type="number" placeholder="e.g. 450000" required></div>
              </div>
              <div class="form-row">
                <div class="field"><label>Condition</label><select class="field-input" name="cond" required><option value="" disabled selected>Select condition</option>${CONDITIONS.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select></div>
                <div class="field"><label>Location</label><input class="field-input" name="loc" placeholder="e.g. Main Campus" required></div>
              </div>
              <div class="field"><label>Description</label><textarea class="field-input" name="desc" placeholder="Describe your item, its condition, and pickup details..." required></textarea></div>
              <div class="form-row" style="align-items:center">
                <button class="btn btn--primary btn--lg btn--block" type="submit">Publish Listing</button>
                <button class="btn btn--ghost btn--lg btn--block" type="button" id="saveDraft">Save as draft</button>
              </div>
            </div>
          </form>
        </div>
      </section>`;
    const files = [];
    const dz = $("#dropzone"), input = $("#fileInput"), previews = $("#previews");
    dz.addEventListener("click", () => input.click());
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("is-drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("is-drag"));
    dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("is-drag"); addFiles(e.dataTransfer.files); });
    input.addEventListener("change", () => addFiles(input.files));
    function addFiles(list) {
      Array.from(list).slice(0, 6).forEach((f) => {
        if (!f.type.startsWith("image/")) return;
        const reader = new FileReader();
        reader.onload = () => {
          const url = reader.result;
          files.push(url);
          const d = document.createElement("div"); d.className = "preview";
          d.innerHTML = `<img src="${url}" alt="preview"><button type="button" aria-label="Remove">×</button>`;
          d.querySelector("button").addEventListener("click", () => { d.remove(); files.splice(files.indexOf(url), 1); });
          previews.appendChild(d);
        };
        reader.readAsDataURL(f);
      });
    }
    $("#sellForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const { product } = await API.createProduct({ title: fd.get("title"), price: fd.get("price"), category: fd.get("cat"), condition: fd.get("cond"), location: fd.get("loc"), description: fd.get("desc"), images: files, status: "Available" });
        openModal(`<h3>🎉 Listing published!</h3><p>Your item <b>${esc(product.title)}</b> is now live on CampusMarket.</p><div class="modal__actions"><a class="btn btn--primary" href="#/profile" data-link onclick="document.getElementById('modalRoot').hidden=true">View my profile</a></div>`);
        toast("Listing published", product.title, "🎉");
        router();
      } catch (err) { toast("Error", err.message, "⚠️"); }
    });
    $("#saveDraft").addEventListener("click", () => toast("Draft saved", "We'll keep it for you.", "📝"));
  }

  function paintVerify() {
    const el = $("#verifyCard"); if (!el) return;
    const me = State.me;
    if (!me) { el.innerHTML = ""; return; }
    if (me.emailVerified) {
      el.innerHTML = `<div class="verify-done"><span class="vbadge vbadge--yes">✓</span><div><b>Verified seller</b><p>Your seller account has been verified.</p></div></div>`;
      return;
    }
    if (State.verifyPending) {
      el.innerHTML = `<b>Seller verification</b>
        <p>Check your email</p>
        <p class="muted" style="margin-bottom:12px">We've sent a 6-digit verification code to your email.</p>
        <form id="codeForm" class="form-grid">
          <input class="field-input" id="codeInput" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="••••••" style="letter-spacing:8px;text-align:center;font-size:1.25rem;font-weight:800">
          <button class="btn btn--primary btn--sm" type="submit">Verify</button>
        </form>
        <button class="btn btn--ghost btn--sm" id="resendBtn" type="button">Didn't receive it? Resend code</button>
        <span class="muted" id="verifyMsg" style="display:block;margin-top:8px"></span>`;
    } else {
      el.innerHTML = `<b>Seller verification</b>
        <p>Your seller account is not verified.</p>
        <form id="emailForm" class="form-grid">
          <input class="field-input" id="verifyEmail" type="email" value="${esc(me.email || "")}" placeholder="example@email.com">
          <button class="btn btn--primary btn--sm" type="submit">Verify email</button>
        </form>`;
    }
    const ef = $("#emailForm");
    if (ef) ef.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#verifyEmail").value.trim();
      try { await API.verifySend(email); State.verifyPending = true; paintVerify(); toast("Code sent", "Check your email for the 6-digit code.", "📧"); }
      catch (err) { toast("Error", err.message, "⚠️"); }
    });
    const cf = $("#codeForm");
    if (cf) cf.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = $("#codeInput").value.trim();
      if (!code) return;
      try {
        const r = await API.verifyCheck(code);
        if (r.verified) { State.me = r.user; State.verifyPending = false; await renderProfile(); updateNavUser(); toast("Verified", "✓ Seller verified successfully", "✓"); }
      } catch (err) { const m = $("#verifyMsg"); if (m) m.textContent = err.message; toast("Error", err.message, "⚠️"); }
    });
    const rb = $("#resendBtn");
    if (rb) rb.addEventListener("click", async () => {
      try { await API.verifySend(State.me.email || ""); toast("Code resent", "A new code was sent to your email.", "📧"); }
      catch (err) { toast("Error", err.message, "⚠️"); }
    });
  }

  async function renderProfile(id) {
    if (!State.me) { view.innerHTML = `<section class="section wrap">${emptyHTML("🔐", "Log in to view your profile", "Create an account or log in to manage your listings.", null, "")}<div style="text-align:center"><button class="btn btn--primary btn--lg" id="loginBtn">Log in / Sign up</button></div></section>`; $("#loginBtn").addEventListener("click", () => openAuth(() => router())); return; }
    const uid = id || State.me.id;
    const isMe = uid === State.me.id;
    let u, prods;
    try {
      const [ud, pd] = await Promise.all([API.user(uid), API.userProducts(uid)]);
      u = ud.user; prods = pd.products;
    } catch (e) { renderNotFound(); return; }
    view.innerHTML = `
      <section class="section wrap" style="padding-top:36px">
        <div class="profile__hero reveal">
          ${avatarHTML(u, "profile__avatar")}
          <div>
            <h1 class="profile__name">${esc(u.name)} ${verifyBadge(u)}</h1>
            <div class="profile__role">${esc(u.role)}</div>
            <div class="profile__rating"><span class="stars">${stars(u.rating)}</span> ${u.rating} seller rating (${u.ratingsCount})</div>
            <div class="profile__loc"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> ${esc(u.location)}</div>
            <p class="profile__bio">${esc(u.bio || "")}</p>
          </div>
          <div class="profile__stats">
            <div class="stat"><b>${prods.length}</b><span>Listings</span></div>
            <div class="stat"><b>${u.sold || 0}</b><span>Sold</span></div>
            <div class="stat"><b>${u.reviews || 0}</b><span>Reviews</span></div>
          </div>
        </div>
        ${isMe ? `<div class="profile__verify" id="verifyCard"></div>` : ""}
        <div class="section-head" style="margin-top:36px"><div><h2>${isMe ? "My Listings" : esc(u.name) + "'s Listings"}</h2></div>
          ${isMe ? `<button class="btn btn--primary btn--sm" id="editProfile">Edit profile</button>` : ""}
          ${isMe ? `<a class="btn btn--ghost btn--sm" href="#/sell" data-link>＋ Sell</a>` : ""}
        </div>
        <div class="grid grid--4" id="userGrid">${prods.length ? prods.map(cardHTML).join("") : emptyHTML("📦", "No listings yet", isMe ? "List something to see it here." : "This seller has no active listings.", "#/sell", "Sell an Item")}</div>
        ${isMe ? `<div style="text-align:center;margin-top:30px"><button class="btn btn--ghost" id="logoutBtn">Log out</button></div>` : ""}
      </section>`;
    observeReveals();
    if (isMe) paintVerify();
    const ep = $("#editProfile");
    if (ep) ep.addEventListener("click", () => {
      openModal(`<h3>Edit profile</h3>
        <form id="editForm" class="form-grid">
          <div class="field"><label>Name</label><input class="field-input" name="name" value="${esc(u.name)}"></div>
          <div class="field"><label>Role</label><input class="field-input" name="role" value="${esc(u.role)}"></div>
          <div class="field"><label>Location</label><input class="field-input" name="location" value="${esc(u.location)}"></div>
          <div class="field"><label>Bio</label><textarea class="field-input" name="bio">${esc(u.bio || "")}</textarea></div>
          <div class="modal__actions" style="justify-content:flex-end"><button class="btn btn--ghost" type="button" onclick="document.getElementById('modalRoot').hidden=true">Cancel</button><button class="btn btn--primary" type="submit">Save</button></div>
        </form>`);
      $("#editForm").addEventListener("submit", async (e) => { e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target).entries()); try { const { user } = await API.updateUser(u.id, fd); State.me = user; updateNavUser(); closeModal(); toast("Profile updated", "", "✓"); renderProfile(u.id); } catch (err) { toast("Error", err.message, "⚠️"); } });
    });
    const lo = $("#logoutBtn"); if (lo) lo.addEventListener("click", logout);
  }

  async function renderFavorites() {
    if (!State.me) { view.innerHTML = `<section class="section wrap">${emptyHTML("🔐", "Log in to view favorites", "Save items you love and find them here.", null, "")}<div style="text-align:center"><button class="btn btn--primary btn--lg" id="loginBtn">Log in / Sign up</button></div></section>`; $("#loginBtn").addEventListener("click", () => openAuth(() => router())); return; }
    let prods = [];
    try { const r = await API.favorites(); prods = r.products || []; } catch {}
    view.innerHTML = `
      <section class="section wrap" style="padding-top:36px">
        <div class="section-head"><div><span class="eyebrow">❤️ Saved</span><h2 style="margin-top:12px">Your Favorites</h2><p>Items you're interested in, all in one place.</p></div></div>
        <div class="grid grid--4" id="favGrid">${prods.length ? prods.map(cardHTML).join("") : emptyHTML("❤️", "No Favorites Yet", "Nothing saved yet. Save products you're interested in and they'll appear here.", "#/marketplace", "Browse Marketplace")}</div>
      </section>`;
    observeReveals();
  }

  async function renderNotifications() {
    if (!State.me) { view.innerHTML = `<section class="section wrap">${emptyHTML("🔐", "Log in to see notifications", "Activity on your listings will appear here.", null, "")}<div style="text-align:center"><button class="btn btn--primary btn--lg" id="loginBtn">Log in / Sign up</button></div></section>`; $("#loginBtn").addEventListener("click", () => openAuth(() => router())); return; }
    const iconFor = { fav: "❤️", msg: "💬", sold: "✅", rate: "⭐" };
    view.innerHTML = `
      <section class="section wrap" style="padding-top:36px;max-width:720px">
        <div class="section-head"><div><span class="eyebrow">🔔 Activity</span><h2 style="margin-top:12px">Notifications</h2></div>
          <button class="btn btn--ghost btn--sm" id="markAll">Mark all read</button></div>
        <div class="filters" style="position:static;box-shadow:var(--shadow-xs)">
          ${State.notifications.length ? State.notifications.map((n) => `<div style="display:flex;gap:14px;align-items:flex-start;padding:14px 4px;border-bottom:1px solid var(--border)">
            <div style="width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--primary-soft);flex:none">${iconFor[n.type] || "🔔"}</div>
            <div style="flex:1"><p style="margin:0;color:var(--ink-2)">${n.text}</p><small style="color:var(--muted)">${esc(n.time)}</small></div>
            ${n.unread ? `<span style="width:9px;height:9px;border-radius:50%;background:var(--primary);margin-top:6px"></span>` : ""}
          </div>`).join("") : emptyHTML("🔔", "You're all caught up", "New activity will show up here.", "#/marketplace", "Browse Marketplace")}
        </div>
      </section>`;
    $("#markAll").addEventListener("click", async () => { await API.readNotifications(); State.notifications.forEach((n) => (n.unread = false)); updateBadges(); renderNotifications(); });
  }

  async function renderMessages() {
    if (!State.me) { view.innerHTML = `<section class="section wrap">${emptyHTML("💬", "Log in to message", "Chat with sellers and buyers on campus.", null, "")}<div style="text-align:center"><button class="btn btn--primary btn--lg" id="loginBtn">Log in / Sign up</button></div></section>`; $("#loginBtn").addEventListener("click", () => openAuth(() => router())); return; }
    await refreshConversations();
    if (!State.activeConv && State.conversations.length) State.activeConv = State.conversations[0].id;
    view.innerHTML = `
      <section class="section wrap" style="padding-top:24px">
        <div class="msg" id="msgApp">
          <div class="msg__list">
            <div class="msg__search"><input type="text" id="convSearch" placeholder="Search conversations..."></div>
            <div class="msg__items" id="convItems"></div>
          </div>
          <div class="msg__panel" id="panel"></div>
        </div>
      </section>`;
    renderConvList();
    if (State.activeConv) loadThread(State.activeConv);
  }

  function renderConvList() {
    const el = $("#convItems"); if (!el) return;
    if (!State.conversations.length) { el.innerHTML = `<div style="padding:24px;color:var(--muted);text-align:center">No conversations yet.<br>Message a seller from a product page.</div>`; return; }
    el.innerHTML = State.conversations.map((c) => `
      <div class="conv ${c.id === State.activeConv ? "is-active" : ""}" data-id="${c.id}">
        <div class="conv__av">${avatarHTML(c.other)}${c.other && c.other.online ? '<span class="conv__online"></span>' : ""}</div>
        <div class="conv__body"><div class="conv__top"><b>${esc(c.other ? c.other.name : "User")}</b>${verifyBadge(c.other)}<time>${esc(c.lastTime || "")}</time></div>
          ${c.product ? `<div class="conv__product">📦 ${esc(c.product.title)}</div>` : ""}
          <div class="conv__preview">${esc(c.preview || "")}</div></div>
        ${c.unread ? `<span class="conv__unread">${c.unread}</span>` : ""}
      </div>`).join("");
    $$("#convItems .conv").forEach((c) => c.addEventListener("click", () => { State.activeConv = c.dataset.id; renderConvList(); loadThread(c.dataset.id); }));
  }

  async function loadThread(id) {
    const panel = $("#panel"); if (!panel) return;
    const conv = State.conversations.find((c) => c.id === id);
    const other = conv ? conv.other : null;
    try { var { messages } = await API.conversation(id); } catch { messages = []; }
    panel.innerHTML = `
      <div class="msg__head">
        ${avatarHTML(other)}
        <div><b>${esc(other ? other.name : "User")}</b>${verifyBadge(other)}<small>${other && other.online ? "🟢 Online" : "Offline"} · ${esc(other ? other.location : "")}</small></div>
        <a class="btn btn--soft btn--sm" style="margin-left:auto" href="#/user/${other ? other.id : ""}" data-link>View profile</a>
      </div>
      ${conv && conv.product ? `<a class="msg__product" href="#/product/${conv.product.id}" data-link>
        ${conv.product.image ? `<img src="${esc(conv.product.image)}" alt="" class="msg__product-img" onerror="this.style.display='none'">` : ""}
        <span>📦 <b>${esc(conv.product.title)}</b></span>
      </a>` : ""}
      <div class="msg__thread" id="thread">
        ${messages.map((t) => `<div class="bubble bubble--${t.senderId === State.me.id ? "me" : "them"}">
          ${t.image ? `<img class="bubble__img" src="${esc(t.image)}" alt="item" onerror="this.style.display='none'">` : ""}
          ${renderMsg(t.text)}<time>${esc(t.time)}</time>
        </div>`).join("")}
      </div>
      <form class="msg__compose" id="compose">
        <button type="button" class="attach" aria-label="Attach" title="Attach"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.05l-9 9a5 5 0 0 1-7.07-7.07l9-9a3 3 0 0 1 4.24 4.24l-9 9a1 1 0 0 1-1.41-1.41l8.3-8.3"/></svg></button>
        <input type="text" id="msgInput" placeholder="Type a message..." autocomplete="off">
        <button type="submit" class="send" aria-label="Send"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg></button>
      </form>`;
    const thread = $("#thread"); thread.scrollTop = thread.scrollHeight;
    API.readConversation(id).then(() => { const c = State.conversations.find((x) => x.id === id); if (c) c.unread = 0; updateBadges(); renderConvList(); }).catch(() => {});
    $("#compose").addEventListener("submit", async (e) => {
      e.preventDefault();
      const inp = $("#msgInput"); const v = inp.value.trim(); if (!v) return;
      inp.value = "";
      try { await API.sendMessage(id, v); /* echo via SSE appends */ } catch (err) { toast("Error", err.message, "⚠️"); }
    });
  }

  function renderNotFound() { view.innerHTML = `<section class="section wrap">${emptyHTML("🧭", "Page not found", "The page you're looking for doesn't exist.", "#/", "Go Home")}</section>`; }

  /* ---------------- admin panel ---------------- */
  async function renderAdmin() {
    if (!State.me || !State.me.isAdmin) {
      view.innerHTML = `<section class="section wrap">${emptyHTML("🔒", "Admin only", "You need moderator access to view this page.", "#/", "Go Home")}</section>`;
      return;
    }
    view.innerHTML = `
      <section class="section wrap" style="padding-top:36px">
        <div class="section-head"><div><span class="eyebrow">🛡️ Moderation</span><h2 style="margin-top:12px">Admin Panel</h2><p>Manage reports, listings, users and announcements.</p></div></div>
        <div class="admin-grid">
          <div class="admin-card">
            <h3>📢 System Announcement</h3>
            <form id="annForm" class="form-grid">
              <textarea class="field-input" id="annText" rows="2" placeholder="e.g. System maintenance at 10 PM. Meet in public places for item inspection."></textarea>
              <button class="btn btn--primary btn--sm" type="submit">Post announcement</button>
            </form>
            <div id="annList" class="admin-ann-list"></div>
          </div>
          <div class="admin-card">
            <h3>🚫 Ban / Suspend Account</h3>
            <form id="banForm" class="form-grid">
              <div class="field"><label>Email</label><input class="field-input" id="banEmail" placeholder="user@campus.market"></div>
              <div class="field"><label>or User ID</label><input class="field-input" id="banUid" placeholder="u107"></div>
              <button class="btn btn--danger btn--sm" type="submit">Ban account</button>
            </form>
            <div id="banList" class="admin-ban-list"></div>
          </div>
        </div>
        <div class="admin-card" style="margin-top:24px">
          <h3>⚠️ Flagged Listings (Reports)</h3>
          <div id="adminReports" class="admin-reports"></div>
        </div>
        <div class="admin-card" style="margin-top:24px">
          <h3>👥 Users</h3>
          <div id="adminUsers" class="admin-users"></div>
        </div>
      </section>`;

    $("#annForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const t = $("#annText").value.trim(); if (!t) return;
      try { await API.adminPostAnnouncement(t); $("#annText").value = ""; toast("Posted", "Announcement is live.", "📢"); adminLoadAnnouncements(); }
      catch (err) { toast("Error", err.message, "⚠️"); }
    });
    $("#banForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#banEmail").value.trim(); const uidv = $("#banUid").value.trim();
      if (!email && !uidv) return toast("Add email or ID", "", "⚠️");
      try { await API.adminBan({ email, userId: uidv }); $("#banEmail").value = ""; $("#banUid").value = ""; toast("Banned", "Account suspended.", "🚫"); adminLoadUsers(); }
      catch (err) { toast("Error", err.message, "⚠️"); }
    });

    adminLoadReports(); adminLoadUsers(); adminLoadAnnouncements();
  }
  async function adminLoadReports() {
    const el = $("#adminReports"); if (!el) return;
    try {
      const { reports } = await API.adminReports();
      if (!reports.length) { el.innerHTML = `<p class="muted">No reports yet. 🎉</p>`; return; }
      el.innerHTML = reports.map((r) => `
        <div class="admin-report ${r.status === "resolved" ? "is-resolved" : ""}">
          <div class="admin-report__main">
            <b>${esc(r.product ? r.product.title : "Deleted listing")}</b>
            <span class="pill pill--warn">${esc(r.reason)}</span>
            <span class="muted">by ${esc(r.reporter ? r.reporter.name : "unknown")}</span>
            ${r.text ? `<p>${esc(r.text)}</p>` : ""}
          </div>
          <div class="admin-report__actions">
            ${r.product ? `<a class="btn btn--ghost btn--sm" href="#/product/${r.product.id}" data-link>View</a>
            <button class="btn btn--danger btn--sm" data-remove="${r.product.id}">Remove listing</button>` : ""}
            ${r.status !== "resolved" ? `<button class="btn btn--soft btn--sm" data-resolve="${r.id}">Dismiss</button>` : `<span class="muted">resolved</span>`}
          </div>
        </div>`).join("");
      $$("#adminReports [data-remove]").forEach((b) => b.addEventListener("click", async () => {
        if (!window.confirm("Permanently remove this listing?")) return;
        try { await API.adminRemoveProduct(b.dataset.remove); toast("Removed", "Listing deleted.", "✅"); adminLoadReports(); if (currentHash() === "#/profile") renderProfile(); }
        catch (e) { toast("Error", e.message, "⚠️"); }
      }));
      $$("#adminReports [data-resolve]").forEach((b) => b.addEventListener("click", async () => {
        try { await API.adminResolveReport(b.dataset.resolve); adminLoadReports(); } catch (e) { toast("Error", e.message, "⚠️"); }
      }));
    } catch (e) { el.innerHTML = `<p class="muted">Failed to load reports.</p>`; }
  }
  async function adminLoadUsers() {
    const el = $("#adminUsers"); if (!el) return;
    try {
      const { users, banned } = await API.adminUsers();
      el.innerHTML = `<table class="admin-table"><thead><tr><th>Name</th><th>Email</th><th>ID</th><th>Listings</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr>
          <td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><code>${esc(u.id)}</code></td><td>${u.listings || 0}</td>
          <td>${u.banned ? '<span class="pill pill--danger">Banned</span>' : '<span class="pill pill--ok">Active</span>'}</td>
          <td>${u.banned ? `<button class="btn btn--soft btn--sm" data-unban-email="${esc(u.email)}">Unban</button>` : `<button class="btn btn--danger btn--sm" data-ban-uid="${esc(u.id)}">Ban</button>`}</td>
        </tr>`).join("")}
      </tbody></table>
      ${banned.length ? `<div class="admin-banned"><b>Banned list:</b> ${banned.map((b) => `<code>${esc(b.email || b.userId)}</code>`).join(", ")}</div>` : ""}`;
      $$("#adminUsers [data-ban-uid]").forEach((b) => b.addEventListener("click", async () => { try { await API.adminBan({ userId: b.dataset.banUid }); toast("Banned", "Account suspended.", "🚫"); adminLoadUsers(); } catch (e) { toast("Error", e.message, "⚠️"); } }));
      $$("#adminUsers [data-unban-email]").forEach((b) => b.addEventListener("click", async () => { try { await API.adminUnban({ email: b.dataset.unbanEmail }); toast("Unbanned", "Account restored.", "✅"); adminLoadUsers(); } catch (e) { toast("Error", e.message, "⚠️"); } }));
    } catch (e) { el.innerHTML = `<p class="muted">Failed to load users.</p>`; }
  }
  async function adminLoadAnnouncements() {
    const el = $("#annList"); if (!el) return;
    try {
      const { announcements } = await API.adminAnnouncements();
      if (!announcements.length) { el.innerHTML = `<p class="muted">No announcements.</p>`; return; }
      el.innerHTML = announcements.slice().reverse().map((a) => `
        <div class="admin-ann ${a.active ? "" : "is-off"}">
          <span>${esc(a.text)}</span>
          <div>
            <button class="btn btn--soft btn--sm" data-toggle="${a.id}">${a.active ? "Hide" : "Show"}</button>
            <button class="btn btn--ghost btn--sm" data-del-ann="${a.id}">Delete</button>
          </div>
        </div>`).join("");
      $$("#annList [data-toggle]").forEach((b) => b.addEventListener("click", async () => { try { await API.adminToggleAnnouncement(b.dataset.toggle); adminLoadAnnouncements(); } catch (e) { toast("Error", e.message, "⚠️"); } }));
      $$("#annList [data-del-ann]").forEach((b) => b.addEventListener("click", async () => { try { await API.adminDeleteAnnouncement(b.dataset.delAnn); adminLoadAnnouncements(); } catch (e) { toast("Error", e.message, "⚠️"); } }));
    } catch (e) { el.innerHTML = `<p class="muted">Failed to load.</p>`; }
  }

  /* ============================================================
     ROUTER
     ============================================================ */
  function parseHash() {
    const raw = location.hash.replace(/^#/, "") || "/";
    const [path, q] = raw.split("?");
    const params = {};
    if (q) q.split("&").forEach((kv) => { const [k, v] = kv.split("="); params[k] = decodeURIComponent(v || ""); });
    return { path, params };
  }
  const routes = {
    "/": renderHome, "/marketplace": renderMarketplace, "/categories": renderCategories,
    "/sell": renderSell, "/favorites": renderFavorites, "/notifications": renderNotifications,
    "/messages": renderMessages, "/profile": () => renderProfile(), "/admin": renderAdmin,
  };
  async function router() {
    const { path, params } = parseHash();
    closeMobileNav();
    if (path.startsWith("/product/")) { await renderProduct(path.split("/")[2]); setActiveNav("/marketplace"); window.scrollTo(0, 0); return; }
    if (path.startsWith("/user/")) { await renderProfile(path.split("/")[2]); setActiveNav("/profile"); window.scrollTo(0, 0); return; }
    const fn = routes[path] || renderNotFound;
    if (path === "/" || path === "/marketplace") {
      const token = currentHash();
      view.innerHTML = `<section class="section wrap"><div class="grid grid--4">${skeletonCard().repeat(8)}</div></section>`;
      await wait(420);
      if (currentHash() !== token) return;
    }
    await fn(params);
    setActiveNav(path);
    window.scrollTo(0, 0);
  }
  function setActiveNav(path) {
    const hash = location.hash.replace(/^#/, "");
    const hashQ = hash.split("?")[1] || "";
    $$(".nav__links a").forEach((a) => {
      const href = a.getAttribute("href").replace("#", "");
      const [hrefPath, hrefQ] = href.split("?");
      let active = hrefPath === path;
      if (active && (hrefQ || hashQ)) active = hrefQ === hashQ;
      a.classList.toggle("is-active", active);
    });
  }

  /* ============================================================
     GLOBAL UI
     ============================================================ */
  const nav = $("#nav");
  function onScroll() { nav.classList.toggle("is-stuck", window.scrollY > 24); }
  window.addEventListener("scroll", onScroll, { passive: true }); onScroll();

  const burger = $("#navBurger"), navMobile = $("#navMobile");
  burger.addEventListener("click", () => { const open = navMobile.hidden; navMobile.hidden = !open; burger.classList.toggle("is-open", open); });
  function closeMobileNav() { navMobile.hidden = true; burger.classList.remove("is-open"); }

  $("#navSearchBtn").addEventListener("click", () => { searchOverlay.hidden = false; $("#globalSearch").focus(); $("#globalSearch").value = ""; $("#searchResults").innerHTML = ""; });
  $("#searchClose").addEventListener("click", () => (searchOverlay.hidden = true));
  searchOverlay.addEventListener("click", (e) => { if (e.target === searchOverlay) searchOverlay.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { searchOverlay.hidden = true; closeModal(); } });
  $("#globalSearch").addEventListener("input", async () => {
    const q = $("#globalSearch").value.trim().toLowerCase();
    const res = $("#searchResults");
    if (!q) { res.innerHTML = ""; return; }
    let list = [];
    try { list = (await API.products({ q })).products.slice(0, 6); } catch {}
    res.innerHTML = list.length ? list.map((p) => `<a class="search-result" href="#/product/${p.id}" data-link>${mediaHTML({ src: (p.images && p.images[0]) || "", alt: p.title, seed: p.id, emoji: catIcon(p.category) })}<div><b>${esc(p.title)}</b><span>${money(p.price)} · ${esc(p.condition)}</span><span class="search-seller">${esc(p.seller ? p.seller.name : "Seller")} ${verifyBadge(p.seller)}</span></div></a>`).join("") : `<div class="search-result" style="color:var(--muted)">No results for “${esc($("#globalSearch").value)}”</div>`;
  });

  document.addEventListener("click", (e) => {
    const favBtn = e.target.closest("[data-fav]");
    if (favBtn) { e.preventDefault(); toggleFav(favBtn.dataset.fav, favBtn); return; }
    const link = e.target.closest("a[data-link]");
    if (link) { searchOverlay.hidden = true; closeMobileNav(); }
  });

  document.addEventListener("click", (e) => {
    const num = e.target.closest(".msg-num");
    if (!num) return;
    const v = num.dataset.num;
    const done = () => toast("Copied", v, "📋");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(done).catch(() => fallbackCopy(v, done));
    } else fallbackCopy(v, done);
  });
  function fallbackCopy(v, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = v; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); done();
    } catch { toast("Copy failed", v, "⚠️"); }
  }

  $("#year").textContent = new Date().getFullYear();

  /* ============================================================
     INIT
     ============================================================ */
  async function init() {
    updateNavUser();
    if (API.token) {
      try { const { user } = await API.me(); State.me = user; } catch { API.setToken(null); }
    }
    await loadUserData();
    updateBadges();
    connectSSE();
    renderBanner();
    window.addEventListener("hashchange", router);
    await router();
  }
  init();
})();
