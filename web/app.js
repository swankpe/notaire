// Application web. Aucune donnee n'est gardee entre deux requetes : le
// navigateur conserve la fiche et les photos, et les envoie au fil des etapes.
// C'est ce qui permet le meme code en local et sur Vercel.
//
// Les requetes restent petites (limite de 4,5 Mo par requete sur Vercel) :
// la fiche PDF part seule, puis les photos une par une.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import {
  lireConfig,
  jetonWebflow,
  jetonWebflowOptionnel,
  cleAnthropic,
  surVercel,
  configPourVercel,
} from '../src/config.js';
import {
  listerSites,
  listerCollections,
  lireCollection,
  listerItems,
  lireItem,
} from '../src/webflow.js';
import { lireStyle, redigerPublication, lienDuBien } from '../src/publication.js';
import { nommerLesPieces, photosDuBien, cartonDuBien, telechargerPhoto } from '../src/video.js';
import { espaceDeTravail } from '../src/claude.js';
import {
  analyserCollection,
  reglagesIncoherents,
  choisirChampImage,
  choisirChampGalerie,
  choisirChampPrix,
} from '../src/schema.js';
import {
  chargerStructure,
  lireLaFiche,
  reserverSlug,
  envoyerPhoto,
  envoyerFichePdf,
  creerAnnonce,
} from '../src/pipeline.js';
import { messageDePhotoIllisible } from '../src/photos.js';
import {
  protectionActive,
  verifierMotDePasse,
  creerSession,
  enteteCookie,
  exigerSession,
  tropDEssais,
  sessionValide,
  lireCookie,
} from '../src/auth.js';

const ici = path.dirname(fileURLToPath(import.meta.url));

