// Tests de bout en bout, sans toucher a Webflow ni a l'API Claude :
//   node test/executer.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ici = path.dirname(fileURLToPath(import.meta.url));
const racine = path.join(ici, '..');
const fixtures = path.join(ici, 'fixtures');

// Les reglages versionnes du depot ne doivent pas influencer les tests :
// on les met de cote le temps de l'execution.
const cheminPartage = path.join(racine, 'config', 'webflow.json');
const partageExistant = fs.existsSync(cheminPartage) ? fs.readFileSync(cheminPartage) : null;
if (partageExistant) fs.rmSync(cheminPartage);
const rendreReglages = () => {
  if (partageExistant) fs.writeFileSync(cheminPartage, partageExistant);
};
process.on('exit', rendreReglages);

process.env.WEBFLOW_TOKEN = 'JETON-TEST';
process.env.MOT_DE_PASSE = 'un-mot-de-passe-de-test-assez-long';
delete process.env.ANTHROPIC_API_KEY;

const { demarrerFauxWebflow } = await import('./faux-webflow.js');
const faux = await demarrerFauxWebflow();
process.env.WEBFLOW_API_BASE = faux.base;

const { lireCollection } = await import('../src/webflow.js');
const {
  analyserCollection,
  schemaExtraction,
  versFieldData,
  fabriquerSlug,
  choisirChampImage,
  choisirChampGalerie,
  reglagesIncoherents,
} = await import('../src/schema.js');
const { lireLaFiche, reserverSlug, publierBien } = await import('../src/pipeline.js');
const { trierNaturellement, preparerPhotos, preparerPhoto } = await import('../src/photos.js');
const auth = await import('../src/auth.js');

const reussites = [];
const echecs = [];
async function verifier(titre, fonction) {
  try {
    await fonction();
    reussites.push(titre);
    console.log('  ok   ' + titre);
  } catch (erreur) {
    echecs.push([titre, erreur]);
    console.log('  ECHEC ' + titre + '\n        ' + erreur.message);
  }
}

const config = {
  siteId: 'site1',
  collectionId: 'col1',
  champImagePrincipale: null,
  champGalerie: null,
  champFichePdf: 'fiche-pdf',
  photoLargeurMax: 1600,
  photoQualite: 80,
  consignes: '',
};

const collection = await lireCollection('col1');
const structure = analyserCollection(collection);
const pdf = fs.readFileSync(path.join(fixtures, 'fiche.pdf'));
const photos = trierNaturellement(fs.readdirSync(fixtures).filter((n) => n.endsWith('.jpg'))).map(
  (nom) => ({ nom, contenu: fs.readFileSync(path.join(fixtures, nom)) })
);

console.log('\nStructure de la collection');

await verifier('les champs medias et references sont exclus de la lecture de fiche', () => {
  const slugs = structure.champsExtraits.map((c) => c.slug);
  assert.ok(!slugs.includes('photo-principale'));
  assert.ok(!slugs.includes('galerie'));
  assert.ok(!slugs.includes('fiche-pdf'));
  assert.ok(!slugs.includes('notaire'), 'une reference ne se lit pas dans la fiche');
  assert.ok(!slugs.includes('quartiers'));
  assert.ok(!slugs.includes('slug'), 'le slug est calcule, pas lu dans la fiche');
  assert.ok(slugs.includes('prix') && slugs.includes('descriptif'));
  assert.deepEqual(structure.champsNonGeres.map((c) => c.slug), ['couleur']);
});

await verifier("l'etude peut exiger des champs que Webflow laisse facultatifs", () => {
  // Par nom affiche, par slug, sans egard aux majuscules : la configuration
  // est ecrite a la main, elle n'a pas a deviner l'orthographe exacte.
  const exigeante = analyserCollection(collection, ['NOTAIRE', 'commune']);
  const parSlug = Object.fromEntries(exigeante.champs.map((c) => [c.slug, c]));

  assert.equal(parSlug.notaire.obligatoire, true, 'reference exigee par l etude');
  assert.equal(parSlug.notaire.exigeParEtude, true);
  assert.equal(parSlug.commune.obligatoire, true, 'champ texte exige par l etude');

  assert.equal(parSlug.surface.obligatoire, false, 'le reste ne bouge pas');
  assert.equal(parSlug.surface.exigeParEtude, false);

  // Ce que Webflow exige deja reste exige, mais ce n'est pas l'etude qui le
  // demande : l'ecran doit pouvoir distinguer les deux.
  assert.equal(parSlug.prix.obligatoire, true);
  assert.equal(parSlug.prix.exigeParEtude, false);

  // Sans liste, rien ne change.
  assert.equal(analyserCollection(collection).champs.find((c) => c.slug === 'notaire').obligatoire,
    false);
});

