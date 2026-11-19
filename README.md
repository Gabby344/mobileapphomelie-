# Homélies — Diocèse de Kolwezi (PWA + Firebase)

Application web progressive : HTML5, CSS3, JavaScript (ES Modules) et Firebase (Authentication, Firestore, Storage).
Aucune étape de build : les fichiers se déposent tels quels sur GitHub Pages ou Firebase Hosting.

```
index.html · app.js          Fidèles : fil des homélies, lecture (texte/audio/vidéo), WhatsApp, programme, liturgie
admin.html · admin.js        Prêtres et SuperAdmin : connexion, rédaction, programme, paroisses, comptes, liturgie
utils.js                     Fonctions partagées (Markdown sûr, dates, thème, réseau, messages d'erreur)
firebase-config.js           Config du projet mobileapphomelie + persistance hors-ligne Firestore
sw.js · manifest.json        PWA : cache hors-ligne et installation
style.css                    Design mobile-first, mode clair/sombre
firestore.rules · storage.rules · firebase.json · .firebaserc    Règles de sécurité et déploiement
```

## 1. Modèle de données Firestore

| Collection | Identifiant | Champs |
|---|---|---|
| `paroisses` | auto | `nom`, `doyenne`, `localisation`, `createdAt` |
| `utilisateurs` | **UID Firebase Auth** | `nom`, `email`, `role` (`SuperAdmin` / `Pretre` / `Fidele`), `paroisseId` (null pour SuperAdmin), `actif`, `createdAt` |
| `programme_semaine` | auto | `date` (`YYYY-MM-DD`), `typeCelebration`, `paroisseId`, `paroisseNom`, `pretreId`, `pretreNom`, `statut` (`Prevu`/`Enregistre`/`Publie`), `notes`, `createdAt`, `updatedAt` |
| `homelies` | auto | `titre`, `datePublication` (`YYYY-MM-DD`), `type`, `contenuTexte` (Markdown), `audioUrl`, `videoUrl`, `auteurNom`, `auteurId`, `paroisseId`, `paroisseNom`, `programmeId`, `supprime`, `createdAt`, `updatedAt` |
| `liturgie_jour` | **la date `YYYY-MM-DD`** | `titreLiturgique`, `lecturesTexte`, `lienAelf`, `misAJourLe` |

Le champ « id » est l'identifiant du document (pas de doublon dans les données). Les fidèles n'ont pas de compte : le rôle `Fidele` existe dans le modèle pour plus tard.
`supprime` : suppression logique, les homélies retirées disparaissent de l'application sans perdre l'historique.
Aucun index composite n'est nécessaire : toutes les requêtes utilisent un seul champ de tri/filtre.

## 2. Mise en route de Firebase (une seule fois)

1. **Authentication** → *Sign-in method* → activer **Email/Mot de passe**.
2. **Firestore Database** → créer la base en **mode production**, dans la région la plus proche proposée.
3. **Firestore → Règles** : coller le contenu de `firestore.rules`, puis *Publier*.
4. **Storage** → activer, puis coller `storage.rules` dans *Règles*. Selon l'état actuel de la console, Cloud Storage peut exiger le plan **Blaze** (paiement à l'usage, avec un quota gratuit) : vérifiez-le. Sans Storage, tout fonctionne avec des **liens** audio/vidéo externes.
5. **Premier SuperAdmin** (à faire à la main, une fois) :
   - *Authentication → Users → Add user* : email + mot de passe ; copier l'**UID** de l'utilisateur ;
   - *Firestore → Démarrer une collection* `utilisateurs` → ID du document = cet **UID** → champs :
     `nom` (string), `email` (string), `role` = `SuperAdmin`, `paroisseId` = null, `actif` = true (boolean).
6. **Authentication → Paramètres → Domaines autorisés** : ajouter le domaine de publication (ex. `votre-compte.github.io`). `localhost` est déjà autorisé.
7. Connectez-vous sur `admin.html`, créez les **paroisses**, puis les **comptes prêtres** (onglet « Comptes »).