export function creerApplication() {
  const app = express();

  // 4,5 Mo est la limite dure de Vercel ; on refuse un peu avant pour rendre
  // un message clair plutot qu'une erreur de plateforme.
  const LIMITE_REQUETE = 4 * 1024 * 1024;
  const televersement = multer({
    storage: multer.memoryStorage(),
    // Une fiche convertie en images arrive en plusieurs fichiers, un par page.
    limits: { fileSize: LIMITE_REQUETE, files: 40 },
  });

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(ici, 'public')));

  // ── Connexion ───────────────────────────────────────────────────────────

  app.get('/api/session', (requete, reponse) => {
    reponse.json({
      protege: protectionActive(),
      authentifie: !protectionActive() || sessionValide(lireCookie(requete.headers.cookie)),
    });
  });

  app.post('/api/connexion', async (requete, reponse) => {
    if (!protectionActive()) return reponse.json({ ok: true });
    if (tropDEssais()) {
      return reponse.status(429).json({
        erreur: "Trop d'essais infructueux. Réessayez dans un quart d'heure.",
      });
    }
    // Ralentissement systematique : une tentative par seconde au mieux.
    await new Promise((r) => setTimeout(r, 400));

    if (!verifierMotDePasse(requete.body?.motDePasse)) {
      return reponse.status(401).json({ erreur: 'Mot de passe incorrect.' });
    }
    reponse.setHeader('Set-Cookie', enteteCookie(creerSession()));
    reponse.json({ ok: true });
  });

  app.post('/api/deconnexion', (requete, reponse) => {
    reponse.setHeader('Set-Cookie', enteteCookie(''));
    reponse.json({ ok: true });
  });

  // Tout ce qui suit exige une session valide.
  app.use('/api', exigerSession);

  // ── Structure de la collection ──────────────────────────────────────────

  app.get('/api/config', async (requete, reponse) => {
    const config = lireConfig();
    if (!config.collectionId) {
      return reponse.json({
        configure: false,
        jetonPresent: Boolean(jetonWebflowOptionnel()),
        lectureAuto: Boolean(cleAnthropic()),
        espaceDeTravail: Boolean(espaceDeTravail()),
      });
    }

    const structure = await chargerStructure(config, jetonWebflow());
    reponse.json({
      configure: true,
      site: config.siteNom,
      collection: structure.nom,
      lectureAuto: Boolean(cleAnthropic()),
      // Presence seule, jamais la valeur : de quoi diagnostiquer une cle
      // d'organisation sans exposer quoi que ce soit.
      espaceDeTravail: Boolean(espaceDeTravail()),
      fichePdfActivee: Boolean(config.champFichePdf),
      photoLargeurMax: config.photoLargeurMax,
      photoQualite: config.photoQualite,
      champs: structure.champsExtraits.map((c) => ({
        slug: c.slug,
        libelle: c.displayName,
        type: c.type,
        obligatoire: Boolean(c.obligatoire),
        exigeParEtude: Boolean(c.exigeParEtude),
        aide: c.helpText ?? null,
        options: (c.validations?.options ?? []).map((o) => o.name),
      })),
      // Champs pointant vers une autre collection : l'ecran propose une liste
      // deroulante, chargee a part pour ne pas ralentir l'ouverture.
      champsReference: structure.champsReference.map((c) => ({
        slug: c.slug,
        libelle: c.displayName,
        type: c.type,
        obligatoire: Boolean(c.obligatoire),
        exigeParEtude: Boolean(c.exigeParEtude),
        collectionReferencee: c.validations?.collectionId ?? null,
      })),
      champsNonGeres: structure.champsNonGeres.map((c) => c.displayName),
      // Un reglage qui ne correspond a rien dans la collection se sait au
      // chargement, pas une fois l'annonce creee : d'ici la, l'utilisateur a
      // rempli le formulaire en croyant etre protege.
      reglages: reglagesIncoherents(structure, config),
      // Le logo de l'etude, incruste dans les videos. Sa presence se dit ici :
      // le navigateur ne va pas le chercher pour rien et la console reste nette.
      logo: fs.existsSync(path.join(ici, 'public', 'logo.png')),
    });
  });

  app.get('/api/references', async (requete, reponse) => {
    const { collectionId } = requete.query;
    if (!collectionId) return reponse.status(400).json({ erreur: 'Collection manquante.' });
    const items = await listerItems(collectionId, jetonWebflow());
    reponse.json({ items: items.map((i) => ({ id: i.id, nom: i.nom })) });
  });

  // ── Configuration initiale (tant qu'aucune collection n'est choisie) ────
  //
  // Sur Vercel le disque est en lecture seule : ces routes ne peuvent rien
  // enregistrer. Elles servent a choisir le site et la collection, puis a
  // afficher les variables d'environnement a recopier dans Vercel.

  app.get('/api/sites', async (requete, reponse) => {
    const sites = await listerSites(jetonWebflow());
    reponse.json({
      sites: sites.map((s) => ({ id: s.id, nom: s.displayName, raccourci: s.shortName ?? null })),
    });
  });

  app.get('/api/collections', async (requete, reponse) => {
    const { siteId } = requete.query;
    if (!siteId) return reponse.status(400).json({ erreur: 'Site manquant.' });
    const collections = await listerCollections(siteId, jetonWebflow());
    reponse.json({
      collections: collections.map((c) => ({ id: c.id, nom: c.displayName, slug: c.slug })),
    });
  });

  app.get('/api/reglages', async (requete, reponse) => {
    const { siteId, siteNom, collectionId } = requete.query;
    if (!siteId || !collectionId) {
      return reponse.status(400).json({ erreur: 'Site ou collection manquant.' });
    }

    const structure = analyserCollection(await lireCollection(collectionId, jetonWebflow()));
    const champImage = choisirChampImage(structure, null);
    const champGalerie = choisirChampGalerie(structure, null);

    reponse.json({
      collection: structure.nom,
      champImage: champImage ? { slug: champImage.slug, libelle: champImage.displayName } : null,
      champGalerie: champGalerie ? { slug: champGalerie.slug, libelle: champGalerie.displayName } : null,
      champsFichier: structure.champsFichier.map((c) => ({ slug: c.slug, libelle: c.displayName })),
      champsReference: structure.champsReference.map((c) => c.displayName),
      champsNonGeres: structure.champsNonGeres.map((c) => c.displayName),
      nombreChamps: structure.champsExtraits.length,
      variables: configPourVercel({
        siteId,
        siteNom: siteNom || null,
        collectionId,
        collectionNom: structure.nom,
        champImagePrincipale: champImage?.slug ?? null,
        champGalerie: champGalerie?.slug ?? null,
        champFichePdf: null,
        consignes: '',
        modele: null,
      }),
    });
  });

  // ── Etape 1 : lecture de la fiche ───────────────────────────────────────

  app.post(
    '/api/analyse',
    televersement.fields([
      { name: 'fiche', maxCount: 1 },
      { name: 'pages', maxCount: 40 },
    ]),
    async (requete, reponse) => {
      const config = lireConfig();
      const structure = await chargerStructure(config, jetonWebflow());

      // Le navigateur envoie le PDF tel quel s'il tient dans une requete,
      // sinon ses pages converties en images.
      const lecture = await lireLaFiche(
        {
          pdf: requete.files?.fiche?.[0]?.buffer ?? null,
          images: (requete.files?.pages ?? []).map((f) => f.buffer),
        },
        structure,
        config
      );
      reponse.json(lecture);
    }
  );

  // ── Etape 2 : slug definitif ────────────────────────────────────────────

  app.post('/api/slug', async (requete, reponse) => {
    const config = lireConfig();
    const { fieldData } = requete.body ?? {};
    if (!fieldData?.name) {
      return reponse.status(400).json({ erreur: "Le titre de l'annonce est obligatoire." });
    }
    reponse.json(await reserverSlug(fieldData, config, jetonWebflow()));
  });

  // ── Etape 3 : un media par requete ──────────────────────────────────────

  app.post('/api/media', televersement.single('fichier'), async (requete, reponse) => {
    const config = lireConfig();
    const jeton = jetonWebflow();
    const { slug, index, type } = requete.body ?? {};

    if (!requete.file) return reponse.status(400).json({ erreur: 'Aucun fichier reçu.' });
    if (!slug) return reponse.status(400).json({ erreur: 'Slug manquant.' });

    if (type === 'pdf') {
      if (!config.champFichePdf) {
        return reponse.status(400).json({ erreur: "Aucun champ « Fichier » n'est configuré." });
      }
      return reponse.json(
        await envoyerFichePdf({ pdf: requete.file.buffer, slug, config, jeton })
      );
    }

    try {
      const media = await envoyerPhoto({
        contenu: requete.file.buffer,
        slug,
        index: Number(index) || 0,
        config,
        jeton,
      });
      reponse.json(media);
    } catch (erreur) {
      if (erreur.name === 'ErreurWebflow') throw erreur;
      // Fichier illisible : on le signale sans faire echouer tout l'envoi.
      reponse
        .status(422)
        .json({ erreur: messageDePhotoIllisible(requete.file.originalname, erreur) });
    }
  });

  // ── Etape 4 : creation de l'annonce ─────────────────────────────────────

  app.post('/api/creer', async (requete, reponse) => {
    const config = lireConfig();
    const jeton = jetonWebflow();
    const structure = await chargerStructure(config, jeton);
    const { fieldData, slug, medias, mediaPdf, publier } = requete.body ?? {};

    if (!fieldData?.name || !slug) {
      return reponse.status(400).json({ erreur: 'Titre ou slug manquant.' });
    }

    const resultat = await creerAnnonce({
      structure,
      fieldData,
      slug,
      medias: Array.isArray(medias) ? medias : [],
      mediaPdf: mediaPdf ?? null,
      config,
      jeton,
      publier: Boolean(publier),
    });

    reponse.json({
      ok: true,
      publie: Boolean(publier),
      nom: resultat.item?.fieldData?.name ?? fieldData.name,
      slug: resultat.slug,
      itemId: resultat.item?.id,
      photos: Array.isArray(medias) ? medias.length : 0,
      avertissements: resultat.avertissements ?? [],
    });
  });

  // ── Publication Facebook ────────────────────────────────────────────────

  app.get('/api/biens', async (requete, reponse) => {
    const config = lireConfig();
    const jeton = jetonWebflow();
    const structure = await chargerStructure(config, jeton);
    const champPrix = choisirChampPrix(structure, config.champPrix);

    const items = await listerItems(config.collectionId, jeton, {
      tri: 'recent',
      avecDonnees: true,
    });

    reponse.json({
      collection: config.collectionNom,
      champPrix: champPrix ? champPrix.displayName : null,
      biens: items.map((b) => ({
        id: b.id,
        nom: b.nom,
        brouillon: b.brouillon,
        prix: champPrix ? (b.donnees?.[champPrix.slug] ?? null) : null,
        // Valeur de chaque champ de reference, pour filtrer la liste a l'ecran
        // (par ville, par office...) sans rappeler Webflow.
        references: Object.fromEntries(
          structure.champsReference.map((c) => [c.slug, b.donnees?.[c.slug] ?? null])
        ),
      })),
    });
  });

  app.post('/api/publication', async (requete, reponse) => {
    const config = lireConfig();
    const jeton = jetonWebflow();
    const { itemId } = requete.body ?? {};
    if (!itemId) return reponse.status(400).json({ erreur: 'Aucun bien choisi.' });

    const structure = await chargerStructure(config, jeton);
    const item = await lireItem(config.collectionId, itemId, jeton);
    const style = lireStyle();

    const publication = await redigerPublication({
      structure,
      item,
      style,
      modele: config.modele,
    });

    reponse.json({
      ...publication,
      bien: item?.fieldData?.name ?? null,
      lien: lienDuBien(style, item),
    });
  });

  // ── Video diaporama ─────────────────────────────────────────────────────
  //
  // Les photos sont celles deja publiees sur le site : le navigateur n'envoie
  // rien, il demande. La video, elle, se fabrique dans le navigateur — un
  // fichier video ne passerait pas la limite de 4,5 Mo par requete.

  /**
   * Le bien et ses photos, relus dans Webflow a chaque appel — aucun etat
   * n'est garde entre deux requetes.
   *
   * Le carton n'est pas calcule ici : il demande une lecture de plus par champ
   * de reference, et la route qui sert les photos n'en a pas besoin. Une photo
   * demandee dix fois ferait dix lectures inutiles, chacune cadencee.
   */
  async function contexteDuBien(itemId) {
    const config = lireConfig();
    const jeton = jetonWebflow();
    const structure = await chargerStructure(config, jeton);
    const item = await lireItem(config.collectionId, itemId, jeton);
    return { config, jeton, structure, item, photos: photosDuBien(structure, item, config) };
  }

  app.post('/api/pieces', async (requete, reponse) => {
    const { itemId } = requete.body ?? {};
    if (!itemId) return reponse.status(400).json({ erreur: 'Aucun bien choisi.' });

    const { photos, config, jeton, structure, item } = await contexteDuBien(itemId);
    if (!photos.length) {
      return reponse.status(400).json({
        erreur: "Ce bien n'a aucune photo sur le site. Publiez-les d'abord dans le CMS.",
      });
    }

    // Reduites au minimum utile : reconnaitre une cuisine ne demande pas
    // 2400 px, et c'est autant de moins a transmettre a Claude.
    const images = [];
    for (const photo of photos) {
      const prete = await telechargerPhoto(photo.url, { largeurMax: 512, qualite: 60 });
      images.push(prete.contenu);
    }

    const resultat = await nommerLesPieces(images, {
      modele: config.modele,
      consignes: config.consignes,
    });

    // La ville, l'office... sont des elements d'autres collections : la fiche
    // n'en garde que l'identifiant, le carton veut le libelle.
    const carton = await cartonDuBien(structure, item, config, async (collectionId, id) => {
      if (!collectionId || typeof id !== 'string') return null;
      const items = await listerItems(collectionId, jeton);
      return items.find((i) => i.id === id)?.nom ?? null;
    });
    reponse.json({ ...resultat, photos: photos.map((p) => p.nom), carton });
  });

  /**
   * Une photo du bien, a la taille demandee. L'index designe une photo de
   * l'element : aucune adresse ne vient du navigateur, sans quoi la route
   * servirait de relais vers n'importe quel serveur.
   */
  app.get('/api/bien-photo', async (requete, reponse) => {
    const { itemId, index, largeur } = requete.query;
    if (!itemId) return reponse.status(400).json({ erreur: 'Aucun bien choisi.' });

    const rang = Number(index);
    const { photos } = await contexteDuBien(itemId);
    if (!Number.isInteger(rang) || rang < 0 || rang >= photos.length) {
      return reponse.status(404).json({ erreur: 'Photo introuvable.' });
    }

    const largeurMax = Math.min(2000, Math.max(200, Number(largeur) || 1600));
    const prete = await telechargerPhoto(photos[rang].url, { largeurMax, qualite: 88 });
    reponse
      .type(prete.typeMime)
      // Une photo publiee ne change pas : inutile de la reprendre a chaque
      // rendu, et le montage d'une vidéo en redemande plusieurs fois.
      .set('Cache-Control', 'private, max-age=3600')
      .send(prete.contenu);
  });

  app.use((erreur, requete, reponse, suite) => {
    console.error(erreur);
    if (erreur?.code === 'LIMIT_FILE_SIZE') {
      return reponse.status(413).json({
        erreur: surVercel
          ? 'Fichier trop lourd : Vercel limite chaque envoi à 4,5 Mo. Allégez la fiche PDF.'
          : 'Fichier trop lourd (plus de 4 Mo).',
      });
    }
    reponse.status(erreur?.statut && erreur.statut < 500 ? 400 : 500).json({
      erreur: erreur?.message ?? 'Erreur inattendue.',
    });
  });

  return app;
}
