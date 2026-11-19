/**
 * Initialisation Firebase (projet "mobileapphomelie") + persistance hors-ligne Firestore.
 * Ce module est importé par index.html (app.js) et admin.html (admin.js).
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// Exportée aussi : admin.js en a besoin pour créer les comptes prêtres via une 2e instance Firebase.
export const firebaseConfig = {
  apiKey: "AIzaSyB65QwkP2gSwGf-7G5aPqLm_i1TqJV4av0",
  authDomain: "mobileapphomelie.firebaseapp.com",
  projectId: "mobileapphomelie",
  storageBucket: "mobileapphomelie.firebasestorage.app",
  messagingSenderId: "656485819176",
  appId: "1:656485819176:web:2a71aed2597ec30b41a61d"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

/**
 * Persistance IndexedDB : à appeler AVANT toute autre opération Firestore.
 * Résultat : { ok: true } ou { ok: false, reason: 'multi-tab' | 'unsupported' | 'error' }.
 * Note : enableIndexedDbPersistence est marquée "dépréciée" dans les SDK récents (remplacée par
 * initializeFirestore + persistentLocalCache), mais elle fonctionne en 10.8.0 et reste le choix le plus simple.
 */
export const persistenceReady = enableIndexedDbPersistence(db)
  .then(() => ({ ok: true }))
  .catch((err) => {
    if (err.code === "failed-precondition") return { ok: false, reason: "multi-tab" }; // plusieurs onglets ouverts
    if (err.code === "unimplemented") return { ok: false, reason: "unsupported" };     // navigateur sans IndexedDB
    console.error("Persistance Firestore :", err);
    return { ok: false, reason: "error" };
  });

/** Message lisible pour l'utilisateur si la persistance n'a pas pu être activée. */
export function persistenceNotice(result) {
  if (result.ok) return "";
  if (result.reason === "multi-tab")
    return "Plusieurs onglets sont ouverts : le mode hors-ligne n'est actif que dans le premier. Fermez les autres onglets puis rechargez.";
  if (result.reason === "unsupported")
    return "Ce navigateur ne permet pas le mode hors-ligne (stockage local indisponible).";
  return "Le mode hors-ligne n'a pas pu être activé.";
}
