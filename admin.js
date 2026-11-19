/**
 * Espace prêtre / SuperAdmin : connexion Firebase Auth, rédaction d'homélies (brouillon local, upload audio/vidéo),
 * programme de la semaine, et pour le SuperAdmin : paroisses, comptes prêtres, liturgie du jour.
 * Les droits réels sont imposés par firestore.rules / storage.rules : l'interface ne fait que masquer ce qui est interdit.
 */
import { auth, db, storage, firebaseConfig, persistenceReady, persistenceNotice } from "./firebase-config.js";
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { TYPES, STATUT_LABELS, esc, safeUrl, ymd, addDays, fmtDate, initPrefs, watchNetwork, toast, registerSW, errMsg } from "./utils.js";

const $ = (id) => document.getElementById(id);
const state = { me: null, paroisses: [], users: [], slots: [], homelies: [], unsubs: [], editingId: null, pendingId: null, draftSel: null, draftRestored: false };

initPrefs(); watchNetwork($("netBadge")); registerSW();
persistenceReady.then((r) => { const m = persistenceNotice(r); if (m) toast(m, "warn"); });

const isSA = () => state.me?.role === "SuperAdmin";
const paroisseNom = (id) => state.paroisses.find((p) => p.id === id)?.nom || "";
const setMsg = (el, text, cls = "err") => { el.textContent = text; el.className = text ? cls : ""; };
const opt = (v, t) => `<option value="${esc(v)}">${esc(t)}</option>`;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code: "timeout" }), ms))]);
const onErr = (what) => (e) => { console.error(what, e); toast(errMsg(e), "err"); };

/** Remplit un <select> en conservant la valeur choisie si elle existe encore. */
function fillSelect(sel, options, placeholder) {
  const prev = sel.value;
  sel.innerHTML = (placeholder !== undefined ? opt("", placeholder) : "") + options.map(([v, t]) => opt(v, t)).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

/* =========================== Connexion =========================== */
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setMsg($("loginMsg"), "");
  $("lg-btn").disabled = true;
  try { await signInWithEmailAndPassword(auth, $("lg-email").value.trim(), $("lg-pwd").value); }
  catch (err) { setMsg($("loginMsg"), errMsg(err)); }
  finally { $("lg-btn").disabled = false; }
});
$("forgot").addEventListener("click", async () => {
  const email = $("lg-email").value.trim();
  if (!email) return setMsg($("loginMsg"), "Saisissez d'abord votre email.");
  try { await sendPasswordResetEmail(auth, email); setMsg($("loginMsg"), "Si ce compte existe, un email de réinitialisation vient d'être envoyé.", "ok"); }
  catch (err) { setMsg($("loginMsg"), errMsg(err)); }
});
$("logoutBtn").addEventListener("click", () => signOut(auth));

function showLogin(message = "") {
  $("login").hidden = false; $("app").hidden = true; $("logoutBtn").hidden = true;
  setMsg($("loginMsg"), message);
}

onAuthStateChanged(auth, async (user) => {
  stopListeners(); state.me = null;
  if (!user) return showLogin();
  try {
    const snap = await getDoc(doc(db, "utilisateurs", user.uid));
    if (!snap.exists() || snap.data().actif === false) {
      await signOut(auth);
      return showLogin("Ce compte n'est pas autorisé. Contactez l'administrateur du diocèse.");
    }
    state.me = { uid: user.uid, ...snap.data() };
    startApp();
  } catch (err) { showLogin(errMsg(err)); }
});

function stopListeners() { state.unsubs.forEach((u) => u()); state.unsubs = []; }

/* =========================== Démarrage selon le rôle =========================== */
const TABS = [
  { id: "programme", label: () => (isSA() ? "Programme" : "Mon programme") },
  { id: "homelie", label: () => "Rédiger" },
  { id: "mes", label: () => (isSA() ? "Homélies" : "Mes homélies") },
  { id: "paroisses", label: () => "Paroisses", sa: true },
  { id: "pretres", label: () => "Comptes", sa: true },
  { id: "liturgie", label: () => "Liturgie du jour", sa: true }
];

