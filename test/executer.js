// Tests de bout en bout, sans toucher a Webflow ni a l'API Claude :
//   node test/executer.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ici = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(ici, 'fixtures');

process.env.WEBFLOW_TOKEN = 'JETON-TEST';
delete process.env.ANTHROPIC_API_KEY;

const { demarrerFauxWebflow } = await import('./faux-webflow.js');
const faux = await demarrerFauxWebflow();
process.env.WEBFLOW_API_BASE = faux.base;

const { lireCollection } = await import('../src/webflow.js');
const { analyserCollection, schemaExtraction, versFieldData, fabriquerSlug, choisirChampImage, choisirChampGalerie } =
  await import('../src/schema.js');
const { analyserDepot, envoyerVersWebflow } = await import('../src/pipeline.js');
const { texteDuPdf } = await import('../src/extraction.js');
const { trierNaturellement, preparerPhotos } = await import('../src/photos.js');

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
const photos = trierNaturellement(fs.readdirSync(fixtures).filter((n) => n.endsWith('.jpg'))).map((nom) => ({
  nom,
  contenu: fs.readFileSync(path.join(fixtures, nom)),
}));

console.log('\nStructure de la collection');

await verifier('les champs medias et references sont exclus de la lecture de fiche', () => {
  const slugs = structure.champsExtraits.map((c) => c.slug);
  assert.ok(!slugs.includes('photo-principale'));
  assert.ok(!slugs.includes('galerie'));
  assert.ok(!slugs.includes('fiche-pdf'));
  assert.ok(!slugs.includes('notaire'), 'les references vers une autre collection ne sont pas gerees');
  assert.ok(!slugs.includes('slug'), 'le slug est calcule, pas lu dans la fiche');
  assert.ok(slugs.includes('prix') && slugs.includes('descriptif'));
  assert.equal(structure.champsNonGeres.length, 1);
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
  assert.ok(!('dpe' in fieldData), 'un champ null n\'est pas envoye');
});

await verifier('une option inconnue est signalee au lieu d\'etre envoyee', () => {
  const { fieldData, avertissements } = versFieldData(structure, { 'type-de-bien': 'Chateau' });
  assert.ok(!('type-de-bien' in fieldData));
  assert.match(avertissements[0], /Chateau/);
});

await verifier('un prix illisible est signale au lieu d\'etre envoye', () => {
  const { fieldData, avertissements } = versFieldData(structure, { prix: 'nous consulter' });
  assert.ok(!('prix' in fieldData));
  assert.match(avertissements[0], /Prix/);
});

await verifier('le slug est lisible et sans accent', () => {
  assert.equal(fabriquerSlug('Maison 6 pièces — Saint-Brieuc'), 'maison-6-pieces-saint-brieuc');
  assert.ok(fabriquerSlug('').length > 0);
});

console.log('\nFiche PDF et photos');

await verifier('le texte de la fiche est lisible', async () => {
  const texte = await texteDuPdf(pdf);
  assert.match(texte, /285 000/);
  assert.match(texte, /Saint-Brieuc/);
});

await verifier('les photos sont redimensionnees, converties et debarrassees des EXIF', async () => {
  const sharp = (await import('sharp')).default;
  const { photos: preparees } = await preparerPhotos(photos, { slug: 'maison-test', largeurMax: 1600 });
  assert.equal(preparees.length, 4);
  assert.equal(preparees[0].nom, 'maison-test-01.jpg');
  const infos = await sharp(preparees[0].contenu).metadata();
  assert.equal(infos.width, 1600);
  assert.equal(infos.format, 'jpeg');
  assert.equal(infos.exif, undefined, 'aucune donnee EXIF (donc aucune position GPS) ne subsiste');
  assert.ok(preparees[0].contenu.length < photos[0].contenu.length);
  assert.ok(preparees[0].apercu.startsWith('data:image/jpeg;base64,'));
});

await verifier('un fichier illisible n\'interrompt pas le lot', async () => {
  const { photos: preparees, avertissements } = await preparerPhotos(
    [{ nom: 'cassee.jpg', contenu: Buffer.from('pas une image') }, photos[0]],
    { slug: 'test' }
  );
  assert.equal(preparees.length, 1);
  assert.equal(preparees[0].nom, 'test-01.jpg', 'la numerotation reste continue');
  assert.match(avertissements[0], /cassee\.jpg/);
});

await verifier('les photos sont triees comme dans l\'explorateur', () => {
  assert.deepEqual(trierNaturellement(['p10.jpg', 'p2.jpg', 'p1.jpg']), ['p1.jpg', 'p2.jpg', 'p10.jpg']);
});

console.log('\nEnchainement complet');

await verifier('sans cle Claude, l\'analyse previent au lieu d\'echouer', async () => {
  const analyse = await analyserDepot({ pdf, photos }, structure, config);
  assert.equal(analyse.photos.length, 4);
  assert.equal(analyse.fieldData.name, 'Nouveau bien');
  assert.ok(analyse.fieldData.slug);
  assert.ok(analyse.avertissements.some((a) => /ANTHROPIC_API_KEY/.test(a)));
});

let resultat;
await verifier('l\'envoi cree l\'element en brouillon avec photos et fiche PDF', async () => {
  const { photos: preparees } = await preparerPhotos(photos, { slug: 'maison-saint-brieuc' });
  resultat = await envoyerVersWebflow({
    structure,
    fieldData: {
      name: 'Maison 6 pieces - Saint-Brieuc',
      prix: 285000,
      surface: 142,
      commune: 'Saint-Brieuc',
      'type-de-bien': 'Maison',
      descriptif: '<p>Maison traditionnelle.</p>',
    },
    photos: preparees,
    pdf,
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
  assert.ok(faux.journal.filter((l) => l.startsWith('POST /faux-s3')).length === 5);
});

await verifier('l\'ordre des photos choisi a l\'ecran est respecte', () => {
  const noms = resultat.item.fieldData.galerie.map((m) => m.url);
  assert.match(noms[0], /-01\.jpg$/);
  assert.match(noms[3], /-04\.jpg$/);
});

await verifier('un doublon de slug est renomme au lieu d\'ecraser l\'annonce existante', async () => {
  const second = await envoyerVersWebflow({
    structure,
    fieldData: { name: 'Maison 6 pieces - Saint-Brieuc', prix: 285000 },
    photos: [],
    config,
    publier: false,
  });
  assert.notEqual(second.slug, 'maison-6-pieces-saint-brieuc');
  assert.match(second.slug, /^maison-6-pieces-saint-brieuc-\d{4}$/);
});

await verifier('la publication appelle bien Webflow', async () => {
  const publie = await envoyerVersWebflow({
    structure,
    fieldData: { name: 'Appartement T3 - Lannion', prix: 149000, 'type-de-bien': 'Appartement' },
    photos: [],
    config,
    publier: true,
  });
  assert.equal(publie.item.isDraft, false);
  assert.deepEqual(publie.publication.publishedItemIds, [publie.item.id]);
});

await verifier('une erreur de validation Webflow remonte en clair', async () => {
  await assert.rejects(
    envoyerVersWebflow({
      structure,
      fieldData: { name: 'Bien invalide', 'type-de-bien': 'Chateau' },
      photos: [],
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

await faux.arreter();

console.log(`\n${reussites.length} test(s) reussi(s), ${echecs.length} echec(s).\n`);
process.exit(echecs.length ? 1 : 0);
