/* ============================================================
   CampusMarket — client config (categories, conditions, helpers)
   ============================================================ */
window.CM = window.CM || {};

const CATEGORIES = [
  { id: "books",       label: "Books",           icon: "📚", tag: "Books & Notes" },
  { id: "electronics", label: "Electronics",     icon: "💻", tag: "Electronics" },
  { id: "phones",      label: "Phones",          icon: "📱", tag: "Phones" },
  { id: "gaming",      label: "Gaming",          icon: "🎮", tag: "Gaming" },
  { id: "fashion",     label: "Fashion",         icon: "👕", tag: "Clothing" },
  { id: "school",      label: "School Supplies", icon: "🎒", tag: "School Supplies" },
  { id: "furniture",   label: "Furniture",       icon: "🪑", tag: "Furniture" },
  { id: "services",    label: "Services",        icon: "🛠️", tag: "Services & Gigs" },
  { id: "other",       label: "Other",           icon: "✨", tag: "Other" },
];
const CONDITIONS = ["New", "Like New", "Good", "Fair", "Used"];
const CAT_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

function catIcon(id) { return (CAT_MAP[id] || CAT_MAP.other).icon; }
function catLabel(id) { return (CAT_MAP[id] || CAT_MAP.other).label; }

/* gradient fallback (used by imgFail when a network image can't load) */
function gradFor(seed) {
  const palettes = [
    ["#6366f1", "#8b5cf6"], ["#0ea5e9", "#22d3ee"], ["#f59e0b", "#f97316"],
    ["#10b981", "#34d399"], ["#ec4899", "#f472b6"], ["#8b5cf6", "#6366f1"],
    ["#14b8a6", "#0ea5e9"], ["#f43f5e", "#fb7185"], ["#3b82f6", "#6366f1"],
  ];
  let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palettes[h % palettes.length];
}

Object.assign(window.CM, { CATEGORIES, CONDITIONS, CAT_MAP, catIcon, catLabel, gradFor });
