#!/usr/bin/env node
// Interface en ligne de commande.
//   npm run setup                      configuration initiale (site + collection)
//   npm run champs                     liste les champs de la collection
//   npm run import -- ./biens/xxx      publie un dossier (fiche PDF + photos)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { lireConfig, ecrireConfig, jetonWebflow, cleAnthropic } from './config.js';
import { listerSites, listerCollections } from './webflow.js';
import { chargerStructure, analyserDepot, envoyerVersWebflow } from './pipeline.js';
import { choisirChampImage, choisirChampGalerie } from './schema.js';
import { estUnePhoto, trierNaturellement } from './photos.js';

const ESC = String.fromCharCode(27);
const couleur = (code) => (texte) => `${ESC}[${code}m${texte}${ESC}[0m`;
const GRAS = couleur(1);
const GRIS = couleur(90);
const VERT = couleur(32);
const ROUGE = couleur(31);
const JAUNE = couleur(33);

async function demander(question, valeurParDefaut) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const reponse = (await rl.question(question)).trim();
    return reponse || valeurParDefaut || '';
  } finally {
    rl.close();
  }
}

// ── setup ─────────────────────────────────────────────────────────────────

async function commandeSetup() {
  const jeton = jetonWebflow();
  const config = lireConfig();

  console.log(GRAS("\nConfiguration de l'outil de publication\n"));

  const sites = await listerSites(jeton);
  if (!sites.length) throw new Error('Ce jeton ne donne accès à aucun site Webflow.');

  sites.forEach((s, i) => console.log(`  ${i + 1}. ${s.displayName} ${GRIS(s.shortName ?? '')}`));
  const choixSite =
    sites.length === 1
      ? sites[0]
      : sites[Number(await demander(`\nQuel site ? [1-${sites.length}] `, '1')) - 1];
  if (!choixSite) throw new Error('Choix de site invalide.');
  config.siteId = choixSite.id;
  config.siteNom = choixSite.displayName;
  console.log(VERT(`Site : ${choixSite.displayName}`));

  const collections = await listerCollections(config.siteId, jeton);
  if (!collections.length) throw new Error('Ce site ne contient aucune collection CMS.');

  console.log(GRAS('\nCollections du site :'));
  collections.forEach((c, i) => console.log(`  ${i + 1}. ${c.displayName} ${GRIS('/' + c.slug)}`));
  const indice =
    Number(
      await demander(
        `\nQuelle collection contient les biens à vendre ? [1-${collections.length}] `,
        '1'
      )
    ) - 1;
  const choixCollection = collections[indice];
  if (!choixCollection) throw new Error('Choix de collection invalide.');
  config.collectionId = choixCollection.id;
  config.collectionNom = choixCollection.displayName;
  console.log(VERT(`Collection : ${choixCollection.displayName}`));

  const structure = await chargerStructure(config, jeton);
  const champImage = choisirChampImage(structure, null);
  const champGalerie = choisirChampGalerie(structure, null);
  config.champImagePrincipale = champImage?.slug ?? null;
  config.champGalerie = champGalerie?.slug ?? null;

  console.log('');
  console.log(
    `Photo principale  : ${champImage ? VERT(champImage.displayName) : JAUNE('aucun champ Image trouvé')}`
  );
  console.log(
    `Galerie           : ${champGalerie ? VERT(champGalerie.displayName) : JAUNE('aucun champ Galerie trouvé')}`
  );
  if (structure.champsFichier.length) {
    const dispo = structure.champsFichier.map((c) => c.slug).join(', ');
    console.log(`Fiche PDF         : ${GRIS('champs « Fichier » disponibles : ' + dispo)}`);
    console.log(
      GRIS('                    renseignez « champFichePdf » dans config/config.json pour y déposer la fiche.')
    );
  }

  ecrireConfig(config);
  console.log(VERT('\nConfiguration enregistrée dans config/config.json'));
  if (!cleAnthropic()) {
    console.log(
      JAUNE('ANTHROPIC_API_KEY absente : la lecture automatique des fiches sera désactivée.')
    );
  }
  console.log(`\nÉtape suivante : ${GRAS('npm start')} pour l'interface glisser-déposer,`);
  console.log(`ou ${GRAS('npm run import -- ./biens/mon-dossier')} en ligne de commande.\n`);
}

// ── champs ────────────────────────────────────────────────────────────────

async function commandeChamps() {
  const config = lireConfig();
  const jeton = jetonWebflow();
  const structure = await chargerStructure(config, jeton);

  console.log(GRAS(`\nCollection « ${structure.nom} » — ${structure.champs.length} champs\n`));
  for (const champ of structure.champs) {
    const marques = [
      champ.isRequired ? ROUGE('obligatoire') : null,
      structure.champsExtraits.includes(champ) ? GRIS('lu dans la fiche') : null,
      champ.type === 'Image' || champ.type === 'MultiImage' ? GRIS('photos') : null,
      structure.champsNonGeres.includes(champ) ? JAUNE('non géré') : null,
    ].filter(Boolean);
    console.log(
      `  ${champ.slug.padEnd(28)} ${GRIS(champ.type.padEnd(14))} ${champ.displayName}` +
        (marques.length ? '  ' + marques.join(' ') : '')
    );
  }
  if (structure.champsNonGeres.length) {
    console.log(
      JAUNE("\nLes champs « non gérés » (références vers d'autres collections, couleurs) ") +
        JAUNE('restent à renseigner dans Webflow.')
    );
  }
  console.log('');
}

// ── import ────────────────────────────────────────────────────────────────

