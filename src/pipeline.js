// Enchainement : fiche PDF + photos -> element du CMS Webflow.
//
// Chaque etape est independante et ne garde aucun etat entre deux appels :
// c'est ce qui permet a l'outil de tourner aussi bien en local que sur une
// plateforme sans etat comme Vercel, ou deux requetes successives ne tombent
// pas forcement sur la meme instance.
import {
  lireCollection,
  creerItem,
  publierItems,
  televerserMedia,
  chercherItemParSlug,
  ErreurWebflow,
} from './webflow.js';
import {
  analyserCollection,
  choisirChampImage,
  choisirChampGalerie,
  versFieldData,
  variantePourOptions,
  fabriquerSlug,
  reglagesIncoherents,
} from './schema.js';
import { lireFiche, extractionDisponible } from './extraction.js';
import { preparerPhoto, preparerPhotos, messageDePhotoIllisible } from './photos.js';

export async function chargerStructure(config, jeton) {
  if (!config.collectionId) {
    throw new Error("Aucune collection configurée. Lancez d'abord : npm run setup");
  }
  const collection = await lireCollection(config.collectionId, jeton);
  return analyserCollection(collection);
}

// ── Etape 1 : lire la fiche (rien n'est envoye a Webflow) ─────────────────

export async function lireLaFiche(pdf, structure, config) {
  const remarques = [];
  const avertissements = [];
  let extrait = {};

  if (!pdf) {
    avertissements.push('Aucune fiche PDF fournie : les champs sont à saisir à la main.');
  } else if (!extractionDisponible()) {
    avertissements.push(
      'Lecture automatique désactivée (ANTHROPIC_API_KEY absente) : les champs sont à saisir à la main.'
    );
  } else {
    const lecture = await lireFiche(pdf, structure, {
      consignes: config.consignes,
      modele: config.modele,
    });
    extrait = lecture.extrait;
    remarques.push(...lecture.remarques);
  }

  const conversion = versFieldData(structure, extrait);
  avertissements.push(...conversion.avertissements);
  const fieldData = conversion.fieldData;

  if (!fieldData.name) {
    fieldData.name = 'Nouveau bien';
    if (pdf) {
      avertissements.push("Le titre de l'annonce n'a pas été trouvé dans la fiche : à compléter.");
    }
  }

  return { fieldData, remarques, avertissements };
}

// ── Etape 2 : arreter le slug definitif ───────────────────────────────────

/**
 * Le slug est fige avant l'envoi des photos : il sert a les nommer, et le
 * titre a pu etre corrige pendant la relecture.
 */
export async function reserverSlug(fieldData, config, jeton) {
  let slug = fabriquerSlug(fieldData.slug || fieldData.name);
  const existant = await chercherItemParSlug(config.collectionId, slug, jeton);
  if (!existant) return { slug, renomme: false };

  slug = `${slug}-${new Date().getFullYear()}`;
  return { slug, renomme: true };
}

// ── Etape 3 : televerser un media a la fois ───────────────────────────────

/**
 * Prepare puis televerse une photo. Le nom du fichier est construit ici, a
 * partir du slug definitif et du rang final choisi a l'ecran.
 */
export async function envoyerPhoto({ contenu, slug, index, config, jeton }) {
  const photo = await preparerPhoto(contenu, {
    largeurMax: config.photoLargeurMax,
    qualite: config.photoQualite,
  });
  return televerserMedia({
    siteId: config.siteId,
    nomFichier: `${slug}-${String(index + 1).padStart(2, '0')}.jpg`,
    contenu: photo.contenu,
    typeMime: photo.typeMime,
    jeton,
  });
}

export async function envoyerFichePdf({ pdf, slug, config, jeton }) {
  return televerserMedia({
    siteId: config.siteId,
    nomFichier: `${slug}.pdf`,
    contenu: pdf,
    typeMime: 'application/pdf',
    jeton,
  });
}

// ── Etape 4 : creer l'element ─────────────────────────────────────────────