function startApp() {
  $("login").hidden = true; $("app").hidden = false; $("logoutBtn").hidden = false;
  document.querySelectorAll("[data-sa]").forEach((el) => (el.hidden = !isSA()));
  $("who").textContent = `${state.me.nom} — ${isSA() ? "SuperAdmin" : "Prêtre"}`;
  $("pg-list-title").textContent = isSA() ? "Programme à venir" : "Mes prochains créneaux";
  $("mes-title").textContent = isSA() ? "Dernières homélies (toutes paroisses)" : "Mes homélies";

  const tabs = TABS.filter((t) => !t.sa || isSA());
  $("adminTabs").innerHTML = tabs.map((t) => `<button role="tab" data-tab="${t.id}" aria-selected="false">${esc(t.label())}</button>`).join("");
  $("adminTabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); };
  showTab("programme");

  // Date par défaut + restauration du brouillon (hors-ligne : lu depuis localStorage)
  $("h-date").value = ymd(); $("li-date").value = ymd(); $("pg-date").value = ymd();
  restoreDraft();
  subscribeAll();
  loadLiturgie();
}
function showTab(id) {
  document.querySelectorAll("#adminTabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.id !== "p-" + id));
}

function subscribeAll() {
  const me = state.me, today = ymd();
  const sub = (q, cb, label) => state.unsubs.push(onSnapshot(q, cb, onErr(label)));

  sub(query(collection(db, "paroisses"), orderBy("nom")), (snap) => {
    state.paroisses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const opts = state.paroisses.map((p) => [p.id, p.nom]);
    fillSelect($("h-paroisse"), opts); fillSelect($("pg-paroisse"), opts); fillSelect($("pr-paroisse"), opts, "—");
    applyDraftSelects(); renderParoisses(); renderUsers(); renderSlots(); renderHomelies(); fillPretreSelect();
  }, "paroisses");

  if (isSA()) {
    sub(collection(db, "utilisateurs"), (snap) => {
      state.users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderUsers(); fillPretreSelect();
    }, "utilisateurs");
    sub(query(collection(db, "programme_semaine"), where("date", ">=", ymd(addDays(new Date(), -7))), orderBy("date")), onSlots, "programme");
    sub(query(collection(db, "homelies"), orderBy("datePublication", "desc"), limit(100)), onHomelies, "homelies");
  } else {
    // Filtre d'égalité seul : pas d'index composite nécessaire, on trie côté client.
    sub(query(collection(db, "programme_semaine"), where("pretreId", "==", me.uid)), onSlots, "programme");
    sub(query(collection(db, "homelies"), where("auteurId", "==", me.uid)), onHomelies, "homelies");
  }
}
function onSlots(snap) {
  const from = ymd(addDays(new Date(), -7));
  state.slots = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.date >= from).sort((a, b) => a.date.localeCompare(b.date));
  renderSlots(); fillProgrammeSelect();
}
function onHomelies(snap) {
  state.homelies = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((h) => !h.supprime)
    .sort((a, b) => b.datePublication.localeCompare(a.datePublication));
  renderHomelies();
}

/* =========================== Programme =========================== */
function renderSlots() {
  const canEdit = isSA();
  $("progList").innerHTML = state.slots.length ? state.slots.map((s) => `
    <div class="item"><div><b>${esc(fmtDate(s.date))}</b><br><span>${esc(TYPES[s.typeCelebration] || "")} — ${esc(s.paroisseNom)}</span>
      ${canEdit ? `<br><span class="mut">${esc(s.pretreNom)}</span>` : ""}${s.notes ? `<br><span class="mut">${esc(s.notes)}</span>` : ""}</div>
      <div class="actions">
        <select data-act="statut" data-id="${esc(s.id)}" aria-label="Statut">${Object.entries(STATUT_LABELS).map(([k, v]) => `<option value="${k}"${s.statut === k ? " selected" : ""}>${v}</option>`).join("")}</select>
        ${canEdit ? `<button class="btn btn-sec btn-sm" data-act="edit-slot" data-id="${esc(s.id)}">Modifier</button><button class="btn btn-danger btn-sm" data-act="del-slot" data-id="${esc(s.id)}">Supprimer</button>` : ""}
      </div></div>`).join("") : '<p class="empty">Aucun créneau à venir.</p>';
}
$("progList").addEventListener("change", async (e) => {
  if (e.target.dataset.act !== "statut") return;
  try { await withTimeout(updateDoc(doc(db, "programme_semaine", e.target.dataset.id), { statut: e.target.value, updatedAt: serverTimestamp() }), 15000); toast("Statut mis à jour.", "ok"); }
  catch (err) { toast(errMsg(err), "err"); }
});
$("progList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const s = state.slots.find((x) => x.id === b.dataset.id); if (!s) return;
  if (b.dataset.act === "edit-slot") {
    $("pg-id").value = s.id; $("pg-date").value = s.date; $("pg-type").value = s.typeCelebration; $("pg-paroisse").value = s.paroisseId;
    fillPretreSelect(); $("pg-pretre").value = s.pretreId; $("pg-statut").value = s.statut; $("pg-notes").value = s.notes || "";
    $("pg-title").textContent = "Modifier le créneau"; $("pg-cancel").hidden = false; scrollTo({ top: 0, behavior: "smooth" });
  } else if (b.dataset.act === "del-slot" && confirm("Supprimer ce créneau du programme ?")) {
    try { await deleteDoc(doc(db, "programme_semaine", s.id)); toast("Créneau supprimé.", "ok"); } catch (err) { toast(errMsg(err), "err"); }
  }
});
function fillPretreSelect() {
  const pid = $("pg-paroisse").value;
  const priests = state.users.filter((u) => u.role === "Pretre" && u.actif !== false && (!pid || u.paroisseId === pid));
  fillSelect($("pg-pretre"), priests.map((u) => [u.id, u.nom]));
}
$("pg-paroisse").addEventListener("change", fillPretreSelect);
function resetSlotForm() { $("progForm").reset(); $("pg-id").value = ""; $("pg-date").value = ymd(); $("pg-title").textContent = "Ajouter un créneau"; $("pg-cancel").hidden = true; fillPretreSelect(); }
$("pg-cancel").addEventListener("click", resetSlotForm);
$("progForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pretre = state.users.find((u) => u.id === $("pg-pretre").value);
  if (!pretre || !$("pg-paroisse").value) return toast("Choisissez une paroisse et un prêtre de cette paroisse.", "err");
  const id = $("pg-id").value || doc(collection(db, "programme_semaine")).id;
  const data = {
    date: $("pg-date").value, typeCelebration: $("pg-type").value, paroisseId: $("pg-paroisse").value, paroisseNom: paroisseNom($("pg-paroisse").value),
    pretreId: pretre.id, pretreNom: pretre.nom, statut: $("pg-statut").value, notes: $("pg-notes").value.trim(), updatedAt: serverTimestamp()
  };
  try { await withTimeout(setDoc(doc(db, "programme_semaine", id), $("pg-id").value ? data : { ...data, createdAt: serverTimestamp() }, { merge: true }), 15000); toast("Créneau enregistré.", "ok"); resetSlotForm(); }
  catch (err) { toast(errMsg(err), "err"); }
});

