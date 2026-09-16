// Petit serveur local : interface glisser-deposer pour publier un bien.
// Rien n'est expose sur le reseau, tout tourne sur la machine du collaborateur.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { lireConfig, jetonWebflow, cleAnthropic, racine } from '../src/config.js';
import { chargerStructure, analyserDepot, envoyerVersWebflow } from '../src/pipeline.js';
import { estUnePhoto, trierNaturellement } from '../src/photos.js';

const ici = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const televersement = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 80 },
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ici, 'public')));

// Depots en cours, gardes en memoire le temps de la relecture.
const depots = new Map();
const DUREE_VIE_MS = 60 * 60 * 1000;

setInterval(() => {
  const limite = Date.now() - DUREE_VIE_MS;
  for (const [cle, depot] of depots) if (depot.cree < limite) depots.delete(cle);
}, 5 * 60 * 1000).unref();

function erreurLisible(erreur) {
  if (erreur?.code === 'LIMIT_FILE_SIZE') return 'Un fichier dépasse 40 Mo.';
  if (erreur?.code === 'LIMIT_FILE_COUNT') return 'Trop de fichiers (80 au maximum).';
  return erreur?.message ?? 'Erreur inattendue.';
}

app.get('/api/config', async (requete, reponse) => {
  const config = lireConfig();
  if (!config.collectionId) {
    return reponse.json({ configure: false });
  }
  const structure = await chargerStructure(config, jetonWebflow());
  reponse.json({
    configure: true,
    site: config.siteNom,
    collection: structure.nom,
    lectureAuto: Boolean(cleAnthropic()),
    publierParDefaut: config.publierParDefaut,
    champs: structure.champsExtraits.map((c) => ({
      slug: c.slug,
      libelle: c.displayName,
      type: c.type,
      obligatoire: Boolean(c.isRequired),
      aide: c.helpText ?? null,
      options: (c.validations?.options ?? []).map((o) => o.name),
    })),
    champsNonGeres: structure.champsNonGeres.map((c) => c.displayName),
  });
});

app.post('/api/analyse', televersement.array('fichiers'), async (requete, reponse) => {
  const config = lireConfig();
  const structure = await chargerStructure(config, jetonWebflow());

  const fichiers = requete.files ?? [];
  const pdfs = fichiers.filter((f) => f.originalname.toLowerCase().endsWith('.pdf'));
  if (pdfs.length > 1) {
    return reponse.status(400).json({
      erreur: `${pdfs.length} fiches PDF déposées (${pdfs.map((f) => f.originalname).join(', ')}). N'en déposez qu'une seule.`,
    });
  }

  const images = fichiers.filter((f) => estUnePhoto(f.originalname));
  const ordre = trierNaturellement(images.map((f) => f.originalname));
  const photos = ordre.map((nom) => {
    const fichier = images.find((f) => f.originalname === nom);
    return { nom, contenu: fichier.buffer };
  });

  const analyse = await analyserDepot(
    { pdf: pdfs[0]?.buffer ?? null, photos },
    structure,
    config
  );

  const identifiant = crypto.randomUUID();
  depots.set(identifiant, {
    cree: Date.now(),
    pdf: pdfs[0]?.buffer ?? null,
    photos: analyse.photos,
  });

  reponse.json({
    identifiant,
    fieldData: analyse.fieldData,
    remarques: analyse.remarques,
    avertissements: analyse.avertissements,
    nomPdf: pdfs[0]?.originalname ?? null,
    photos: analyse.photos.map((p, i) => ({
      index: i,
      nom: p.nomOrigine,
      apercu: p.apercu,
      poids: p.poids,
      largeur: p.largeur,
      hauteur: p.hauteur,
    })),
  });
});

app.post('/api/envoyer', async (requete, reponse) => {
  const { identifiant, fieldData, ordrePhotos, publier } = requete.body ?? {};
  const depot = depots.get(identifiant);
  if (!depot) {
    return reponse.status(410).json({
      erreur: 'Ce dépôt a expiré. Redéposez la fiche et les photos.',
    });
  }

  const config = lireConfig();
  const jeton = jetonWebflow();
  const structure = await chargerStructure(config, jeton);

  const photos = Array.isArray(ordrePhotos) && ordrePhotos.length
    ? ordrePhotos.map((i) => depot.photos[i]).filter(Boolean)
    : depot.photos;

  const journal = [];
  const resultat = await envoyerVersWebflow({
    structure,
    fieldData,
    photos,
    pdf: depot.pdf,
    config,
    jeton,
    publier: Boolean(publier),
    ecrire: (m) => journal.push(m),
  });

  depots.delete(identifiant);
  reponse.json({
    ok: true,
    journal,
    publie: Boolean(publier),
    nom: resultat.item?.fieldData?.name ?? fieldData?.name,
    slug: resultat.slug,
    itemId: resultat.item?.id,
    photos: resultat.medias.length,
  });
});

app.use((erreur, requete, reponse, suite) => {
  console.error(erreur);
  reponse.status(erreur?.statut && erreur.statut < 500 ? 400 : 500).json({
    erreur: erreurLisible(erreur),
  });
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, '127.0.0.1', () => {
  const config = lireConfig();
  console.log(`\n  Outil de publication Webflow — http://localhost:${port}`);
  console.log(
    config.collectionId
      ? `  Site « ${config.siteNom} », collection « ${config.collectionNom} »`
      : '  Aucune collection configurée : lancez « npm run setup ».'
  );
  if (!cleAnthropic()) {
    console.log('  Lecture automatique des fiches désactivée (ANTHROPIC_API_KEY absente).');
  }
  console.log(`  Dossier du projet : ${racine}\n`);
});
