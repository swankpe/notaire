// Preparation des photos avant envoi dans la bibliotheque Webflow :
// tri naturel, redressement, redimensionnement, conversion JPEG et surtout
// suppression des metadonnees EXIF (les photos de biens contiennent souvent
// les coordonnees GPS du logement).
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
 * @param {{nom: string, contenu: Buffer}[]} fichiers
 * @param {{slug: string, largeurMax?: number, qualite?: number}} options
 */
export async function preparerPhotos(fichiers, { slug, largeurMax = 2400, qualite = 82 } = {}) {
  const photos = [];
  const avertissements = [];

  let index = 0;
  for (const fichier of fichiers) {
    index += 1;
    try {
      const image = sharp(fichier.contenu, { failOn: 'error' }).rotate();
      const infos = await image.metadata();

      const contenu = await image
        .resize({ width: largeurMax, withoutEnlargement: true })
        .jpeg({ quality: qualite, mozjpeg: true })
        .toBuffer();

      const apercu = await sharp(contenu)
        .resize({ width: 360, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();

      photos.push({
        nomOrigine: fichier.nom,
        nom: `${slug}-${String(index).padStart(2, '0')}.jpg`,
        contenu,
        typeMime: 'image/jpeg',
        largeur: infos.width ?? null,
        hauteur: infos.height ?? null,
        poids: contenu.length,
        apercu: `data:image/jpeg;base64,${apercu.toString('base64')}`,
      });
    } catch (erreur) {
      index -= 1;
      const indice = /heif|heic/i.test(erreur.message)
        ? ' Les photos iPhone au format HEIC ne sont pas lisibles : exportez-les en JPEG.'
        : '';
      avertissements.push(`Photo « ${fichier.nom} » ignorée : ${erreur.message}.${indice}`);
    }
  }

  return { photos, avertissements };
}
