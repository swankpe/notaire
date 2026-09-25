# Mise en ligne des biens sur le site de l'étude

Cet outil transforme **une fiche PDF + un dossier de photos** en **une annonce
dans le CMS Webflow**, en quelques minutes au lieu d'une saisie manuelle.

Il fait, dans l'ordre :

1. il lit la fiche PDF (même scannée) et en extrait les champs de votre collection ;
2. il allège les photos : redressement, redimensionnement, conversion JPEG et
   **suppression des données EXIF**, donc des coordonnées GPS du logement.
   Une photo d'iPhone passe typiquement de 4,6 Mo à 430 Ko, soit **−91 %**,
   et l'écran vous montre le gain réel avant l'envoi ;
3. il vous montre tout à l'écran **pour relecture et correction** ;
4. il envoie les photos dans la bibliothèque du site, puis crée l'annonce
   **en brouillon** (rien n'est visible en ligne tant que vous ne publiez pas).

L'outil ne devine jamais un montant, une surface ou une mention légale : ce qui
n'est pas écrit sur la fiche reste vide, et il vous signale les points à vérifier.

Il tourne **en local** (`npm start`) ou **en ligne sur Vercel** — même code,
même écran. Voir « Mise en ligne sur Vercel » plus bas.

---

## Installation en local

Il faut [Node.js](https://nodejs.org) version 20 ou plus.

```bash
npm install
cp .env.example .env
```

Ouvrez `.env` et renseignez :

**`WEBFLOW_TOKEN`** — dans Webflow : *Site settings → Apps & integrations →
API access → Generate API token*. Cochez les portées :

| Portée | À quoi elle sert |
| --- | --- |
| `sites:read` | lister les sites et les collections |
| `cms:read` | lire la structure de la collection, repérer les doublons |
| `cms:write` | créer l'annonce |
| `assets:read` et `assets:write` | envoyer les photos dans la bibliothèque |

**`ANTHROPIC_API_KEY`** — sur <https://console.anthropic.com/settings/keys>.
C'est elle qui permet la lecture automatique des fiches et la rédaction des
posts. Sans elle l'outil fonctionne quand même, mais les champs sont à saisir
à la main.

> **Créez-la depuis un espace de travail.** Une clé non rattachée à un espace
> fait répondre `400` à l'API, avec le message *« This API key is not scoped to
> a workspace »* — les deux fonctions IA tombent alors ensemble. Si vous tenez
> à garder une clé non rattachée, renseignez `ANTHROPIC_WORKSPACE_ID` avec
> l'identifiant de l'espace : l'outil transmet alors l'en-tête attendu.

Puis, une fois :

```bash
npm run setup
```

Cette commande liste vos sites, puis vos collections, et enregistre votre choix
dans `config/config.json`. Elle repère aussi toute seule le champ « photo
principale » et le champ « galerie ».

---

## Usage courant

```bash
npm start
```

Ouvrez <http://localhost:4000>, puis :

1. glissez la fiche PDF et les photos dans la zone de dépôt ;
2. cliquez **Lire la fiche** ;
3. **relisez** : les champs trouvés sont pré-remplis, ceux laissés vides
   apparaissent sur fond crème, et les points douteux sont listés en haut ;
4. réordonnez les photos si besoin — **la première est la photo principale**,
   les suivantes forment la galerie. Vous pouvez en **ajouter à tout moment**
   depuis la zone sous la grille ;
5. cliquez **Créer en brouillon**.

L'annonce apparaît alors dans le CMS Webflow. Vous la relisez une dernière fois
dans l'éditeur, puis vous publiez le site comme d'habitude.

Le bouton **Publier en ligne** existe aussi, avec une confirmation : il met
l'annonce en ligne immédiatement, sans passer par le brouillon.

### En ligne de commande

Si vous préférez traiter un dossier déjà rangé sur le disque :

```bash
npm run import -- ./biens/maison-saint-brieuc
npm run import -- ./biens/maison-saint-brieuc --simulation   # sans rien envoyer
npm run import -- ./biens/maison-saint-brieuc --publier      # en ligne directement
```

Le dossier doit contenir **une** fiche PDF et les photos. Elles sont classées
comme dans l'explorateur de fichiers (`photo-2` avant `photo-10`).

Pour voir comment votre collection est interprétée :

```bash
npm run champs
```

---

## Mise en ligne sur Vercel

Avantage : plus rien à installer, l'outil est à une adresse, accessible depuis
n'importe quel poste.

### 1. Protéger l'accès — à faire en premier

L'outil publie sur le site de l'étude. **Sans mot de passe, toute personne
connaissant l'adresse pourrait créer des annonces** et consommer votre quota
d'API. La variable `MOT_DE_PASSE` n'est donc pas optionnelle en ligne.

L'écran de connexion demande ce mot de passe et pose un cookie de session signé,
valable 12 heures. Changer le mot de passe invalide les sessions ouvertes.

`npm run vercel` vous en propose un, tiré au hasard.

**En ligne, l'outil refuse de fonctionner si `MOT_DE_PASSE` est absente** : il
répond `503` sur toutes ses routes et écrit un avertissement dans les journaux
Vercel. C'est volontaire — sur Vercel, une variable ajoutée après coup ne prend
effet qu'au déploiement suivant, et « j'ajoute le mot de passe puis j'oublie de
redéployer » laisserait sinon le site ouvert. En local, l'absence de mot de
passe reste permise et simplement signalée.

### 2. Créer le projet

1. Poussez le dépôt sur GitHub (c'est déjà le cas).
2. Sur <https://vercel.com/new>, importez le dépôt. Aucun réglage de build à
   toucher : Vercel détecte `server.js` à la racine et le transforme en fonction.
3. Dans *Settings → Environment Variables*, créez les variables listées par :

```bash
npm run vercel
```

Cette commande affiche les identifiants de site et de collection à recopier,
ainsi que la liste des secrets attendus. Sur Vercel, `config/config.json`
n'existe pas : le disque y est en lecture seule, ce sont les variables
d'environnement qui font foi.

4. Redéployez, ouvrez l'adresse, saisissez le mot de passe.

**Sans passer par le terminal.** Si vous ne voulez rien installer en local,
déployez avec `MOT_DE_PASSE`, `WEBFLOW_TOKEN` et `ANTHROPIC_API_KEY`
seulement. À la connexion, l'outil affiche un **écran de configuration** :
il liste vos sites et vos collections Webflow, vous choisissez, et il vous
donne les variables restantes à coller — puis un dernier redéploiement.

### Ce que la mise en ligne change au fonctionnement

Trois contraintes de Vercel ont dicté la conception ; elles sont invisibles à
l'usage, mais expliquent la structure du code :

| Contrainte Vercel | Conséquence |
| --- | --- |
| **4,5 Mo par requête** | Les photos sont réduites dans le navigateur puis envoyées **une par une**, avec une barre de progression. Une fiche PDF trop lourde voit ses **pages converties en images** avant l'envoi. |
| **Aucune mémoire entre deux requêtes** | Rien n'est gardé côté serveur. Le navigateur conserve la fiche et les photos, et chaque étape est autonome. Fermer l'onglet en cours de route ne laisse donc rien derrière. |
| **Disque en lecture seule** | La configuration vient des variables d'environnement, pas de `config/config.json`. |

### Le coût

Le plan **Hobby de Vercel est réservé à un usage personnel non commercial** —
c'est écrit dans leurs conditions d'utilisation. Un outil interne d'étude
notariale est un usage professionnel : il faut donc le plan **Pro, à 20 $ par
mois**. Ce n'est pas une contrainte technique, l'outil tournerait sur Hobby,
mais c'est le cadre posé par Vercel.

Si ces 20 $/mois ne se justifient pas pour quelques annonces par mois, l'usage
en local (`npm start`) reste gratuit et strictement équivalent.

---

## Publier sur Facebook : le texte et la vidéo

Second onglet de l'outil. **Vous choisissez un bien, rien d'autre.** Tout
vient de sa fiche sur le site : le texte de sa description, la vidéo de ses
photos déjà publiées.

1. **Choisissez le bien.**
2. **Un seul bouton** lance les deux analyses en même temps : la rédaction du
   post, et la reconnaissance des pièces sur les photos du site.
3. Relisez le texte, corrigez les titres, générez la vidéo.

L'un n'attend pas l'autre. Si la rédaction échoue, la reconnaissance des
pièces aboutit quand même, et inversement.

Le bien doit donc **être publié avec ses photos avant** de faire la vidéo —
c'est le premier onglet qui s'en charge. Un bien sans photo sur le site le dit
franchement plutôt que de produire une vidéo vide.

### Le texte

Avec plus de cent cinquante biens, dérouler la liste ne suffit pas : un
**filtre par ville** (et par office, ou tout autre champ de référence de votre
collection) restreint d'abord la sélection. Les biens apparaissent ensuite du
plus récent au plus ancien, **avec leur prix**, et les brouillons sont
signalés.

Un filtre n'est proposé que si au moins deux biens s'y répartissent : inutile
d'encombrer l'écran avec un critère qui ne trie rien.

Le texte s'affiche dans une zone modifiable : relisez, corrigez, copiez. Rien
n'est publié automatiquement — c'est vous qui collez dans Facebook.

Le style se règle dans **`config/publication.json`**, versionné :

| Clé | Rôle |
| --- | --- |
| `urlBien` | gabarit du lien vers la fiche, avec `{slug}` à la place de l'adresse du bien |
| `consignes` | la structure attendue et le ton |
| `exemples` | vos publications réelles |

**Ce sont les exemples qui font le style**, davantage que les consignes. Quand
un post vous plaît particulièrement, ajoutez-le à la liste : c'est le moyen le
plus efficace de corriger le tir. Inversement, un exemple qui ne vous
ressemble plus mérite d'être retiré.

Comme pour la lecture des fiches, rien n'est inventé : une surface ou une
proximité absente du CMS n'apparaît pas dans le post, et le manque est signalé
au-dessus du texte. **Le texte ne vient jamais des photos** : une annonce
notariale ne se rédige pas d'après une image.

### La vidéo

Les photos sont celles du bien sur le site : la photo principale d'abord, puis
la galerie — et si la principale figure aussi dans la galerie, elle ne passe
qu'une fois.

**La première image ouvre la vidéo** : commune et code postal, « Maison à
vendre », et le prix dans un cadre. Tout est relu dans la fiche du site. Un
champ absent fait disparaître sa ligne et vous êtes prévenu — on n'écrit pas
« Maison à vendre » sur une fiche qui ne dit pas que c'est une maison. Le prix
affiché est celui de la fiche, **honoraires de négociation inclus**.

Les images suivantes portent le nom de la pièce, incrusté en bas à gauche dans
un cadre blanc filaire ; les plans s'enchaînent en fondu. **Un titre est
obligatoire sur chacune** : le rendu refuse de partir tant qu'il en manque un,
parce qu'une image muette au milieu d'une vidéo publiée se remarque. Retirez
la photo ou donnez-lui un titre.

Vous pouvez ajouter **une musique** : choisissez un fichier de votre poste, il
est mixé dans la vidéo avec un fondu à l'ouverture et à la fermeture, et repris
en boucle s'il est plus court que le montage. Le fichier ne quitte jamais votre
ordinateur. **La licence est votre affaire** : voir plus bas. Claude propose un
titre pour chacune (« Cuisine », « Grange », « Terrain »…) et les remet dans un
ordre de visite — on arrive par la façade, on traverse la maison, on ressort
par les annexes et le terrain.

Quelques points à connaître :

- **Le montage se fait dans votre navigateur.** Une vidéo de trente secondes
  pèse dix fois la limite d'une requête Vercel : elle ne pourrait pas être
  fabriquée sur le serveur. Celui-ci se contente de relire les photos sur le
  site et de les renvoyer à la taille utile — 512 px pour reconnaître les
  pièces, 1600 px pour le montage.
- **Vous pouvez retirer ou réordonner les photos** du montage sans toucher à
  celles du site : l'onglet ne modifie jamais la fiche Webflow.
- **Ne quittez pas l'onglet pendant le rendu.** Un navigateur ralentit les
  onglets en arrière-plan et la vidéo sortirait hachée. Le rendu dure le temps
  de la vidéo : trente secondes de vidéo, trente secondes d'attente.
- **Utilisez Chrome ou Edge à jour.** Ce sont les seuls à produire du MP4
  H.264, le format que Facebook attend. Ailleurs la vidéo sort en WebM et
  l'outil vous le signale.
- **Le format carré 1:1 est celui de l'étude**, et c'est celui qui recadre le
  moins : une photo en 4:3 n'y perd qu'un quart de sa largeur. La photo remplit
  toujours le cadre, centrée — jamais de bandes. En vertical 9:16 le recadrage
  est sévère et l'outil vous prévient.
- **Le logo s'incruste en haut à droite** s'il existe : déposez-le dans
  `web/public/logo.png` (PNG à fond transparent). Sans ce fichier, la vidéo se
  fait sans logo.
- **L'habillage est celui de vos vidéos** : cadre blanc filaire en bas à
  gauche, titre clair centré dedans. Les proportions sont relevées sur vos
  montages, dans la constante `CADRE` de `web/public/index.html`.
- **Un titre n'est jamais deviné.** Si Claude hésite, la photo passe sans
  texte, et vous êtes prévenu.
- **La musique engage l'étude, pas l'outil.** « Libre de droits » ne veut pas
  dire « gratuit » : c'est la licence du morceau qui dit ce que vous avez le
  droit d'en faire, et une page professionnelle relève de l'usage commercial.
  Aucun fichier musical n'est livré avec l'outil. Deux voies sûres :
  la bibliothèque sonore de Facebook au moment de publier (mais elle ne
  s'incruste pas dans le fichier), ou un morceau téléchargé sous une licence
  qui autorise explicitement l'usage commercial. Gardez la preuve de la licence
  avec le morceau.

---

## Ce que l'outil remplit, et ce qu'il ne remplit pas

| Type de champ Webflow | Traitement |
| --- | --- |
| Texte, texte riche, nombre, e-mail, téléphone, lien, date, case à cocher | lu dans la fiche |
| Liste déroulante (*Option*) | lu dans la fiche, puis recalé sur un choix existant ; si la valeur ne correspond à aucun choix, le champ est laissé vide et vous êtes prévenu |
| *Image* | première photo |
| *Galerie* (*MultiImage*) | toutes les photos, dans l'ordre choisi à l'écran |
| *Fichier* | la fiche PDF, si vous l'activez (voir plus bas) |
| *Slug* | calculé à partir du titre |
| *Référence* / *Multi-référence* | **liste déroulante** à la relecture, alimentée par les éléments de la collection visée — ces valeurs ne se lisent pas dans la fiche |
| *Couleur* | **non géré** : à renseigner dans Webflow |

Les champs *Référence* (« ville », « office en charge du dossier »…) demandent
de choisir un élément existant dans une autre collection : c'est un geste
éditorial, l'outil ne devine pas à votre place. Il affiche donc une liste
déroulante en bas de l'écran de relecture, avec les éléments de la collection
visée, triés par nom. Une multi-référence devient une liste à choix multiples.

---

## Réglages

Les réglages **non secrets** (site, collection, champs) vivent dans
`config/webflow.json`, **versionné** : ils partent donc avec le code, sans rien
à recopier dans Vercel. `npm run setup` écrit ce fichier ; il suffit ensuite de
le commiter.

Seuls les **secrets** sont des variables d'environnement : `WEBFLOW_TOKEN`,
`ANTHROPIC_API_KEY`, `MOT_DE_PASSE`.

Par ordre de priorité croissante : valeurs par défaut, `config/webflow.json`,
`config/config.json` (surcharge locale, non versionnée), variables
d'environnement.

| Clé | Variable | Rôle |
| --- | --- | --- |
| `champImagePrincipale` | `WEBFLOW_CHAMP_IMAGE` | slug du champ image ; vide = détection automatique |
| `champGalerie` | `WEBFLOW_CHAMP_GALERIE` | slug du champ galerie ; vide = détection automatique |
| `champFichePdf` | `WEBFLOW_CHAMP_FICHE_PDF` | slug d'un champ *Fichier* où déposer la fiche PDF ; vide = la fiche n'est pas envoyée |
| `consignes` | `CONSIGNES` | consignes libres pour la lecture automatique |
| `champPrix` | `WEBFLOW_CHAMP_PRIX` | slug du champ prix affiché dans la liste des biens ; vide = détection automatique |
| `photoLargeurMax` | `PHOTO_LARGEUR_MAX` | largeur maximale des photos (2400 px par défaut ; 1920 divise encore le poids par deux) |
| `photoQualite` | `PHOTO_QUALITE` | qualité JPEG (82 par défaut) |
| `modele` | `MODELE` | modèle utilisé pour la lecture des fiches |
| `champsObligatoires` | `CHAMPS_OBLIGATOIRES` | noms ou slugs des champs que l'étude veut toujours voir remplis, en plus de ceux que Webflow déclare obligatoires ; l'écran de relecture refuse d'enregistrer tant qu'ils sont vides |

`champsObligatoires` accepte le nom affiché ou le slug, sans égard aux accents
ni aux majuscules. Un champ qui n'existe pas dans la collection est signalé au
lancement plutôt qu'ignoré :

```json
"champsObligatoires": ["Ville", "Office"]
```

Ce que Webflow déclare obligatoire garde son « continuer quand même » ; ce que
l'étude exige ici n'en a pas.

Le champ `consignes` est le plus utile à l'usage. Exemple :

```json
"consignes": "Les honoraires de négociation sont toujours à la charge de l'acquéreur, sauf mention contraire. Le titre de l'annonce suit le format « Type - Commune ». Ne jamais employer « coup de cœur » ni « rare »."
```

---

## Questions pratiques

**Les photos de mon iPhone sont refusées.**
Elles sont au format HEIC. Exportez-les en JPEG (Réglages → Photos → Transférer
vers Mac ou PC → Automatique), ou faites « Dupliquer » puis exportez.

**La fiche est un scan, sans texte sélectionnable.**
Ce n'est pas un problème : la fiche est envoyée telle quelle et lue comme une
image. Relisez simplement les montants avec attention.

**Ma fiche PDF fait plus de 4 Mo.**
C'est traité automatiquement : au-delà de 3,4 Mo, le navigateur convertit les
pages du PDF en images avant de les envoyer, en baissant la définition jusqu'à
tenir dans la limite d'une requête. Une fiche scannée de 7,6 Mo descend
typiquement à 1,4 Mo en quatre images.

Claude lit ces images aussi bien que le PDF — une fiche scannée est de toute
façon une image. L'écran vous prévient de la conversion et vous invite à
relire les montants. Si même réduite la fiche ne passe pas, il vous le dit et
suggère de n'envoyer que les pages utiles.

**Un bien porte déjà ce titre.**
L'outil détecte le doublon et crée l'annonce sous un slug voisin plutôt que
d'écraser l'existant. Il vous le signale dans le journal d'envoi.

**Rien n'est jamais publié par accident ?**
Non. Le mode par défaut est le brouillon, et le bouton « Publier en ligne »
demande une confirmation explicite.

**J'ai oublié le mot de passe.**
Changez `MOT_DE_PASSE` dans les variables Vercel et redéployez.

---

## Vérifier que tout fonctionne

```bash
npm test
```

43 tests : structure de collection, conversion des valeurs, préparation des
photos, protection par mot de passe, garde-fou en ligne, et le parcours complet
de publication.
Ils utilisent un faux serveur Webflow et une fiche PDF d'exemple : ils ne
touchent ni à votre site, ni à votre quota d'API.

---

## Détail technique

- `server.js` — point d'entrée unique, en local comme sur Vercel.
- `web/app.js` — les routes : `/api/analyse` (fiche seule), `/api/slug`,
  `/api/media` (un fichier par requête), `/api/creer`. Aucune donnée n'est
  conservée entre deux requêtes.
- `src/auth.js` — mot de passe et cookie de session signé.
- `src/webflow.js` — client de l'API Webflow v2 : cadence ajustée à la limite
  annoncée par votre offre, reprises automatiques sur 429 et 5xx, envoi des
  médias en deux temps (Webflow puis dépôt S3).
- `src/schema.js` — traduit votre collection en schéma JSON, puis reconvertit la
  lecture en `fieldData` Webflow (nombres, listes déroulantes, cases à cocher).
- `src/extraction.js` — lecture de la fiche PDF.
- `src/photos.js` — préparation des images (sharp).
- `src/pipeline.js` — les quatre étapes, indépendantes les unes des autres.

Aucun jeton n'est versionné : `.env` et `config/config.json` sont ignorés par git.