### Sécurité : ce qu'il faut comprendre
- La clé `apiKey` de la config est **publique par conception** : ce sont les **règles** qui protègent les données. Chaque écriture est contrôlée par le rôle stocké dans `utilisateurs/{uid}` ; un compte créé « sauvagement » via l'API n'a aucun droit tant qu'aucun profil n'existe.
- Recommandé : *Google Cloud Console → API et services → Identifiants* → restreindre la clé aux **référents HTTP** (votre domaine, et `mobileapphomelie.firebaseapp.com/*`).
- Un prêtre ne peut : créer/modifier **ses propres** homélies **dans sa paroisse**, mettre à jour le **statut** de ses créneaux, envoyer des fichiers audio/vidéo (≤ 50 Mo / ≤ 200 Mo). Il ne peut pas changer de rôle, de paroisse, ni toucher aux homélies des autres.
- Un compte **désactivé** (`actif: false`) perd immédiatement ses droits d'écriture. Pour supprimer définitivement un compte Auth : console Firebase → Authentication.
- Limite connue : dans Storage, un prêtre pourrait écraser un fichier existant s'il en connaît le chemin exact (peu probable, non listable).

## 3. Tester en local
```bash
python3 -m http.server 8080      # ou : npx serve
# ouvrir http://localhost:8080   (localhost est un "contexte sécurisé" : le service worker fonctionne)
```
Test hors-ligne : ouvrir l'app en ligne une fois (charge les homélies) → DevTools → *Application* → *Service Workers* → cocher *Offline* → recharger : le fil, la lecture, le programme et la liturgie s'affichent toujours.
Après modification des fichiers, incrémenter `VERSION` dans `sw.js` pour forcer la mise à jour des appareils.

## 4. Déployer
**GitHub Pages** : pousser le dossier à la racine du dépôt → *Settings → Pages* → branche `main`, dossier `/ (root)`. Tous les chemins sont relatifs, l'app fonctionne aussi dans un sous-dossier (`/nom-du-depot/`).
**Firebase Hosting** (HTTPS et domaine `mobileapphomelie.web.app` offerts) :
```bash
npm install -g firebase-tools
firebase login
firebase deploy                                  # site + règles
firebase deploy --only firestore:rules,storage   # règles seulement
```
**Installation sur téléphone** : Chrome → menu → « Installer l'application » (ou le bouton « Installer » de l'en-tête). Sur iPhone : Safari → Partager → « Sur l'écran d'accueil ».

## 5. Mode hors-ligne : comment ça marche
- **Données** : `enableIndexedDbPersistence` garde les homélies, paroisses, programme et liturgie (fenêtre −7/+30 jours) dans IndexedDB. Si plusieurs onglets sont ouverts, Firestore refuse la persistance dans le second : l'app l'affiche clairement au lieu de planter.
- **Application** : `sw.js` met en cache les pages, scripts, styles **et le SDK Firebase** (sans lui, l'app ne démarrerait pas hors-ligne).
- **Prêtre** : le brouillon est enregistré à chaque frappe dans `localStorage` ; la publication exige Internet (messages explicites) et ne crée pas de doublon en cas de coupure en cours d'envoi.
- **Non disponible hors-ligne** : la lecture audio/vidéo (flux réseau, non mis en cache) et l'envoi de fichiers.

## 6. Points d'attention
- **Liturgie / AELF** : les textes officiels viennent d'AELF ; vérifiez les droits de reproduction avant de coller des lectures complètes (laissez vide, le bouton renvoie vers AELF). Le lien par défaut est de la forme `https://www.aelf.org/AAAA-MM-JJ/romain/messe` ; si AELF change ce format, renseignez le champ « Lien AELF ».
- **Renommer une paroisse** met à jour automatiquement le nom copié dans ses homélies et son programme.
- **Quotas gratuits Firestore** : le cache limite les lectures (seuls les documents modifiés sont relus). Surveillez l'usage dans la console.
- **Notifications push** : non incluses (elles demandent Firebase Cloud Messaging + une Cloud Function, donc le plan Blaze). Extension possible ensuite.
- `enableIndexedDbPersistence` est signalée comme dépréciée dans les SDK récents (remplacée par `persistentLocalCache`) ; elle fonctionne en 10.8.0.
