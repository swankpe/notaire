// Copie la version navigateur de pdf.js dans web/public/vendor/.
//
// Le navigateur en a besoin pour convertir une fiche PDF trop lourde en images
// avant de l'envoyer. On ne commite pas ces fichiers : ils sont recopies a
// l'installation, y compris lors du build Vercel.
//
// C'est la version « legacy » qui est copiee : le build courant de pdf.js
// emploie des methodes trop recentes (Map.getOrInsertComputed) et echoue sur
// les navigateurs qui ne sont pas de derniere generation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(racine, 'web', 'public', 'vendor');
const source = path.join(racine, 'node_modules', 'pdfjs-dist', 'legacy', 'build');

const fichiers = ['pdf.min.mjs', 'pdf.worker.min.mjs'];

try {
  fs.mkdirSync(destination, { recursive: true });
  for (const nom of fichiers) {
    fs.copyFileSync(path.join(source, nom), path.join(destination, nom));
  }
  console.log(`pdf.js recopie dans web/public/vendor/ (${fichiers.length} fichiers)`);
} catch (erreur) {
  // Un echec ici ne doit pas casser l'installation : seule la conversion des
  // fiches trop lourdes en patira, et l'ecran le dira clairement.
  console.warn('pdf.js n\'a pas pu etre recopie :', erreur.message);
}
