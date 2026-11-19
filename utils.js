/** Fonctions partagées par app.js (fidèles) et admin.js (espace prêtre / SuperAdmin). */

export const TYPES = { Dimanche: "Dimanche", MesseMatinale: "Messe matinale", Solennite: "Solennité" };
export const STATUT_LABELS = { Prevu: "Prévu", Enregistre: "Enregistré", Publie: "Publié" };

/* ---------- Texte ---------- */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** Minuscules sans accents, pour la recherche. */
export const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** N'accepte que les liens http(s) (évite javascript:). */
export const safeUrl = (u) => { try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };

const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
/** Mini-Markdown sûr (le HTML est échappé AVANT) : # titre, > citation, - liste, **gras**, *italique*. */
export function renderMarkdown(src) {
  return esc(src).replace(/\r/g, "").split(/\n{2,}/).filter((b) => b.trim()).map((b) => {
    if (/^#{1,3}\s/.test(b)) return `<h3>${inline(b.replace(/^#{1,3}\s/, ""))}</h3>`;
    if (/^&gt;\s?/.test(b)) return `<blockquote>${inline(b.replace(/^&gt;\s?/gm, "").replace(/\n/g, "<br>"))}</blockquote>`;
    if (/^[-*]\s/.test(b)) return `<ul>${b.split("\n").map((l) => `<li>${inline(l.replace(/^[-*]\s/, ""))}</li>`).join("")}</ul>`;
    return `<p>${inline(b).replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

/* ---------- Dates (YYYY-MM-DD en heure locale, sans décalage UTC) ---------- */
export const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const fmtDate = (s) => cap(parseYmd(s).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
export const fmtShort = (d) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });

/* ---------- Préférences (thème, taille de police) ---------- */
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } }
};
export const getFont = () => Number(store.get("fontSize")) || 18;
export function setFont(n) {
  n = Math.min(30, Math.max(14, n));
  store.set("fontSize", n);
  document.documentElement.style.setProperty("--reader-size", n + "px");
}
export function initPrefs() {
  const root = document.documentElement;
  const apply = (t) => { root.dataset.theme = t; document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#5e1429" : "#8b1e3f"); };
  apply(store.get("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  setFont(getFont());
  document.getElementById("themeBtn")?.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    apply(next); store.set("theme", next);
  });
}

/* ---------- Réseau, notifications, PWA ---------- */
export function watchNetwork(el) {
  const update = () => {
    const on = navigator.onLine;
    el.className = "net " + (on ? "on" : "off");
    el.textContent = on ? "En ligne" : "Mode hors-ligne — données locales disponibles";
  };
  addEventListener("online", update); addEventListener("offline", update); update();
}

export function toast(msg, kind = "info") {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; t.className = "show " + kind;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ""), kind === "warn" ? 7000 : 3500);
}

export function registerSW(installBtn) {
  if ("serviceWorker" in navigator) {
    const reg = () => navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW :", e));
    document.readyState === "complete" ? reg() : addEventListener("load", reg);
  }
  let deferred;
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; if (installBtn) installBtn.hidden = false; });
  installBtn?.addEventListener("click", async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; installBtn.hidden = true; });
}

/** Traduit les erreurs Firebase en messages compréhensibles. */
export function errMsg(e) {
  const c = e?.code || "";
  const map = {
    "auth/invalid-credential": "Email ou mot de passe incorrect.",
    "auth/wrong-password": "Email ou mot de passe incorrect.",
    "auth/user-not-found": "Email ou mot de passe incorrect.",
    "auth/invalid-email": "Adresse email invalide.",
    "auth/too-many-requests": "Trop de tentatives. Patientez quelques minutes.",
    "auth/email-already-in-use": "Cet email est déjà utilisé.",
    "auth/weak-password": "Mot de passe trop faible (6 caractères minimum, 8 conseillés).",
    "auth/network-request-failed": "Réseau indisponible. Réessayez quand la connexion revient.",
    "permission-denied": "Vous n'avez pas les droits pour cette action.",
    "unauthenticated": "Session expirée, reconnectez-vous.",
    "unavailable": "Serveur injoignable. Les données locales restent disponibles.",
    "storage/unauthorized": "Envoi du fichier refusé (droits, type ou taille).",
    "storage/canceled": "Envoi annulé.",
    "timeout": "Connexion instable : réessayez (l'homélie ne sera pas dupliquée)."
  };
  return map[c] || e?.message || "Une erreur est survenue.";
}