await verifier("la liste des plans video est remise d'aplomb", async () => {
  const { ordonnerPlans } = await import('../src/video.js');

  // Ordre respecte, rien a redire.
  const net = ordonnerPlans([{ photo: 2, titre: 'Jardin' }, { photo: 0, titre: 'Cuisine' },
                             { photo: 1, titre: '' }], 3);
  assert.deepEqual(net.plans.map((p) => p.photo), [2, 0, 1]);
  assert.deepEqual(net.remarques, [], 'rien a signaler quand tout est la');

  // Doublon, numero hors lot, photo oubliee : la video doit rester entiere.
  const repare = ordonnerPlans(
    [{ photo: 1, titre: 'Cuisine' }, { photo: 1, titre: 'Cuisine' },
     { photo: 7, titre: 'Inventee' }, { photo: -1, titre: 'Ailleurs' }],
    3
  );
  assert.deepEqual(repare.plans.map((p) => p.photo), [1, 0, 2], 'chaque photo une fois');
  assert.deepEqual(repare.plans.map((p) => p.titre), ['Cuisine', '', ''],
    'une photo rattrapee part sans texte plutot qu avec un titre devine');
  assert.equal(repare.remarques.length, 1);
  assert.match(repare.remarques[0], /1, 3/, 'les numeros sont ceux de l utilisateur, a partir de 1');

  // Reponse vide : on ne perd toujours aucune photo.
  assert.deepEqual(ordonnerPlans(undefined, 2).plans.map((p) => p.photo), [0, 1]);
});

await verifier("un champ obligatoire absent de la collection est signale", () => {
  const soucis = reglagesIncoherents(structure, { champsObligatoires: ['Office', 'Notaire'] });
  assert.equal(soucis.length, 1, 'seul le champ introuvable est signale');
  assert.match(soucis[0], /Office/);
  assert.deepEqual(reglagesIncoherents(structure, {}), [], 'sans reglage, aucun avertissement');
});

await verifier('le champ prix est reconnu, et jamais confondu avec un autre nombre', async () => {
  const { choisirChampPrix } = await import('../src/schema.js');
  assert.equal(choisirChampPrix(structure, null).slug, 'prix');
  assert.equal(choisirChampPrix(structure, 'surface').slug, 'surface', 'un slug configure gagne');

  const sansPrix = {
    champs: [
      { slug: 'nbr-pieces', displayName: 'Nombre de pieces', type: 'Number' },
      { slug: 'surface', displayName: 'Surface', type: 'Number' },
    ],
  };
  assert.equal(
    choisirChampPrix(sansPrix, null),
    null,
    'sans champ ressemblant a un prix, on n affiche rien plutot qu un nombre au hasard'
  );
});

await verifier('les champs de reference sont isoles, avec leur collection cible', () => {
  assert.deepEqual(
    structure.champsReference.map((c) => [c.slug, c.type, c.validations?.collectionId]),
    [
      ['notaire', 'Reference', 'col2'],
      ['quartiers', 'MultiReference', 'col2'],
    ]
  );
});

await verifier('les elements referencables sont listes et tries', async () => {
  const { listerItems } = await import('../src/webflow.js');
  const items = await listerItems('col2', 'JETON-TEST');
  assert.deepEqual(items.map((i) => i.nom), ['Maitre Alain Bernard', 'Maitre Zoé Dupont']);
  assert.equal(items[0].id, 'ref1');
});

