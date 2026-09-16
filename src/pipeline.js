// Enchainement complet : fiche PDF + photos -> element du CMS Webflow.
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
} from './schema.js';
import { lireFiche, texteDuPdf, extractionDisponible } from './extraction.js';
import { preparerPhotos } from './photos.js';

export async function chargerStructure(config, jeton) {
  if (!config.collectionId) {
    throw new Error("Aucune collection configurée. Lancez d'abord : npm run setup");
  }
  const collection = await lireCollection(config.collectionId, jeton);
  return analyserCollection(collection);
}

/**
 * Etape 1 : lire la fiche et preparer les photos, sans rien envoyer a Webflow.
 * @param {{pdf: Buffer|null, photos: {nom: string, contenu: Buffer}[]}} depot
 */
export async function analyserDepot(depot, structure, config) {
  const remarques = [];
  const avertissements = [];
  let extrait = {};
  let usage = null;

  if (depot.pdf) {
    if (extractionDisponible()) {
      const lecture = await lireFiche(depot.pdf, structure, {
        consignes: config.consignes,
        modele: config.modele,
      });
      extrait = lecture.extrait;
      remarques.push(...lecture.remarques);
      usage = lecture.usage;
    } else {
      avertissements.push(
        'Lecture automatique désactivée (ANTHROPIC_API_KEY absente) : les champs sont à saisir à la main.'
      );
    }
  } else {
    avertissements.push('Aucune fiche PDF fournie : les champs sont à saisir à la main.');
  }

  const conversion = versFieldData(structure, extrait);
  avertissements.push(...conversion.avertissements);
  const fieldData = conversion.fieldData;

  if (!fieldData.name) {
    fieldData.name = extrait?.name || 'Nouveau bien';
    if (depot.pdf) {
      avertissements.push("Le titre de l'annonce n'a pas été trouvé dans la fiche : à compléter.");
    }
  }
  fieldData.slug = fabriquerSlug(fieldData.name);

  const { photos, avertissements: soucisPhotos } = await preparerPhotos(depot.photos ?? [], {
    slug: fieldData.slug,
    largeurMax: config.photoLargeurMax,
    qualite: config.photoQualite,
  });
  avertissements.push(...soucisPhotos);
  if (photos.length === 0) avertissements.push('Aucune photo exploitable dans le dépôt.');

  return { fieldData, photos, remarques, avertissements, usage };
}

/**
 * Etape 2 : televerser les medias puis creer l'element.
 * @param {{structure, fieldData, photos, pdf, config, jeton, publier, ecrire}} params
 */
export async function envoyerVersWebflow({
  structure,
  fieldData,
  photos = [],
  pdf = null,
  config,
  jeton,
  publier = false,
  ecrire = () => {},
}) {
  const donnees = { ...fieldData };
  donnees.slug = fabriquerSlug(donnees.slug || donnees.name);

  const existant = await chercherItemParSlug(config.collectionId, donnees.slug, jeton);
  if (existant) {
    donnees.slug = `${donnees.slug}-${new Date().getFullYear()}`;
    ecrire(`Un bien porte déjà ce slug : l'annonce sera créée sous « ${donnees.slug} ».`);
  }

  // Photos -> bibliotheque de medias du site. Les fichiers sont nommes ici, et
  // non a l'analyse : le titre a pu etre corrige et les photos reordonnees
  // pendant la relecture. La bibliotheque Webflow reste ainsi lisible.
  const medias = [];
  for (const [i, photo] of photos.entries()) {
    const nomFichier = `${donnees.slug}-${String(i + 1).padStart(2, '0')}.jpg`;
    ecrire(`Envoi de la photo ${i + 1}/${photos.length} (${photo.nomOrigine ?? photo.nom})…`);
    medias.push(
      await televerserMedia({
        siteId: config.siteId,
        nomFichier,
        contenu: photo.contenu,
        typeMime: photo.typeMime,
        jeton,
      })
    );
  }

  const champImage = choisirChampImage(structure, config.champImagePrincipale);
  const champGalerie = choisirChampGalerie(structure, config.champGalerie);

  if (champImage && medias[0]) {
    donnees[champImage.slug] = { fileId: medias[0].fileId, url: medias[0].url };
  }
  if (champGalerie && medias.length) {
    // La premiere photo sert de visuel principal ; on la garde aussi dans la
    // galerie pour que le diaporama du site reste complet.
    donnees[champGalerie.slug] = medias.map((m) => ({ fileId: m.fileId, url: m.url }));
  }

  // Fiche PDF telechargeable, si un champ « Fichier » est prevu pour cela.
  const champPdf = config.champFichePdf
    ? structure.champsFichier.find((c) => c.slug === config.champFichePdf)
    : null;
  if (champPdf && pdf) {
    ecrire('Envoi de la fiche PDF…');
    const media = await televerserMedia({
      siteId: config.siteId,
      nomFichier: `${donnees.slug}.pdf`,
      contenu: pdf,
      typeMime: 'application/pdf',
      jeton,
    });
    donnees[champPdf.slug] = { fileId: media.fileId, url: media.url };
  }

  ecrire(publier ? "Création de l'annonce…" : "Création de l'annonce en brouillon…");
  let item;
  try {
    item = await creerItem(config.collectionId, donnees, { brouillon: !publier, jeton });
  } catch (erreur) {
    // Certaines collections attendent l'identifiant d'une option la ou d'autres
    // attendent son libelle : on retente une fois avec l'autre forme.
    const variante = erreur instanceof ErreurWebflow && erreur.statut === 400
      ? variantePourOptions(structure, donnees)
      : null;
    if (!variante) throw erreur;
    ecrire('Nouvel essai avec les identifiants des listes déroulantes…');
    item = await creerItem(config.collectionId, variante, { brouillon: !publier, jeton });
  }

  let publication = null;
  if (publier) {
    ecrire("Publication de l'annonce…");
    publication = await publierItems(config.collectionId, [item.id], jeton);
  }

  return { item, publication, medias, slug: donnees.slug };
}

export { texteDuPdf };