/* =========================== Homélies : brouillon local =========================== */
const DRAFT_FIELDS = ["paroisse", "auteur", "titre", "date", "type", "programme", "texte", "audio-url", "video-url"];
const draftKey = () => `draft-homelie:${state.me.uid}`;

function saveDraft() {
  if (state.editingId || !state.me) return;                    // on ne garde de brouillon que pour une nouvelle homélie
  const d = Object.fromEntries(DRAFT_FIELDS.map((f) => [f, $("h-" + f).value]));
  try { localStorage.setItem(draftKey(), JSON.stringify(d)); $("draftInfo").textContent = "Brouillon enregistré sur cet appareil à " + new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) + "."; } catch { /* stockage plein ou indisponible */ }
}
let draftTimer;
$("hForm").addEventListener("input", () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); });

function restoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch { /* brouillon illisible */ }
  if (!d || !(d.titre || d.texte)) return;
  for (const f of ["auteur", "titre", "date", "type", "texte", "audio-url", "video-url"]) if (d[f]) $("h-" + f).value = d[f];
  state.draftSel = { paroisse: d.paroisse, programme: d.programme };   // les <select> sont remplis plus tard (données Firestore)
  $("draftInfo").textContent = "Brouillon précédent restauré depuis cet appareil.";
}
function applyDraftSelects() {
  if (!state.draftSel) return;
  const { paroisse } = state.draftSel;
  if (paroisse && [...$("h-paroisse").options].some((o) => o.value === paroisse)) { $("h-paroisse").value = paroisse; state.draftSel.paroisse = null; }   // appliqué une seule fois
}
function clearDraft() { try { localStorage.removeItem(draftKey()); } catch { /* ignore */ } state.draftSel = null; $("draftInfo").textContent = ""; }
$("h-clear").addEventListener("click", () => { if (confirm("Effacer le brouillon et vider le formulaire ?")) resetHomelieForm(); });

