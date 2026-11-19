/** Côté fidèles : fil des homélies, lecture, programme de la semaine, liturgie du jour. Tout fonctionne hors-ligne grâce au cache Firestore. */
import { db, persistenceReady, persistenceNotice } from "./firebase-config.js";
import { collection, onSnapshot, query, orderBy, limit, where, documentId } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { TYPES, STATUT_LABELS, esc, norm, safeUrl, ymd, parseYmd, addDays, mondayOf, fmtDate, fmtShort, renderMarkdown, initPrefs, getFont, setFont, watchNetwork, toast, registerSW, errMsg } from "./utils.js";

const $ = (id) => document.getElementById(id);
const PAGE = 20;
const state = { homelies: [], paroisses: [], slots: [], lit: {}, paroisse: "", type: "", q: "", shown: PAGE, wantedId: null, current: null, weekStart: mondayOf(new Date()), litDate: ymd(), progParoisse: "" };

initPrefs(); watchNetwork($("netBadge")); registerSW($("installBtn"));
persistenceReady.then((r) => { const m = persistenceNotice(r); if (m) toast(m, "warn"); });
const onErr = (what) => (e) => { console.error(what, e); toast(errMsg(e), "err"); };

/* ---------------- Onglets ---------------- */
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  ["homelies", "programme", "liturgie"].forEach((t) => ($("tab-" + t).hidden = t !== b.dataset.tab));
}));

/* ---------------- Paroisses (filtres) ---------------- */
onSnapshot(query(collection(db, "paroisses"), orderBy("nom")), (snap) => {
  state.paroisses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  for (const [sel, val] of [["f-paroisse", state.paroisse], ["p-paroisse", state.progParoisse]]) {
    $(sel).innerHTML = '<option value="">Toutes les paroisses</option>' + state.paroisses.map((p) => `<option value="${esc(p.id)}">${esc(p.nom)}</option>`).join("");
    $(sel).value = val;
  }
}, onErr("paroisses"));

/* ---------------- Fil des homélies ---------------- */
onSnapshot(query(collection(db, "homelies"), orderBy("datePublication", "desc"), limit(300)), { includeMetadataChanges: true }, (snap) => {
  state.homelies = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((h) => !h.supprime);
  $("syncInfo").textContent = snap.metadata.fromCache && !navigator.onLine ? "Données enregistrées sur ce téléphone." : snap.metadata.fromCache ? "Mise à jour en cours…" : "À jour.";
  renderList();
  if (state.wantedId) openFromHash();
}, onErr("homelies"));