await verifier("une reference choisie a l'ecran est transmise telle quelle", async () => {
  const resultat = await publierBien({
    fieldData: {
      name: 'Bien avec notaire',
      prix: 120000,
      notaire: 'ref1',
      quartiers: ['ref1', 'ref2'],
    },
    structure,
    config,
    publier: false,
  });
  assert.equal(resultat.item.fieldData.notaire, 'ref1', 'une reference est un identifiant');
  assert.deepEqual(resultat.item.fieldData.quartiers, ['ref1', 'ref2'], 'une multi-reference est un tableau');
});

await verifier('les champs photo sont detectes automatiquement', () => {
  assert.equal(choisirChampImage(structure, null).slug, 'photo-principale');
  assert.equal(choisirChampGalerie(structure, null).slug, 'galerie');
});

await verifier('le schema JSON decrit chaque champ, avec null autorise', () => {
  const schema = schemaExtraction(structure);
  assert.deepEqual(schema.properties.prix.type, ['number', 'null']);
  assert.deepEqual(schema.properties.vendu.type, ['boolean', 'null']);
  assert.deepEqual(schema.properties['type-de-bien'].enum, ['Maison', 'Appartement', 'Terrain', null]);
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('_remarques'));
  assert.ok(schema.properties.descriptif.description.includes('Descriptif'));
});

console.log('\nConversion vers Webflow');

await verifier('les valeurs sont nettoyees et les nulls ecartes', () => {
  const { fieldData } = versFieldData(structure, {
    name: 'Maison 6 pieces - Saint-Brieuc',
    prix: '285 000',
    surface: 142,
    commune: 'Saint-Brieuc',
    'type-de-bien': 'maison',
    dpe: null,
    vendu: false,
    descriptif: '<p>Maison traditionnelle.</p>',
  });
  assert.equal(fieldData.prix, 285000, 'un prix texte devient un nombre');
  assert.equal(fieldData['type-de-bien'], 'Maison', "l'option est recalee sur le libelle exact");
  assert.equal(fieldData.vendu, false);
  assert.ok(!('dpe' in fieldData), "un champ null n'est pas envoye");
});

await verifier("une option inconnue est signalee au lieu d'etre envoyee", () => {
  const { fieldData, avertissements } = versFieldData(structure, { 'type-de-bien': 'Chateau' });
  assert.ok(!('type-de-bien' in fieldData));
  assert.match(avertissements[0], /Chateau/);
});

await verifier("un prix illisible est signale au lieu d'etre envoye", () => {
  const { fieldData, avertissements } = versFieldData(structure, { prix: 'nous consulter' });
  assert.ok(!('prix' in fieldData));
  assert.match(avertissements[0], /Prix/);
});

await verifier('les separateurs de milliers sont compris', () => {
  const { fieldData } = versFieldData(structure, { prix: '1 250 000 €', surface: '142,5 m2' });
  assert.equal(fieldData.prix, 1250000);
  assert.equal(fieldData.surface, 142.5);
});

await verifier('le slug est lisible et sans accent', () => {
  assert.equal(fabriquerSlug('Maison 6 pièces — Saint-Brieuc'), 'maison-6-pieces-saint-brieuc');
  assert.ok(fabriquerSlug('').length > 0);
});

console.log('\nPhotos');

await verifier('une photo est redimensionnee, convertie et debarrassee des EXIF', async () => {
  const sharp = (await import('sharp')).default;
  const prepare = await preparerPhoto(photos[0].contenu, { largeurMax: 1600 });
  const infos = await sharp(prepare.contenu).metadata();
  assert.equal(infos.width, 1600);
  assert.equal(infos.format, 'jpeg');
  assert.equal(infos.exif, undefined, 'aucune donnee EXIF (donc aucune position GPS) ne subsiste');
  assert.ok(prepare.contenu.length < photos[0].contenu.length);
});

await verifier("un fichier illisible n'interrompt pas le lot", async () => {
  const { photos: preparees, avertissements } = await preparerPhotos([
    { nom: 'cassee.jpg', contenu: Buffer.from('pas une image') },
    photos[0],
  ]);
  assert.equal(preparees.length, 1);
  assert.match(avertissements[0], /cassee\.jpg/);
});

await verifier("les photos sont triees comme dans l'explorateur", () => {
  assert.deepEqual(trierNaturellement(['p10.jpg', 'p2.jpg', 'p1.jpg']), ['p1.jpg', 'p2.jpg', 'p10.jpg']);
});