function fillProgrammeSelect() {
  const mine = state.slots.filter((s) => s.statut !== "Publie" || s.id === state.draftSel?.programme);
  fillSelect($("h-programme"), mine.map((s) => [s.id, `${fmtDate(s.date)} — ${TYPES[s.typeCelebration] || ""} — ${s.paroisseNom}`]), "Aucun");
  if (state.draftSel?.programme && [...$("h-programme").options].some((o) => o.value === state.draftSel.programme)) { $("h-programme").value = state.draftSel.programme; state.draftSel.programme = null; }   // appliqué une seule fois
}

/* =========================== Homélies : publication =========================== */
function uploadFile(file, path, onProgress) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), file, { contentType: file.type });
    task.on("state_changed", (s) => onProgress(s.bytesTransferred / s.totalBytes), reject, async () => resolve(await getDownloadURL(task.snapshot.ref)));
  });
}
const MAX = { audio: 50 * 1024 * 1024, video: 200 * 1024 * 1024 };
function checkFile(file, kind) {
  if (!file) return "";
  if (!file.type.startsWith(kind + "/")) return `Le fichier ${kind === "audio" ? "audio" : "vidéo"} n'est pas valide.`;
  if (file.size > MAX[kind]) return `Le fichier ${kind === "audio" ? "audio" : "vidéo"} dépasse ${MAX[kind] / 1024 / 1024} Mo.`;
  return "";
}
function resetHomelieForm() {
  state.editingId = null; state.pendingId = null; state.draftSel = null;
  $("hForm").reset(); $("h-date").value = ymd(); clearDraft();
  $("h-formTitle").textContent = "Nouvelle homélie"; $("h-submit").textContent = "Publier l'homélie";
  $("h-cancel").hidden = true; $("h-clear").hidden = false; $("h-progress").hidden = true; setMsg($("hMsg"), "");
}
$("h-cancel").addEventListener("click", resetHomelieForm);

$("hForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setMsg($("hMsg"), "");
  const me = state.me, editing = state.editingId;
  const audioFile = $("h-audio-file").files[0], videoFile = $("h-video-file").files[0];
  const problem = checkFile(audioFile, "audio") || checkFile(videoFile, "video");
  if (problem) return setMsg($("hMsg"), problem);
  const paroisseId = isSA() ? $("h-paroisse").value : me.paroisseId;
  if (!paroisseId) return setMsg($("hMsg"), "Choisissez la paroisse.");
  for (const f of ["audio-url", "video-url"]) if ($("h-" + f).value.trim() && !safeUrl($("h-" + f).value)) return setMsg($("hMsg"), "Les liens audio/vidéo doivent commencer par http:// ou https://.");
  if (!navigator.onLine) return setMsg($("hMsg"), "Pas de connexion Internet. Votre brouillon est conservé sur cet appareil : réessayez dès que le réseau revient.", "warn");

  // Identifiant fixé AVANT l'envoi : si la connexion coupe, un nouvel essai réécrit le même document (pas de doublon).
  const id = editing || state.pendingId || (state.pendingId = doc(collection(db, "homelies")).id);
  $("h-submit").disabled = true;
  try {
    let audioUrl = safeUrl($("h-audio-url").value), videoUrl = safeUrl($("h-video-url").value);
    const bar = $("h-progress"); bar.hidden = !(audioFile || videoFile);
    if (audioFile) { audioUrl = await uploadFile(audioFile, `homelies/${id}/audio_${Date.now()}.${(audioFile.name.split(".").pop() || "mp3").toLowerCase()}`, (p) => (bar.value = p * (videoFile ? 0.5 : 1))); }
    if (videoFile) { videoUrl = await uploadFile(videoFile, `homelies/${id}/video_${Date.now()}.${(videoFile.name.split(".").pop() || "mp4").toLowerCase()}`, (p) => (bar.value = (audioFile ? 0.5 : 0) + p * (audioFile ? 0.5 : 1))); }

    const common = {
      titre: $("h-titre").value.trim(), datePublication: $("h-date").value, type: $("h-type").value, contenuTexte: $("h-texte").value,
      audioUrl: audioUrl || "", videoUrl: videoUrl || "", programmeId: $("h-programme").value || "", updatedAt: serverTimestamp()
    };
    if (editing) {
      const patch = { ...common };
      if (isSA()) { patch.paroisseId = paroisseId; patch.paroisseNom = paroisseNom(paroisseId); if ($("h-auteur").value.trim()) patch.auteurNom = $("h-auteur").value.trim(); }
      await withTimeout(updateDoc(doc(db, "homelies", id), patch), 20000);
    } else {
      await withTimeout(setDoc(doc(db, "homelies", id), {
        ...common, paroisseId, paroisseNom: paroisseNom(paroisseId),
        auteurId: me.uid, auteurNom: (isSA() && $("h-auteur").value.trim()) || me.nom,
        supprime: false, createdAt: serverTimestamp()
      }), 20000);
    }
    if (common.programmeId) { try { await updateDoc(doc(db, "programme_semaine", common.programmeId), { statut: "Publie", updatedAt: serverTimestamp() }); } catch { /* créneau d'un autre prêtre : on ignore */ } }

    toast(editing ? "Homélie mise à jour." : "Homélie publiée.", "ok");
    resetHomelieForm(); showTab("mes");
  } catch (err) {
    setMsg($("hMsg"), errMsg(err) + (err?.code === "timeout" || err?.code === "unavailable" ? " Votre brouillon est conservé." : ""));
  } finally { $("h-submit").disabled = false; $("h-progress").hidden = true; }
});