function filtered() {
  const q = norm(state.q);
  return state.homelies
    .filter((h) => (!state.paroisse || h.paroisseId === state.paroisse) && (!state.type || h.type === state.type) &&
      (!q || norm([h.titre, h.auteurNom, h.paroisseNom, h.contenuTexte].join(" ")).includes(q)))
    .sort((a, b) => b.datePublication.localeCompare(a.datePublication) || (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
}

function renderList() {
  const items = filtered();
  const plain = (t) => String(t || "").replace(/[#*>_-]/g, "").replace(/\s+/g, " ").trim();
  $("list").innerHTML = items.length ? items.slice(0, state.shown).map((h) => {
    const p = plain(h.contenuTexte);
    return `<a class="card" href="#h=${esc(h.id)}"><span class="tag">${TYPES[h.type] || ""}${h.audioUrl ? " · audio" : ""}${h.videoUrl ? " · vidéo" : ""}</span>
      <b>${esc(h.titre)}</b><span>${esc(p.length > 150 ? p.slice(0, 150) + "…" : p)}</span>
      <span class="mut">${esc(h.auteurNom)} • ${esc(h.paroisseNom)}</span><span class="mut">${esc(fmtDate(h.datePublication))}</span></a>`;
  }).join("") : '<p class="empty">Aucune homélie à afficher. Connectez-vous à Internet au moins une fois pour les enregistrer sur ce téléphone.</p>';
  $("moreBtn").hidden = items.length <= state.shown;
}
$("f-paroisse").addEventListener("change", (e) => { state.paroisse = e.target.value; state.shown = PAGE; renderList(); });
$("f-type").addEventListener("change", (e) => { state.type = e.target.value; state.shown = PAGE; renderList(); });
$("f-q").addEventListener("input", (e) => { state.q = e.target.value; state.shown = PAGE; renderList(); });
$("moreBtn").addEventListener("click", () => { state.shown += PAGE; renderList(); });

/* ---------------- Lecture complète (lien direct : index.html#h=ID) ---------------- */
const dlg = $("reader");
function openFromHash() {
  const m = location.hash.match(/^#h=(.+)$/);
  if (!m) { if (dlg.open) dlg.close(); return; }
  const h = state.homelies.find((x) => x.id === m[1]);
  if (h) { state.wantedId = null; openReader(h); } else state.wantedId = m[1];   // pas encore chargée : on réessaiera
}
addEventListener("hashchange", openFromHash);

function openReader(h) {
  state.current = h;
  $("rd-type").textContent = TYPES[h.type] || "";
  $("rd-title").textContent = h.titre;
  $("rd-meta").textContent = `${h.auteurNom} • ${h.paroisseNom} • ${fmtDate(h.datePublication)}`;
  const a = safeUrl(h.audioUrl), v = safeUrl(h.videoUrl);
  $("rd-media").innerHTML =
    (a ? `<audio controls preload="none" src="${esc(a)}"></audio>` : "") +
    (v ? `<video controls preload="none" playsinline src="${esc(v)}"></video>` : "") +
    ((a || v) && !navigator.onLine ? '<p class="mut">L\'audio et la vidéo nécessitent une connexion Internet ; le texte reste lisible.</p>' : "");
  $("rd-body").innerHTML = renderMarkdown(h.contenuTexte);
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
}
dlg.addEventListener("close", () => {
  dlg.querySelectorAll("audio,video").forEach((m) => m.pause());
  if (location.hash.startsWith("#h=")) history.replaceState(null, "", location.pathname + location.search);
});
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
$("rd-close").addEventListener("click", () => dlg.close());
$("rd-plus").addEventListener("click", () => setFont(getFont() + 2));
$("rd-minus").addEventListener("click", () => setFont(getFont() - 2));
$("rd-theme").addEventListener("click", () => $("themeBtn").click());

/* Partage WhatsApp : titre, prêtre, paroisse, extrait et lien direct vers l'homélie. */
$("rd-share").addEventListener("click", () => {
  const h = state.current; if (!h) return;
  const resume = String(h.contenuTexte || "").replace(/[#*>_]/g, "").replace(/\s+/g, " ").trim();
  const link = location.origin + location.pathname + "#h=" + h.id;
  const text = `*${h.titre}*\n${h.auteurNom} — ${h.paroisseNom}\n${fmtDate(h.datePublication)}\n\n${resume.slice(0, 220)}${resume.length > 220 ? "…" : ""}\n\nLire l'homélie : ${link}`;
  window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
});

/* ---------------- Programme de la semaine ---------------- */
let unsubWeek = null;
function loadWeek() {
  unsubWeek?.();
  const from = ymd(state.weekStart), to = ymd(addDays(state.weekStart, 6));
  $("weekLabel").textContent = `${fmtShort(state.weekStart)} – ${fmtShort(addDays(state.weekStart, 6))}`;
  unsubWeek = onSnapshot(query(collection(db, "programme_semaine"), where("date", ">=", from), where("date", "<=", to), orderBy("date")),
    (snap) => { state.slots = snap.docs.map((d) => ({ id: d.id, ...d.data() })); renderProg(); }, onErr("programme"));
}
function renderProg() {
  const slots = state.slots.filter((s) => !state.progParoisse || s.paroisseId === state.progParoisse);
  const days = [...new Set(slots.map((s) => s.date))].sort();
  $("progList").innerHTML = days.length ? days.map((d) => `<div class="panel"><div class="day">${esc(fmtDate(d))}</div>` +
    slots.filter((s) => s.date === d).map((s) => `<div class="slot"><div><b>${esc(s.paroisseNom)}</b><br><span>${esc(TYPES[s.typeCelebration] || "")} — ${esc(s.pretreNom)}</span>${s.notes ? `<br><span class="mut">${esc(s.notes)}</span>` : ""}</div><span class="badge ${esc(s.statut)}">${esc(STATUT_LABELS[s.statut] || "")}</span></div>`).join("") + "</div>").join("")
    : '<p class="empty">Aucune célébration enregistrée pour cette semaine.</p>';
}
$("weekPrev").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, -7); loadWeek(); });
$("weekNext").addEventListener("click", () => { state.weekStart = addDays(state.weekStart, 7); loadWeek(); });
$("p-paroisse").addEventListener("change", (e) => { state.progParoisse = e.target.value; renderProg(); });

/* ---------------- Liturgie du jour : fenêtre -7 / +30 jours gardée en cache ---------------- */
const litMin = ymd(addDays(new Date(), -7)), litMax = ymd(addDays(new Date(), 30));
onSnapshot(query(collection(db, "liturgie_jour"), where(documentId(), ">=", litMin), where(documentId(), "<=", litMax)),
  (snap) => { state.lit = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])); renderLit(); }, onErr("liturgie"));

function renderLit() {
  const d = state.litDate, l = state.lit[d];
  $("litLabel").textContent = fmtDate(d);
  $("litTitle").textContent = l?.titreLiturgique || "Liturgie du jour";
  $("litText").innerHTML = l?.lecturesTexte ? renderMarkdown(l.lecturesTexte) : '<p class="mut">Aucun texte enregistré pour ce jour. Utilisez le bouton ci-dessous pour consulter les lectures officielles.</p>';
  $("aelfBtn").href = safeUrl(l?.lienAelf) || `https://www.aelf.org/${d}/romain/messe`;
  $("litPrev").disabled = d <= litMin; $("litNext").disabled = d >= litMax;
}
$("litPrev").addEventListener("click", () => { state.litDate = ymd(addDays(parseYmd(state.litDate), -1)); renderLit(); });
$("litNext").addEventListener("click", () => { state.litDate = ymd(addDays(parseYmd(state.litDate), 1)); renderLit(); });

loadWeek(); renderLit(); openFromHash();