function lireDossier(dossier) {
  if (!fs.existsSync(dossier)) throw new Error(`Dossier introuvable : ${dossier}`);
  const entrees = fs.readdirSync(dossier).filter((n) => !n.startsWith('.'));

  const pdfs = entrees.filter((n) => n.toLowerCase().endsWith('.pdf'));
  if (pdfs.length > 1) {
    throw new Error(
      `Le dossier contient ${pdfs.length} PDF (${pdfs.join(', ')}). Laissez-en un seul : la fiche du bien.`
    );
  }

  const photos = trierNaturellement(entrees.filter(estUnePhoto)).map((nom) => ({
    nom,
    contenu: fs.readFileSync(path.join(dossier, nom)),
  }));

  return {
    pdf: pdfs[0] ? fs.readFileSync(path.join(dossier, pdfs[0])) : null,
    nomPdf: pdfs[0] ?? null,
    photos,
  };
}

async function commandeImport(args) {
  const dossier = args.find((a) => !a.startsWith('-'));
  if (!dossier) {
    throw new Error('Précisez le dossier du bien : npm run import -- ./biens/mon-dossier');
  }
  const publier = args.includes('--publier');
  const sansQuestion = args.includes('--oui') || args.includes('-y');
  const simulation = args.includes('--simulation') || args.includes('--dry-run');

  const config = lireConfig();
  const jeton = jetonWebflow();
  const structure = await chargerStructure(config, jeton);
  const depot = lireDossier(path.resolve(dossier));

  console.log(GRAS(`\nDossier : ${dossier}`));
  console.log(`  Fiche  : ${depot.nomPdf ?? JAUNE('aucune')}`);
  console.log(`  Photos : ${depot.photos.length}`);
  console.log(GRIS('\nLecture de la fiche…'));

  const analyse = await analyserDepot(depot, structure, config);

  console.log(GRAS('\nChamps reconnus'));
  for (const champ of structure.champsExtraits) {
    const valeur = analyse.fieldData[champ.slug];
    if (valeur === undefined) continue;
    const affichage = String(valeur).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(
      `  ${champ.displayName.padEnd(26)} ${affichage.slice(0, 90)}${affichage.length > 90 ? '…' : ''}`
    );
  }

  const manquants = structure.champsExtraits.filter(
    (c) => c.isRequired && analyse.fieldData[c.slug] === undefined
  );
  if (manquants.length) {
    console.log(
      ROUGE(`\nChamps obligatoires non renseignés : ${manquants.map((c) => c.displayName).join(', ')}`)
    );
  }
  for (const remarque of analyse.remarques) console.log(JAUNE(`  ⚠ ${remarque}`));
  for (const avertissement of analyse.avertissements) console.log(JAUNE(`  ⚠ ${avertissement}`));

  if (simulation) {
    console.log(GRIS("\nSimulation : rien n'a été envoyé à Webflow.\n"));
    console.log(JSON.stringify(analyse.fieldData, null, 2));
    return;
  }
  if (manquants.length && !sansQuestion) {
    const suite = await demander(
      ROUGE('\nContinuer malgré les champs obligatoires manquants ? [o/N] '),
      'n'
    );
    if (!/^o(ui)?$/i.test(suite)) return console.log('Abandon.');
  }
  if (!sansQuestion) {
    const question = publier
      ? GRAS('\nPublier cette annonce en ligne maintenant ? [o/N] ')
      : GRAS('\nCréer cette annonce en brouillon dans Webflow ? [O/n] ');
    const reponse = await demander(question, publier ? 'n' : 'o');
    if (!/^o(ui)?$/i.test(reponse)) return console.log('Abandon.');
  }

  const resultat = await envoyerVersWebflow({
    structure,
    fieldData: analyse.fieldData,
    photos: analyse.photos,
    pdf: depot.pdf,
    config,
    jeton,
    publier,
    ecrire: (m) => console.log(GRIS('  ' + m)),
  });

  console.log(
    VERT(`\nAnnonce ${publier ? 'publiée' : 'créée en brouillon'} : ${resultat.item.fieldData?.name}`)
  );
  console.log(`  slug        : ${resultat.slug}`);
  console.log(`  identifiant : ${resultat.item.id}`);
  console.log(`  photos      : ${resultat.medias.length} envoyées`);
  if (!publier) {
    console.log(GRIS("\nRelisez l'annonce dans l'éditeur Webflow, puis publiez le site.\n"));
  } else {
    console.log(GRIS('\nPensez à publier le site si la page de liste doit être régénérée.\n'));
  }
}

// ── point d'entree ────────────────────────────────────────────────────────

const [, , commande, ...args] = process.argv;

const commandes = {
  setup: commandeSetup,
  champs: () => commandeChamps(),
  import: () => commandeImport(args),
};

if (!commande || !commandes[commande]) {
  console.log(`
${GRAS('Publication de biens immobiliers dans Webflow')}

  npm run setup                          choisir le site et la collection
  npm run champs                         lister les champs de la collection
  npm run import -- ./biens/mon-dossier  publier un dossier (fiche PDF + photos)
  npm start                              interface glisser-déposer (navigateur)

Options de « import » :
  --publier      publier directement en ligne (par défaut : brouillon)
  --simulation   afficher ce qui serait envoyé, sans rien créer
  --oui          ne pas demander de confirmation
`);
  process.exit(commande ? 1 : 0);
}

commandes[commande]().catch((erreur) => {
  console.error(ROUGE(`\nErreur : ${erreur.message}\n`));
  if (process.env.DEBUG) console.error(erreur);
  process.exit(1);
});
