// Preparation des photos avant envoi dans la bibliotheque Webflow :
// tri naturel, redressement, redimensionnement, conversion JPEG et surtout
// suppression des metadonnees EXIF (les photos de biens contiennent souvent
// les coordonnees GPS du logement).
//
// Le navigateur redimensionne deja les photos avant de les envoyer, mais on
// refait le travail ici : la garantie « aucune donnee EXIF » doit tenir cote
// serveur, pas dependre du navigateur du poste.
import path from 'node:path';
import sharp from 'sharp';

const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.gif']);

export function estUnePhoto(nomFichier) {
  return EXTENSIONS.has(path.extname(nomFichier).toLowerCase());
}

/** Tri « photo2 » avant « photo10 », comme dans l'explorateur de fichiers. */
export function trierNaturellement(noms) {
  const collateur = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
  return [...noms].sort(collateur.compare);
}

/**
 * Prepare une photo. Leve une erreur si le fichier n'est pas une image lisible.
 * @param {Buffer} contenu
 * @param {{largeurMax?: number, qualite?: number}} options
 */
export async function preparerPhoto(contenu, { largeurMax = 2400, qualite = 82 } = {}) {
  const image = sharp(contenu, { failOn: 'error' }).rotate();
  const infos = await image.metadata();

  // sharp ne recopie les metadonnees que si on le lui demande : par defaut,
  // EXIF, IPTC et XMP (donc la position GPS) disparaissent.
  const prepare = await image
    .resize({ width: largeurMax, withoutEnlargement: true })
    .jpeg({ quality: qualite, mozjpeg: true })
    .toBuffer();

  return {
    contenu: prepare,
    typeMime: 'image/jpeg',
    largeur: infos.width ?? null,
    hauteur: infos.height ?? null,
    poids: prepare.length,
  };
}

function indiceLisible(erreur) {
  return /heif|heic/i.test(erreur.message)
    ? ' Les photos iPhone au format HEIC ne sont pas lisibles : exportez-les en JPEG.'
    : '';
}

export function messageDePhotoIllisible(nom, erreur) {
  return `Photo « ${nom} » ignorée : ${erreur.message}.${indiceLisible(erreur)}`;
}

/**
 * Version par lot, utilisee en ligne de commande. Une photo illisible est
 * signalee sans interrompre le lot.
 * @param {{nom: string, contenu: Buffer}[]} fichiers
 */
export async function preparerPhotos(fichiers, { largeurMax = 2400, qualite = 82 } = {}) {
  const photos = [];
  const avertissements = [];

  for (const fichier of fichiers) {
    try {
      const prepare = await preparerPhoto(fichier.contenu, { largeurMax, qualite });
      photos.push({ nomOrigine: fichier.nom, ...prepare });
    } catch (erreur) {
      avertissements.push(messageDePhotoIllisible(fichier.nom, erreur));
    }
  }

  return { photos, avertissements };
}
