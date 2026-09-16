# Notes pour Claude Code

Outil interne d'une étude notariale : publie une annonce immobilière dans une
collection Webflow CMS à partir d'une fiche PDF et d'un dossier de photos.

## Repères

- Node 20+, ESM, JavaScript simple (pas de TypeScript, pas d'étape de build) :
  l'utilisateur est gestionnaire de site Webflow, pas développeur.
- **Le français visible à l'écran est accentué** (messages d'erreur,
  avertissements, interface). Les commentaires du code restent sobres.
- Le mode par défaut est le **brouillon** (`isDraft: true`). Toute publication
  directe demande une confirmation explicite. Ne pas changer ce réglage.
- Rien n'est deviné : un champ absent de la fiche reste vide et l'utilisateur
  est prévenu. Sur une annonce notariale, une valeur inventée est une faute.

## Architecture

| Fichier | Rôle |
| --- | --- |
| `src/webflow.js` | API Webflow v2 : cadence, reprises, médias en deux temps (métadonnées Webflow puis dépôt S3, champ `file` en dernier) |
| `src/schema.js` | collection Webflow → schéma JSON → `fieldData` |
| `src/extraction.js` | lecture de la fiche PDF via l'API Claude (document base64) |
| `src/photos.js` | sharp : redressement, redimensionnement, JPEG, EXIF supprimés |
| `src/pipeline.js` | `analyserDepot` (rien n'est envoyé) puis `envoyerVersWebflow` |
| `src/cli.js` | `setup`, `champs`, `import` |
| `web/` | serveur local + écran de relecture |

L'outil est **piloté par le schéma** : il lit la structure réelle de la
collection à chaque exécution et s'y adapte. Ne pas coder en dur des noms de
champs propres à une étude.

## Tests

```bash
npm test
```

`test/faux-webflow.js` rejoue l'API Webflow ; aucun test n'appelle le vrai
Webflow ni l'API Claude. Toute modification de `src/webflow.js` ou de
`src/schema.js` doit rester couverte.

## Pièges rencontrés

- `pdfjs-dist` v6 : `destroy()` est sur la tâche de chargement, pas sur le document.
- Dépôt S3 : les champs de signature doivent précéder le binaire, `file` en dernier.
- Conversion des nombres : « nous consulter » ne doit jamais devenir `0`
  (`Number('')` vaut `0` — voir `nombreDepuisTexte`).
- Les photos sont renommées au moment de **l'envoi**, pas de l'analyse : le
  titre a pu être corrigé et les photos réordonnées pendant la relecture.
