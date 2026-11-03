// Prosty parser zamówień: rozumie literówki, godzinę i "bez ...".
// Menu to karta Toskanii. Edytuj tutaj, gdy karta się zmieni.
const MENU = {
  "Farcita": ["rukola", "ricotta"],
  "Tartufata": ["szpinak"],
  "Rustica": [],
  "Biancoverde": ["cukinia"],
  "Bosco": [],
  "Milano": ["salami", "gorgonzola"],
  "Margherita": [],
  "Margherita Italiana": [],
  "Zingara": ["gorgonzola", "gruszka", "rukola"],
  "Diavola": ["ricotta"],
  "Parma Italiana": ["rukola"],
  "Nduja": ["nduja", "ricotta", "cebula"],
  "Prosciutto": ["rukola"],
  "Campagnola": ["gorgonzola", "gruszka", "szpinak"],
  "Siciliana": ["tuńczyk", "anchois", "oliwki", "cebula"],
  "Mafioso": ["jalapeño", "czosnek"],
  "Capriciosa": ["szynka", "pieczarki"],
  "Calzone": ["szynka", "pieczarki"],
  "Monti": ["salami", "pieczarki", "papryka", "czosnek"],
  "Quattro formaggi": ["gorgonzola", "ricotta"],
  "Quattro salumi": ["salami", "szynka", "boczek", "nduja"],
  "Havai": ["szynka", "ananas"],
  "Palermo": ["kurczak", "pieczarki", "papryka", "cebula", "curry"],
};
const EXTRA = ["szynka", "pieczarki", "salami", "ananas", "cebula", "rukola", "oliwki", "boczek",
  "tuńczyk", "ricotta", "gorgonzola", "gruszka", "szpinak", "papryka", "czosnek", "jalapeño",
  "kurczak", "anchois", "cukinia", "nduja", "curry"];

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l");

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function near(word, target) {
  word = norm(word); target = norm(target);
  if (word.length < 3) return false;
  return lev(word, target) <= Math.max(1, Math.floor(target.length / 4)) ||
    (target.startsWith(word) && word.length >= 4);
}

function parse(text) {
  const words = text.split(/[\s,.!?]+/).filter(Boolean);
  const res = { pizza: null, extras: [], time: "ASAP", note: "" };

  const m = text.match(/(\d{1,2})[:.](\d{2})/) || text.match(/(?:na|o)\s+(\d{1,2})(?!\d)/);
  if (m) {
    const h = +m[1];
    if (h < 24) res.time = String(h).padStart(2, "0") + ":" + (m[2] && m[2].length === 2 ? m[2] : "00");
  }

  let best = null, bd = 9;
  for (const p of Object.keys(MENU)) {
    const first = p.split(" ")[0];
    for (const w of words) {
      if (w.length < 4) continue;
      const d = lev(norm(w), norm(first));
      if (d <= Math.max(1, Math.floor(first.length / 4)) && d < bd) { bd = d; best = p; }
    }
  }
  if (!best && words.some((w) => near(w, "serowa"))) best = "Quattro formaggi";
  if (best === "Quattro formaggi" && words.some((w) => near(w, "salumi") || near(w, "salami"))) best = "Quattro salumi";
  if (best === "Margherita" && words.some((w) => near(w, "italiana"))) best = "Margherita Italiana";
  res.pizza = best;

  const withoutIdx = words.findIndex((w) => norm(w) === "bez");
  const banned = withoutIdx >= 0 ? words.slice(withoutIdx + 1).map(norm) : [];
  for (const x of EXTRA) {
    const stem = norm(x).slice(0, -1);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (near(w, x) || (norm(w).startsWith(stem) && stem.length >= 4)) {
        if (withoutIdx >= 0 && i > withoutIdx) continue;
        if (!res.extras.includes(x)) res.extras.push(x);
      }
    }
  }
  if (best) res.extras = res.extras.filter((x) => !MENU[best].includes(x));
  if (withoutIdx >= 0) {
    const stop = new Set(["na", "o", "asap", "i", "oraz", "po"]);
    const w = [];
    for (const x of words.slice(withoutIdx + 1, withoutIdx + 4)) { if (stop.has(norm(x)) || /\d/.test(x)) break; w.push(x); }
    if (w.length) res.note = "bez " + w.join(" ");
  }
  return res;
}

// Opis do potwierdzenia / panelu
function describe(r) {
  const name = r.pizza || ("Własna: " + r.extras.join(", "));
  const extra = r.pizza && r.extras.length ? "dodatkowo: " + r.extras.join(", ") : "";
  const note = [extra, r.note].filter(Boolean).join("; ");
  return { pizza: name, note, time: r.time };
}

module.exports = { MENU, EXTRA, parse, describe };