/* =========================== Mes homélies =========================== */
function renderHomelies() {
  $("mesList").innerHTML = state.homelies.length ? state.homelies.map((h) => `
    <div class="item"><div><b>${esc(h.titre)}</b><br><span class="mut">${esc(fmtDate(h.datePublication))} • ${esc(TYPES[h.type] || "")} • ${esc(h.paroisseNom)}${isSA() ? " • " + esc(h.auteurNom) : ""}</span></div>
      <div class="actions"><button class="btn btn-sec btn-sm" data-act="edit" data-id="${esc(h.id)}">Modifier</button><button class="btn btn-danger btn-sm" data-act="del" data-id="${esc(h.id)}">Supprimer</button></div></div>`).join("")
    : '<p class="empty">Aucune homélie pour le moment.</p>';
}
$("mesList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const h = state.homelies.find((x) => x.id === b.dataset.id); if (!h) return;
  if (b.dataset.act === "edit") {
    state.editingId = h.id; state.pendingId = null;
    $("h-titre").value = h.titre; $("h-date").value = h.datePublication; $("h-type").value = h.type; $("h-texte").value = h.contenuTexte || "";
    $("h-audio-url").value = h.audioUrl || ""; $("h-video-url").value = h.videoUrl || ""; $("h-auteur").value = isSA() ? h.auteurNom || "" : "";
    if (isSA()) $("h-paroisse").value = h.paroisseId;
    state.draftSel = { programme: h.programmeId }; fillProgrammeSelect();
    $("h-formTitle").textContent = "Modifier l'homélie"; $("h-submit").textContent = "Enregistrer les modifications";
    $("h-cancel").hidden = false; $("h-clear").hidden = true; $("draftInfo").textContent = ""; showTab("homelie"); scrollTo({ top: 0 });
  } else if (b.dataset.act === "del" && confirm(`Supprimer l'homélie « ${h.titre} » ? Elle disparaîtra de l'application des fidèles.`)) {
    try { await withTimeout(updateDoc(doc(db, "homelies", h.id), { supprime: true, updatedAt: serverTimestamp() }), 15000); toast("Homélie supprimée.", "ok"); }
    catch (err) { toast(errMsg(err), "err"); }
  }
});