console.log('\nProtection par mot de passe');

await verifier('un mot de passe correct ouvre une session, un mauvais non', () => {
  assert.equal(auth.protectionActive(), true);
  assert.equal(auth.verifierMotDePasse('un-mot-de-passe-de-test-assez-long'), true);
  assert.equal(auth.verifierMotDePasse('autre chose'), false);
  assert.equal(auth.verifierMotDePasse(''), false);
  assert.equal(auth.verifierMotDePasse(undefined), false);
});

await verifier('un cookie de session signe est accepte, un cookie bricole non', () => {
  const session = auth.creerSession();
  assert.equal(auth.sessionValide(session), true);
  assert.equal(auth.sessionValide(session.replace(/.$/, 'X')), false, 'signature modifiee');
  assert.equal(auth.sessionValide('9999999999999.nimporte-quoi'), false, 'signature inventee');
  assert.equal(auth.sessionValide(''), false);
  assert.equal(auth.sessionValide(null), false);
});

await verifier('une session expiree est refusee', () => {
  const session = auth.creerSession();
  const [expiration, signature] = session.split('.');
  // Meme signature, mais on pretend qu'elle a ete emise pour une date passee.
  assert.equal(auth.sessionValide(`1.${signature}`), false);
  assert.ok(Number(expiration) > Date.now());
});

await verifier('changer le mot de passe invalide les sessions ouvertes', () => {
  const session = auth.creerSession();
  process.env.MOT_DE_PASSE = 'un-autre-mot-de-passe-tout-aussi-long';
  assert.equal(auth.sessionValide(session), false);
  process.env.MOT_DE_PASSE = 'un-mot-de-passe-de-test-assez-long';
  assert.equal(auth.sessionValide(session), true);
});

await verifier('un mot de passe trop court est signale', () => {
  process.env.MOT_DE_PASSE = 'court';
  assert.match(auth.alerteConfiguration(), /caracteres/);
  delete process.env.MOT_DE_PASSE;
  assert.match(auth.alerteConfiguration(), /MOT_DE_PASSE/);
  process.env.MOT_DE_PASSE = 'un-mot-de-passe-de-test-assez-long';
  assert.equal(auth.alerteConfiguration(), null);
});

console.log('\nEnchainement complet');

await verifier("sans cle Claude, la lecture previent au lieu d'echouer", async () => {
  const lecture = await lireLaFiche(pdf, structure, config);
  assert.equal(lecture.fieldData.name, 'Nouveau bien');
  assert.ok(lecture.avertissements.some((a) => /ANTHROPIC_API_KEY/.test(a)));
});

await verifier('sans fiche PDF, la lecture le signale', async () => {
  const lecture = await lireLaFiche(null, structure, config);
  assert.ok(lecture.avertissements.some((a) => /Aucune fiche PDF/.test(a)));
});

let resultat;
await verifier("l'envoi cree l'element en brouillon avec photos et fiche PDF", async () => {
  resultat = await publierBien({
    pdf,
    photos,
    fieldData: {
      name: 'Maison 6 pieces - Saint-Brieuc',
      prix: 285000,
      surface: 142,
      commune: 'Saint-Brieuc',
      'type-de-bien': 'Maison',
      descriptif: '<p>Maison traditionnelle.</p>',
    },
    structure,
    config,
    publier: false,
  });

  assert.equal(resultat.item.isDraft, true, 'brouillon par defaut');
  assert.equal(resultat.medias.length, 4);
  assert.equal(resultat.slug, 'maison-6-pieces-saint-brieuc');

  const envoye = resultat.item.fieldData;
  assert.equal(envoye['photo-principale'].fileId, resultat.medias[0].fileId);
  assert.equal(envoye.galerie.length, 4);
  assert.ok(envoye['fiche-pdf'].url.endsWith('.pdf'), 'la fiche PDF est jointe');
  assert.equal(faux.medias.length, 5, '4 photos + 1 PDF televerses');
  assert.equal(faux.journal.filter((l) => l.startsWith('POST /faux-s3')).length, 5);
});

