# Notes pour Claude Code

Outil interne d'une étude notariale : publie une annonce immobilière dans une
collection Webflow CMS à partir d'une fiche PDF et d'un dossier de photos.
Tourne en local (`npm start`) et en ligne sur Vercel, avec le même code.

## Repères

- Node 20+, ESM, JavaScript simple (pas de TypeScript, pas d'étape de build) :
  l'utilisateur est gestionnaire de site Webflow, pas développeur.
- **Le français visible à l'écran est accentué** (messages d'erreur,
  avertissements, interface). Les commentaires du code restent sobres.
- Le mode par défaut est le **brouillon** (`isDraft: true`). Toute publication
  directe demande une confirmation explicite. Ne pas changer ce réglage.
- Rien n'est deviné : un champ absent de la fiche reste vide et l'utilisateur
  est prévenu. Sur une annonce notariale, une valeur inventée est une faute.
- **Aucun état serveur.** Une requête ne peut rien supposer d'une précédente.

## Contraintes Vercel qui dictent la conception

Ne pas les contourner sans mesurer : elles sont la raison d'être de la
structure actuelle.

| Contrainte | Conséquence dans le code |
| --- | --- |
| 4,5 Mo par requête | Photos réduites côté navigateur (canvas), envoyées **une par une** via `/api/media`. La fiche PDF part seule. |
| Pas de mémoire entre requêtes | Le navigateur garde les fichiers ; chaque route est autonome. Ne jamais réintroduire un cache de session côté serveur. |
| Disque en lecture seule | Rien ne s'écrit à l'exécution. Les réglages non secrets vivent dans `config/webflow.json`, **versionné**, donc déployé avec le code ; seuls les secrets sont des variables d'environnement. L'écran de configuration ne peut rien enregistrer : il affiche les valeurs à reporter. |
| Détection du point d'entrée | `server.js` doit rester **à la racine** : c'est ainsi que Vercel capture le serveur. |

## Architecture

| Fichier | Rôle |
| --- | --- |
| `server.js` | point d'entrée unique (local et Vercel) |
| `web/app.js` | routes Express, protégées par `exigerSession` ; `/api/sites`, `/api/collections` et `/api/reglages` servent l'écran de configuration |
| `src/auth.js` | mot de passe partagé, cookie HMAC dérivé du mot de passe ; **échoue fermé** en ligne sans mot de passe |
| `src/webflow.js` | API Webflow v2 : cadence, reprises, médias en deux temps (métadonnées Webflow puis dépôt S3, champ `file` en dernier) |
| `src/schema.js` | collection Webflow → schéma JSON → `fieldData` ; isole `champsReference` (listes déroulantes) de `champsNonGeres` |
| `src/claude.js` | client Claude partagé : en-tête `anthropic-workspace-id`, traduction des erreurs d'API |
| `src/extraction.js` | lecture de la fiche PDF via l'API Claude (document base64) |
| `src/publication.js` | rédaction du post Facebook ; le style vient de `config/publication.json`, versionné |
| `src/photos.js` | sharp : redressement, redimensionnement, JPEG, EXIF supprimés |
| `src/pipeline.js` | les quatre étapes, indépendantes ; `publierBien` les chaîne pour la CLI |
| `src/cli.js` | `setup`, `champs`, `import`, `vercel` |

L'outil est **piloté par le schéma** : il lit la structure réelle de la
collection à chaque exécution et s'y adapte. Ne pas coder en dur des noms de
champs propres à une étude.

Le navigateur réduit déjà les photos, mais `src/photos.js` refait le travail :
la garantie « aucune donnée EXIF » doit tenir côté serveur, pas dépendre du
navigateur du poste.

## Tests

```bash
npm test
```

`test/faux-webflow.js` rejoue l'API Webflow ; aucun test n'appelle le vrai
Webflow ni l'API Claude. Toute modification de `src/webflow.js`, `src/schema.js`
ou `src/auth.js` doit rester couverte.

Le parcours navigateur (connexion, canvas, envoi photo par photo) ne se vérifie
qu'avec Playwright, pas avec `fetch` : le redimensionnement côté client n'existe
pas hors d'un vrai navigateur.

## Pièges rencontrés

- Dépôt S3 : les champs de signature doivent précéder le binaire, `file` en dernier.
- Conversion des nombres : on **extrait le premier nombre**, on ne filtre pas les
  caractères. Un filtrage collait le « 2 » de « m2 » à la valeur et
  « 142,5 m2 » devenait 142,52. Et `Number('')` vaut `0`, donc « nous consulter »
  deviendrait un prix de 0 — voir `nombreDepuisTexte`.
- Les photos sont nommées au moment de **l'envoi**, pas de l'analyse : le titre
  a pu être corrigé et les photos réordonnées pendant la relecture. D'où
  `/api/slug`, appelé avant le premier envoi de photo.
- Dans le faux serveur S3, `filename="…"` contient `name="` : la vérification
  des champs multipart exige un préfixe.
- Une référence s'écrit comme l'identifiant de l'élément (`"65c…"`), une
  multi-référence comme un tableau d'identifiants. La collection visée se lit
  dans `validations.collectionId`.
- Une clé Anthropic non rattachée à un espace de travail fait répondre `400`
  à l'API. `src/claude.js` transmet `ANTHROPIC_WORKSPACE_ID` quand la variable
  existe, et traduit l'erreur en conseil plutôt que de la laisser brute.
- Le style des posts Facebook tient dans les **exemples** de
  `config/publication.json`, pas dans les consignes. Pour corriger un ton qui
  dérive, ajouter un bon post plutôt que réécrire les règles.
- `exigerSession` échoue **fermé** (503) quand `surVercel && !protectionActive()`.
  Ne pas assouplir : sur Vercel une variable ajoutée après coup n'est prise en
  compte qu'au déploiement suivant, et le fail-open serait silencieux.