/* =========================== SuperAdmin : paroisses =========================== */
function renderParoisses() {
  $("paList").innerHTML = state.paroisses.length ? state.paroisses.map((p) => `
    <div class="item"><div><b>${esc(p.nom)}</b><br><span class="mut">${esc(p.doyenne || "")}${p.doyenne && p.localisation ? " • " : ""}${esc(p.localisation || "")}</span></div>
      <div class="actions"><button class="btn btn-sec btn-sm" data-act="edit" data-id="${esc(p.id)}">Modifier</button><button class="btn btn-danger btn-sm" data-act="del" data-id="${esc(p.id)}">Supprimer</button></div></div>`).join("")
    : '<p class="empty">Aucune paroisse. Ajoutez la première ci-dessus.</p>';
}
function resetParoisseForm() { $("paForm").reset(); $("pa-id").value = ""; $("pa-loc").value = "Kolwezi"; $("pa-title").textContent = "Ajouter une paroisse"; $("pa-cancel").hidden = true; }
$("pa-cancel").addEventListener("click", resetParoisseForm);
$("paForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nom = $("pa-nom").value.trim(), id = $("pa-id").value;
  if (state.paroisses.some((p) => p.nom.toLowerCase() === nom.toLowerCase() && p.id !== id)) return toast("Une paroisse porte déjà ce nom.", "err");
  try {
    const ref_ = doc(db, "paroisses", id || doc(collection(db, "paroisses")).id);
    const data = { nom, doyenne: $("pa-doy").value.trim(), localisation: $("pa-loc").value.trim() };
    const old = id ? state.paroisses.find((p) => p.id === id) : null;
    await withTimeout(setDoc(ref_, id ? data : { ...data, createdAt: serverTimestamp() }, { merge: true }), 15000);
    if (old && old.nom !== nom) await renameEverywhere(id, nom);
    toast("Paroisse enregistrée.", "ok"); resetParoisseForm();
  } catch (err) { toast(errMsg(err), "err"); }
});
/** Les homélies et le programme gardent le nom de la paroisse (copie) : on le met à jour en cas de renommage. */
async function renameEverywhere(paroisseId, nom) {
  for (const col of ["homelies", "programme_semaine"]) {
    const snap = await getDocs(query(collection(db, col), where("paroisseId", "==", paroisseId)));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, { paroisseNom: nom }));
      await batch.commit();
    }
  }
}
$("paList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const p = state.paroisses.find((x) => x.id === b.dataset.id); if (!p) return;
  if (b.dataset.act === "edit") {
    $("pa-id").value = p.id; $("pa-nom").value = p.nom; $("pa-doy").value = p.doyenne || ""; $("pa-loc").value = p.localisation || "";
    $("pa-title").textContent = "Modifier la paroisse"; $("pa-cancel").hidden = false; scrollTo({ top: 0, behavior: "smooth" });
  } else if (b.dataset.act === "del") {
    if (state.users.some((u) => u.paroisseId === p.id)) return toast("Des comptes sont rattachés à cette paroisse : réaffectez-les d'abord.", "err");
    try {
      const used = await getDocs(query(collection(db, "homelies"), where("paroisseId", "==", p.id), limit(1)));
      if (!used.empty) return toast("Des homélies sont rattachées à cette paroisse : suppression impossible.", "err");
      if (!confirm(`Supprimer la paroisse « ${p.nom} » ?`)) return;
      await deleteDoc(doc(db, "paroisses", p.id)); toast("Paroisse supprimée.", "ok");
    } catch (err) { toast(errMsg(err), "err"); }
  }
});