await verifier('les photos sont nommees avec le slug definitif et leur rang', () => {
  const noms = resultat.item.fieldData.galerie.map((m) => m.url);
  assert.match(noms[0], /maison-6-pieces-saint-brieuc-01\.jpg$/);
  assert.match(noms[3], /maison-6-pieces-saint-brieuc-04\.jpg$/);
});

await verifier("une photo illisible n'empeche pas la creation de l'annonce", async () => {
  const resultat = await publierBien({
    photos: [{ nom: 'cassee.jpg', contenu: Buffer.from('pas une image') }, photos[0]],
    fieldData: { name: 'Maison avec photo cassee', prix: 100000 },
    structure,
    config,
    publier: false,
  });
  assert.equal(resultat.medias.length, 1);
  assert.match(resultat.avertissements[0], /cassee\.jpg/);
  assert.match(resultat.item.fieldData.galerie[0].url, /-01\.jpg$/, 'la numerotation reste continue');
});

await verifier('un slug de champ mal configure retombe sur la detection, avec avertissement', async () => {
  const { photos: preparees } = await preparerPhotos([photos[0]]);
  const resultat = await publierBien({
    photos: [photos[0]],
    fieldData: { name: 'Maison mal configuree', prix: 100000 },
    structure,
    config: { ...config, champImagePrincipale: 'slug-qui-nexiste-pas' },
    publier: false,
  });
  assert.ok(
    resultat.item.fieldData['photo-principale'],
    'la photo doit quand meme etre attachee, pas perdue en silence'
  );
  assert.ok(
    resultat.avertissements.some((a) => /slug-qui-nexiste-pas/.test(a)),
    'et le reglage douteux doit etre signale'
  );
  assert.ok(preparees.length === 1);
});

await verifier("un doublon de slug est renomme au lieu d'ecraser l'annonce existante", async () => {
  const { slug, renomme } = await reserverSlug(
    { name: 'Maison 6 pieces - Saint-Brieuc' },
    config,
    'JETON-TEST'
  );
  assert.equal(renomme, true);
  assert.match(slug, /^maison-6-pieces-saint-brieuc-\d{4}$/);
});

await verifier('un slug libre est utilise tel quel', async () => {
  const { slug, renomme } = await reserverSlug({ name: 'Longere a Plouha' }, config, 'JETON-TEST');
  assert.equal(renomme, false);
  assert.equal(slug, 'longere-a-plouha');
});

await verifier('la publication appelle bien Webflow', async () => {
  const publie = await publierBien({
    fieldData: { name: 'Appartement T3 - Lannion', prix: 149000, 'type-de-bien': 'Appartement' },
    structure,
    config,
    publier: true,
  });
  assert.equal(publie.item.isDraft, false);
  assert.deepEqual(publie.publication.publishedItemIds, [publie.item.id]);
});

await verifier('une erreur de validation Webflow remonte en clair', async () => {
  await assert.rejects(
    publierBien({
      fieldData: { name: 'Bien invalide', 'type-de-bien': 'Chateau' },
      structure,
      config,
      publier: false,
    }),
    (erreur) => {
      assert.match(erreur.message, /Validation Error/);
      assert.match(erreur.message, /type-de-bien/);
      return true;
    }
  );
});

await verifier('un jeton invalide donne un message comprehensible', async () => {
  process.env.WEBFLOW_TOKEN = 'MAUVAIS';
  await assert.rejects(lireCollection('col1'), (erreur) => {
    assert.match(erreur.message, /WEBFLOW_TOKEN/);
    return true;
  });
  process.env.WEBFLOW_TOKEN = 'JETON-TEST';
});

console.log('\nClient Claude');

const claude = await import('../src/claude.js');

await verifier("l'espace de travail se transmet en en-tete quand il est defini", () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  delete process.env.ANTHROPIC_WORKSPACE_ID;
  assert.equal(claude.espaceDeTravail(), null);

  process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_123';
  assert.equal(claude.espaceDeTravail(), 'wrkspc_123');
  const client = claude.clientClaude('un test');
  assert.equal(client._options.defaultHeaders['anthropic-workspace-id'], 'wrkspc_123');

  delete process.env.ANTHROPIC_WORKSPACE_ID;
  delete process.env.ANTHROPIC_API_KEY;
});

