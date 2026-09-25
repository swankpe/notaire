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
| 4,5 Mo par requête | Photos réduites côté navigateur (canvas), envoyées **une par une** via `/api/media`. La fiche PDF part seule ; au-delà de 3,4 Mo ses pages sont converties en images (pdf.js dans le navigateur) et envoyées en `pages[]`. |
| 4,5 Mo par requête (bis) | La **vidéo diaporama se fabrique dans le navigateur** (canvas + `MediaRecorder`) : un fichier vidéo pèse dix fois la limite, il ne pourrait pas sortir du serveur. Le serveur ne voit que les photos réduites à 512 px, le temps de nommer les pièces. |
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
| `src/video.js` | lit les photos du bien sur le site, nomme les pièces et propose un ordre de visite ; `ordonnerPlans` remet la réponse d'aplomb |
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
- **pdf.js : toujours le build `legacy/`.** Le build courant emploie
  `Map.getOrInsertComputed`, absente des navigateurs qui ne sont pas de
  dernière génération — la conversion échoue avec un message interne
  incompréhensible. `scripts/vendor.js` recopie le bon build à l'installation
  (postinstall), y compris sur Vercel ; `web/public/vendor/` n'est pas versionné.
- Une clé Anthropic non rattachée à un espace de travail fait répondre `400`
  à l'API. `src/claude.js` transmet `ANTHROPIC_WORKSPACE_ID` quand la variable
  existe, et traduit l'erreur en conseil plutôt que de la laisser brute.
- `choisirChampPrix` ne se rabat **jamais** sur « le premier champ numérique » :
  il afficherait un nombre de pièces en guise de prix. Sans champ dont le nom
  évoque un prix, on n'affiche rien.
- Le style des posts Facebook tient dans les **exemples** de
  `config/publication.json`, pas dans les consignes. Pour corriger un ton qui
  dérive, ajouter un bon post plutôt que réécrire les règles.
- **Vidéo : jamais faire confiance à la liste de plans rendue.** Un modèle peut
  oublier une photo ou en citer deux fois. `ordonnerPlans` garantit que chaque
  photo revient une fois et une seule ; une photo rattrapée part **sans texte**,
  jamais avec un titre deviné, et l'utilisateur est prévenu.
- **`/api/bien-photo` ne prend jamais d'adresse.** Elle reçoit un identifiant
  d'élément et un index, relit l'URL dans Webflow, puis télécharge. Accepter
  une URL du navigateur ferait du serveur un relais vers n'importe quelle
  machine — y compris le réseau interne de l'hébergeur. Ne pas « simplifier »
  en passant l'URL directement.
- **Le prix est toujours celui honoraires de négociation inclus.** Une fiche
  notariale en porte souvent plusieurs — net vendeur, honoraires, prix FAI. Le
  champ prix reçoit le total payé par l'acquéreur ; publier un net vendeur
  afficherait un prix inférieur à la réalité. La règle est dans les consignes
  de `src/extraction.js` **et** dans `config/publication.json` : les deux
  doivent rester d'accord.
- **Le carton d'ouverture ne devine rien non plus.** Commune, code postal et
  type de bien sont reconnus à leur intitulé (`choisirChampParNom`) ou imposés
  par configuration. Un champ absent fait disparaître sa ligne, et
  l'utilisateur est prévenu — on n'écrit pas « Maison à vendre » sur une fiche
  qui ne dit pas que c'est une maison.
- **Un titre de pièce est obligatoire** sur toutes les images sauf la première,
  qui porte le carton. Le rendu refuse de partir sinon : une image muette au
  milieu d'une vidéo publiée se remarque.
- **Le texte du post ne vient jamais des photos.** Une seule page produit le
  post et la vidéo, mais les deux sources restent séparées : le texte vient de
  la fiche du CMS, la vidéo des photos déposées. Rédiger d'après une image
  reviendrait à inventer surface, prix et situation.
- **L'habillage vidéo n'est pas une invention.** Cadre blanc filaire en bas à
  gauche, titre clair centré, logo en haut à droite, format carré : tout vient
  des montages que l'étude publie déjà. Les proportions sont dans la constante
  `CADRE`. Ne pas « améliorer » sans un nouveau montage de référence.
- La photo **remplit toujours le cadre**, centrée. Une version posée sur fond
  flou a été essayée puis retirée : l'étude préfère zoomer que laisser des
  bandes.
- **`MediaRecorder` : demander H.264 **et AAC**, accepter moins.** Facebook veut
  du MP4 H.264 ; les navigateurs sans codec propriétaire n'en ont pas et
  produisent du VP9, voire du WebM. Et sans demander `mp4a.40.2`
  explicitement, un navigateur met de l'**Opus** dans le MP4 — valide, mal
  accepté. Le code parcourt `CODECS` par ordre de préférence, avec une liste
  distincte selon qu'il y a du son, et **affiche le format obtenu** — sans quoi
  un refus de Facebook serait inexplicable.
- La musique reste sur le poste : elle est décodée dans le navigateur et mixée
  dans l'enregistrement via `MediaStreamDestination`. Elle ne part jamais vers
  le serveur, et aucun fichier musical n'est versionné — la licence est
  l'affaire de l'étude.
- Le rendu vidéo tourne sur `requestAnimationFrame` : dans un onglet en
  arrière-plan, le navigateur ralentit la cadence et la vidéo sort hachée. D'où
  l'aperçu visible pendant le rendu et le « ne quittez pas cet onglet ».
- `exigerSession` échoue **fermé** (503) quand `surVercel && !protectionActive()`.
  Ne pas assouplir : sur Vercel une variable ajoutée après coup n'est prise en
  compte qu'au déploiement suivant, et le fail-open serait silencieux.