/* =========================== SuperAdmin : comptes =========================== */
function renderUsers() {
  $("prList").innerHTML = state.users.length ? state.users.slice().sort((a, b) => a.nom.localeCompare(b.nom)).map((u) => `
    <div class="item"><div><b>${esc(u.nom)}</b> ${u.actif === false ? '<span class="badge">désactivé</span>' : ""}<br><span class="mut">${esc(u.email)} • ${esc(u.role)}${u.paroisseId ? " • " + esc(paroisseNom(u.paroisseId)) : ""}</span></div>
      <div class="actions">
        <select data-act="paroisse" data-id="${esc(u.id)}" aria-label="Paroisse">${opt("", "—")}${state.paroisses.map((p) => `<option value="${esc(p.id)}"${u.paroisseId === p.id ? " selected" : ""}>${esc(p.nom)}</option>`).join("")}</select>
        <button class="btn btn-sec btn-sm" data-act="reset" data-id="${esc(u.id)}">Mot de passe</button>
        ${u.id !== state.me.uid ? `<button class="btn btn-sec btn-sm" data-act="actif" data-id="${esc(u.id)}">${u.actif === false ? "Réactiver" : "Désactiver"}</button>` : ""}
      </div></div>`).join("") : '<p class="empty">Aucun compte.</p>';
}
$("pr-role").addEventListener("change", () => { $("pr-paroisse").disabled = $("pr-role").value === "SuperAdmin"; });
$("prForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setMsg($("prMsg"), "");
  const role = $("pr-role").value, paroisseId = role === "Pretre" ? $("pr-paroisse").value : null;
  if (role === "Pretre" && !paroisseId) return setMsg($("prMsg"), "Choisissez la paroisse du prêtre.");
  if (!navigator.onLine) return setMsg($("prMsg"), "Connexion Internet requise pour créer un compte.", "warn");
  try {
    // 2e instance Firebase : createUserWithEmailAndPassword connecte le nouvel utilisateur,
    // ce qui déconnecterait le SuperAdmin si on utilisait l'instance principale.
    const secondary = getApps().find((a) => a.name === "secondary") || initializeApp(firebaseConfig, "secondary");
    const secAuth = getAuth(secondary);
    const cred = await createUserWithEmailAndPassword(secAuth, $("pr-email").value.trim(), $("pr-pwd").value);
    try {
      await setDoc(doc(db, "utilisateurs", cred.user.uid), {
        nom: $("pr-nom").value.trim(), email: $("pr-email").value.trim().toLowerCase(), role, paroisseId, actif: true, createdAt: serverTimestamp()
      });
    } finally { await signOut(secAuth); }
    $("prForm").reset(); $("pr-paroisse").disabled = false;
    setMsg($("prMsg"), "Compte créé. Communiquez le mot de passe provisoire par un canal sûr ; la personne pourra le changer via « Mot de passe oublié ».", "ok");
  } catch (err) { setMsg($("prMsg"), errMsg(err)); }
});
$("prList").addEventListener("change", async (e) => {
  if (e.target.dataset.act !== "paroisse") return;
  try { await updateDoc(doc(db, "utilisateurs", e.target.dataset.id), { paroisseId: e.target.value || null }); toast("Paroisse mise à jour.", "ok"); }
  catch (err) { toast(errMsg(err), "err"); }
});
$("prList").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const u = state.users.find((x) => x.id === b.dataset.id); if (!u) return;
  try {
    if (b.dataset.act === "actif") { await updateDoc(doc(db, "utilisateurs", u.id), { actif: u.actif === false }); toast(u.actif === false ? "Compte réactivé." : "Compte désactivé.", "ok"); }
    if (b.dataset.act === "reset") { await sendPasswordResetEmail(auth, u.email); toast("Email de réinitialisation envoyé.", "ok"); }
  } catch (err) { toast(errMsg(err), "err"); }
});

/* =========================== SuperAdmin : liturgie du jour =========================== */
async function loadLiturgie() {
  if (!isSA()) return;
  setMsg($("liMsg"), "");
  try {
    const snap = await getDoc(doc(db, "liturgie_jour", $("li-date").value));
    const d = snap.exists() ? snap.data() : {};
    $("li-titre").value = d.titreLiturgique || ""; $("li-lectures").value = d.lecturesTexte || ""; $("li-aelf").value = d.lienAelf || "";
  } catch { /* hors-ligne et jamais consulté : formulaire vide */ }
}
$("li-date").addEventListener("change", loadLiturgie);
$("liForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setMsg($("liMsg"), "");
  const aelf = $("li-aelf").value.trim();
  if (aelf && !safeUrl(aelf)) return setMsg($("liMsg"), "Le lien AELF doit commencer par https://");
  try {
    await withTimeout(setDoc(doc(db, "liturgie_jour", $("li-date").value), {
      titreLiturgique: $("li-titre").value.trim(), lecturesTexte: $("li-lectures").value, lienAelf: aelf, misAJourLe: serverTimestamp()
    }), 15000);
    setMsg($("liMsg"), "Liturgie enregistrée.", "ok");
  } catch (err) { setMsg($("liMsg"), errMsg(err)); }
});
$("li-del").addEventListener("click", async () => {
  if (!confirm("Supprimer la liturgie de ce jour ?")) return;
  try { await deleteDoc(doc(db, "liturgie_jour", $("li-date").value)); $("li-titre").value = $("li-lectures").value = $("li-aelf").value = ""; setMsg($("liMsg"), "Supprimée.", "ok"); }
  catch (err) { setMsg($("liMsg"), errMsg(err)); }
});