await verifier('les erreurs de l API sont traduites en conseils actionnables', () => {
  assert.match(
    claude.messageClaude(new Error('This API key is not scoped to a workspace')),
    /ANTHROPIC_WORKSPACE_ID/
  );
  assert.match(claude.messageClaude(new Error('credit balance is too low')), /crédit/i);
  assert.match(claude.messageClaude(new Error('rate_limit_error')), /Patientez/);
  assert.equal(claude.messageClaude(new Error('panne inconnue')), 'panne inconnue');
});

console.log('\nPublication Facebook');

const publication = await import('../src/publication.js');

await verifier('le style se lit et contient des exemples reels', () => {
  const style = publication.lireStyle();
  assert.ok(style.exemples.length >= 2, 'les exemples pesent plus que les consignes');
  assert.match(style.urlBien, /\{slug\}/, "le gabarit d'URL doit porter un emplacement de slug");
  assert.ok(style.consignes.length > 200);
});

await verifier('le lien du bien se construit depuis le slug', () => {
  const style = { urlBien: 'https://exemple.fr/maison/{slug}' };
  assert.equal(
    publication.lienDuBien(style, { fieldData: { slug: 'longere-a-plouha' } }),
    'https://exemple.fr/maison/longere-a-plouha'
  );
  assert.equal(publication.lienDuBien(style, { fieldData: {} }), null, 'pas de slug, pas de lien');
  assert.equal(publication.lienDuBien({ urlBien: null }, { fieldData: { slug: 'x' } }), null);
});

await verifier('la fiche transmise a la redaction est lisible et debarrassee du bruit', () => {
  const texte = publication.decrireBien(structure, {
    fieldData: {
      name: 'Maison 6 pieces',
      prix: 285000,
      descriptif: '<p>Sejour double <strong>avec</strong> cheminee.</p>',
      slug: 'maison-6-pieces',
      'photo-principale': { fileId: 'media1', url: 'https://cdn/x.jpg' },
      galerie: [{ fileId: 'media2' }],
      dpe: '',
    },
  });
  assert.match(texte, /Titre : Maison 6 pieces/);
  assert.match(texte, /Prix : 285000/);
  assert.match(texte, /Sejour double avec cheminee\./, 'le HTML est aplati');
  assert.ok(!/photo-principale|media1|cdn/.test(texte), 'les photos n aident pas a rediger');
  assert.ok(!texte.includes('maison-6-pieces'), 'le slug non plus');
  assert.ok(!/DPE/.test(texte), 'un champ vide est ecarte');
});

await verifier('sans cle Claude, la redaction refuse clairement', async () => {
  await assert.rejects(
    publication.redigerPublication({ structure, item: { fieldData: {} }, style: publication.lireStyle() }),
    (erreur) => {
      assert.match(erreur.message, /ANTHROPIC_API_KEY/);
      return true;
    }
  );
});

console.log('\nConfiguration par variables d\'environnement');

await verifier("l'environnement remplace le fichier de configuration", async () => {
  process.env.WEBFLOW_SITE_ID = 'site-depuis-env';
  process.env.WEBFLOW_CHAMP_FICHE_PDF = 'fiche-pdf';
  process.env.PHOTO_LARGEUR_MAX = '1200';
  const { lireConfig, configPourVercel } = await import('../src/config.js?frais=' + Date.now());
  const config = lireConfig();
  assert.equal(config.siteId, 'site-depuis-env');
  assert.equal(config.photoLargeurMax, 1200);

  const variables = Object.fromEntries(configPourVercel(config));
  assert.equal(variables.WEBFLOW_SITE_ID, 'site-depuis-env');
  assert.equal(variables.WEBFLOW_CHAMP_FICHE_PDF, 'fiche-pdf');
  assert.ok(!('WEBFLOW_SITE_NOM' in variables), 'les reglages vides ne sont pas listes');

  delete process.env.WEBFLOW_SITE_ID;
  delete process.env.WEBFLOW_CHAMP_FICHE_PDF;
  delete process.env.PHOTO_LARGEUR_MAX;
});

await faux.arreter();

console.log(`\n${reussites.length} test(s) reussi(s), ${echecs.length} echec(s).\n`);
process.exit(echecs.length ? 1 : 0);
