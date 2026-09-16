# Mise en ligne des biens sur le site de l'étude

Cet outil transforme **une fiche PDF + un dossier de photos** en **une annonce
dans le CMS Webflow**, en quelques minutes au lieu d'une saisie manuelle.

Il fait, dans l'ordre :

1. il lit la fiche PDF (même scannée) et en extrait les champs de votre collection ;
2. il prépare les photos : redressement, redimensionnement, conversion JPEG et
   **suppression des données EXIF**, donc des coordonnées GPS du logement ;
3. il vous montre tout à l'écran **pour relecture et correction** ;
4. il envoie les photos dans la bibliothèque du site, puis crée l'annonce
   **en brouillon** (rien n'est visible en ligne tant que vous ne publiez pas).

L'outil ne devine jamais un montant, une surface ou une mention légale : ce qui
n'est pas écrit sur la fiche reste vide, et il vous signale les points à vérifier.

---

## Installation (une seule fois)

Il faut [Node.js](https://nodejs.org) version 20 ou plus.

```bash
npm install
cp .env.example .env
```

Ouvrez `.env` et renseignez deux valeurs :

**`WEBFLOW_TOKEN`** — dans Webflow : *Site settings → Apps & integrations →
API access → Generate API token*. Cochez les portées :

| Portée | À quoi elle sert |
| --- | --- |
| `sites:read` | lister les sites et les collections |
| `cms:read` | lire la structure de la collection, repérer les doublons |
| `cms:write` | créer l'annonce |
| `assets:read` et `assets:write` | envoyer les photos dans la bibliothèque |

**`ANTHROPIC_API_KEY`** — sur <https://console.anthropic.com/settings/keys>.
C'est elle qui permet la lecture automatique des fiches. Sans elle l'outil
fonctionne quand même, mais les champs sont à saisir à la main.

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
4. réordonnez les photos si besoin — **la première est la photo principale** ;
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

## Ce que l'outil remplit, et ce qu'il ne remplit pas

| Type de champ Webflow | Traitement |
| --- | --- |
| Texte, texte riche, nombre, e-mail, téléphone, lien, date, case à cocher | lu dans la fiche |
| Liste déroulante (*Option*) | lu dans la fiche, puis recalé sur un choix existant ; si la valeur ne correspond à aucun choix, le champ est laissé vide et vous êtes prévenu |
| *Image* | première photo |
| *Galerie* (*MultiImage*) | toutes les photos, dans l'ordre choisi à l'écran |
| *Fichier* | la fiche PDF, si vous l'activez (voir plus bas) |
| *Slug* | calculé à partir du titre |
| *Référence* vers une autre collection, *Couleur* | **non gérés** : à renseigner dans Webflow |

Les champs *Référence* (par exemple « notaire en charge du dossier » ou
« commune » pointant vers une autre collection) demandent de choisir un élément
existant : c'est un geste éditorial, l'outil ne le fait pas à votre place.
Il vous les rappelle en haut de l'écran.

---

## Réglages (`config/config.json`)

Créé par `npm run setup`, modifiable à la main :

| Clé | Rôle |
| --- | --- |
| `champImagePrincipale` | slug du champ image ; `null` = détection automatique |
| `champGalerie` | slug du champ galerie ; `null` = détection automatique |
| `champFichePdf` | slug d'un champ *Fichier* où déposer la fiche PDF ; `null` = la fiche n'est pas envoyée |
| `consignes` | consignes libres transmises à la lecture automatique : vocabulaire de l'étude, mentions obligatoires, conventions de rédaction |
| `photoLargeurMax` | largeur maximale des photos (2400 px par défaut) |
| `photoQualite` | qualité JPEG (82 par défaut) |
| `modele` | modèle utilisé pour la lecture des fiches |

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

**Un bien porte déjà ce titre.**
L'outil détecte le doublon et crée l'annonce sous un slug voisin plutôt que
d'écraser l'existant. Il vous le signale dans le journal d'envoi.

**J'ai fermé l'onglet avant l'envoi.**
Le dépôt est conservé une heure côté serveur, mais l'écran de relecture est
perdu : redéposez la fiche et les photos.

**Rien n'est jamais publié par accident ?**
Non. Le mode par défaut est le brouillon, et le bouton « Publier en ligne »
demande une confirmation explicite.

---

## Vérifier que tout fonctionne

```bash
npm test
```

Les tests utilisent un faux serveur Webflow et une fiche PDF d'exemple : ils ne
touchent ni à votre site, ni à votre quota d'API.

---

## Détail technique

- `src/webflow.js` — client de l'API Webflow v2 : cadence des requêtes ajustée à
  la limite annoncée par votre offre, reprises automatiques sur 429 et 5xx,
  envoi des médias en deux temps (Webflow puis dépôt S3).
- `src/schema.js` — traduit votre collection en schéma JSON, puis reconvertit la
  lecture en `fieldData` Webflow (nombres, listes déroulantes, cases à cocher).
- `src/extraction.js` — lecture de la fiche PDF.
- `src/photos.js` — préparation des images (sharp).
- `src/pipeline.js` — enchaînement complet.
- `web/` — le serveur local et l'écran de relecture.

Aucun jeton n'est versionné : `.env` et `config/config.json` sont ignorés par git.