/**
 * @param {object} params
 * @param {{fileId: string, url: string}[]} params.medias  photos, dans l'ordre final
 * @param {{fileId: string, url: string}|null} params.mediaPdf
 */
export async function creerAnnonce({
  structure,
  fieldData,
  slug,
  medias = [],
  mediaPdf = null,
  config,
  jeton,
  publier = false,
}) {
  const donnees = { ...fieldData, slug };
  const avertissements = reglagesIncoherents(structure, config);

  const champImage = choisirChampImage(structure, config.champImagePrincipale);
  const champGalerie = choisirChampGalerie(structure, config.champGalerie);

  if (champImage && medias[0]) {
    donnees[champImage.slug] = { fileId: medias[0].fileId, url: medias[0].url };
  } else if (medias.length && !champImage) {
    avertissements.push(
      "Aucun champ Image dans cette collection : les photos ont été téléversées "
      + "mais aucune n'a été désignée comme visuel principal."
    );
  }
  if (champGalerie && medias.length) {
    // La premiere photo sert de visuel principal ; on la garde aussi dans la
    // galerie pour que le diaporama du site reste complet.
    donnees[champGalerie.slug] = medias.map((m) => ({ fileId: m.fileId, url: m.url }));
  }

  const champPdf = config.champFichePdf
    ? structure.champsFichier.find((c) => c.slug === config.champFichePdf)
    : null;
  if (champPdf && mediaPdf) {
    donnees[champPdf.slug] = { fileId: mediaPdf.fileId, url: mediaPdf.url };
  }

  let item;
  try {
    item = await creerItem(config.collectionId, donnees, { brouillon: !publier, jeton });
  } catch (erreur) {
    // Certaines collections attendent l'identifiant d'une option la ou d'autres
    // attendent son libelle : on retente une fois avec l'autre forme.
    const variante =
      erreur instanceof ErreurWebflow && erreur.statut === 400
        ? variantePourOptions(structure, donnees)
        : null;
    if (!variante) throw erreur;
    item = await creerItem(config.collectionId, variante, { brouillon: !publier, jeton });
  }

  let publication = null;
  if (publier) {
    publication = await publierItems(config.collectionId, [item.id], jeton);
  }

  return { item, publication, slug, avertissements };
}

// ── Enchainement complet, pour la ligne de commande ───────────────────────

/**
 * Chaine les quatre etapes d'un coup. L'interface web, elle, les appelle une
 * par une pour intercaler la relecture et respecter la limite de taille des
 * requetes sur Vercel.
 */
export async function publierBien({
  pdf,
  photos = [],
  fieldData,
  structure,
  config,
  jeton,
  publier = false,
  ecrire = () => {},
}) {
  const { slug, renomme } = await reserverSlug(fieldData, config, jeton);
  if (renomme) {
    ecrire(`Un bien porte déjà ce slug : l'annonce sera créée sous « ${slug} ».`);
  }

  const medias = [];
  const avertissements = [];
  for (const [i, fichier] of photos.entries()) {
    ecrire(`Envoi de la photo ${i + 1}/${photos.length} (${fichier.nom})…`);
    try {
      medias.push(
        await envoyerPhoto({ contenu: fichier.contenu, slug, index: medias.length, config, jeton })
      );
    } catch (erreur) {
      avertissements.push(messageDePhotoIllisible(fichier.nom, erreur));
    }
  }

  let mediaPdf = null;
  if (pdf && config.champFichePdf) {
    ecrire('Envoi de la fiche PDF…');
    mediaPdf = await envoyerFichePdf({ pdf, slug, config, jeton });
  }

  ecrire(publier ? "Création de l'annonce…" : "Création de l'annonce en brouillon…");
  const resultat = await creerAnnonce({
    structure,
    fieldData,
    slug,
    medias,
    mediaPdf,
    config,
    jeton,
    publier,
  });

  if (publier) ecrire("Publication de l'annonce…");
  return { ...resultat, medias, avertissements: [...avertissements, ...resultat.avertissements] };
}

export { preparerPhotos };
