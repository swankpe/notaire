// Test de l'interface locale : on demarre le faux Webflow, puis le serveur web,
// et on rejoue le parcours complet depot -> relecture -> envoi.
//   node test/web.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { demarrerFauxWebflow } from './faux-webflow.js';

const ici = path.dirname(fileURLToPath(import.meta.url));
const racine = path.join(ici, '..');
const fixtures = path.join(ici, 'fixtures');
const cheminConfig = path.join(racine, 'config', 'config.json');

const faux = await demarrerFauxWebflow(4598);
const configExistante = fs.existsSync(cheminConfig) ? fs.readFileSync(cheminConfig) : null;

fs.mkdirSync(path.dirname(cheminConfig), { recursive: true });
fs.writeFileSync(
  cheminConfig,
  JSON.stringify(
    {
      siteId: 'site1',
      siteNom: 'Etude de Saint-Brieuc',
      collectionId: 'col1',
      collectionNom: 'Biens a vendre',
      champFichePdf: 'fiche-pdf',
      photoLargeurMax: 1600,
    },
    null,
    2
  )
);

const serveur = spawn(process.execPath, [path.join(racine, 'web', 'server.js')], {
  env: {
    ...process.env,
    PORT: '4597',
    WEBFLOW_TOKEN: 'JETON-TEST',
    WEBFLOW_API_BASE: faux.base,
    ANTHROPIC_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
serveur.stderr.on('data', (d) => process.stderr.write('[serveur] ' + d));

const BASE = 'http://127.0.0.1:4597';
await attendreServeur();

const echecs = [];
async function verifier(titre, fonction) {
  try {
    await fonction();
    console.log('  ok   ' + titre);
  } catch (erreur) {
    echecs.push(titre);
    console.log('  ECHEC ' + titre + '\n        ' + erreur.message);
  }
}

async function attendreServeur() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/config');
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("le serveur web n'a pas demarre");
}

console.log('\nInterface locale');

let config;
await verifier('la configuration expose les champs a relire', async () => {
  config = await (await fetch(BASE + '/api/config')).json();
  assert.equal(config.configure, true);
  assert.equal(config.collection, 'Biens a vendre');
  assert.equal(config.lectureAuto, false, 'aucune cle Claude dans ce test');
  const slugs = config.champs.map((c) => c.slug);
  assert.ok(slugs.includes('prix') && slugs.includes('type-de-bien'));
  assert.ok(!slugs.includes('galerie'), 'les champs photos ne sont pas des champs de formulaire');
  assert.deepEqual(config.champsNonGeres, ['Notaire']);
  const option = config.champs.find((c) => c.slug === 'type-de-bien');
  assert.deepEqual(option.options, ['Maison', 'Appartement', 'Terrain']);
});

await verifier('la page se charge', async () => {
  const page = await (await fetch(BASE + '/')).text();
  assert.match(page, /Publication d'un bien/);
  assert.match(page, /Glissez ici la fiche PDF/);
});

let analyse;
await verifier('le depot renvoie les apercus et un identifiant de session', async () => {
  const formulaire = new FormData();
  formulaire.append(
    'fichiers',
    new Blob([fs.readFileSync(path.join(fixtures, 'fiche.pdf'))], { type: 'application/pdf' }),
    'fiche.pdf'
  );
  for (const nom of ['photo-2.jpg', 'photo-1.jpg', 'photo-3.jpg']) {
    formulaire.append(
      'fichiers',
      new Blob([fs.readFileSync(path.join(fixtures, nom))], { type: 'image/jpeg' }),
      nom
    );
  }
  const reponse = await fetch(BASE + '/api/analyse', { method: 'POST', body: formulaire });
  analyse = await reponse.json();
  assert.equal(reponse.status, 200, JSON.stringify(analyse));
  assert.ok(analyse.identifiant);
  assert.equal(analyse.photos.length, 3);
  assert.deepEqual(
    analyse.photos.map((p) => p.nom),
    ['photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg'],
    'les photos sont remises dans l\'ordre naturel'
  );
  assert.ok(analyse.photos[0].apercu.startsWith('data:image/jpeg;base64,'));
  assert.equal(analyse.nomPdf, 'fiche.pdf');
});

await verifier('deux fiches PDF sont refusees avec un message clair', async () => {
  const formulaire = new FormData();
  for (const nom of ['a.pdf', 'b.pdf']) {
    formulaire.append('fichiers', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), nom);
  }
  const reponse = await fetch(BASE + '/api/analyse', { method: 'POST', body: formulaire });
  assert.equal(reponse.status, 400);
  assert.match((await reponse.json()).erreur, /une seule/);
});

await verifier('l\'envoi respecte l\'ordre des photos choisi a l\'ecran', async () => {
  const reponse = await fetch(BASE + '/api/envoyer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifiant: analyse.identifiant,
      fieldData: {
        name: 'Maison 6 pieces - Saint-Brieuc',
        prix: 285000,
        commune: 'Saint-Brieuc',
        'type-de-bien': 'Maison',
      },
      ordrePhotos: [2, 0, 1], // le collaborateur a mis la 3e photo en principale
      publier: false,
    }),
  });
  const resultat = await reponse.json();
  assert.equal(reponse.status, 200, JSON.stringify(resultat));
  assert.equal(resultat.publie, false);
  assert.equal(resultat.photos, 3);

  const item = faux.items.at(-1);
  assert.equal(item.isDraft, true);
  assert.equal(item.fieldData.galerie.length, 3);
  assert.equal(item.fieldData['photo-principale'].url, item.fieldData.galerie[0].url);
  // La photo mise en premier a l'ecran doit etre televersee en premier.
  const media = faux.medias.find((m) => m.id === item.fieldData['photo-principale'].fileId);
  assert.match(media.fileName, /-01\.jpg$/);
});

await verifier('un depot deja envoye ne peut pas etre renvoye en double', async () => {
  const reponse = await fetch(BASE + '/api/envoyer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifiant: analyse.identifiant, fieldData: { name: 'X' }, publier: false }),
  });
  assert.equal(reponse.status, 410);
  assert.match((await reponse.json()).erreur, /expiré/);
});

serveur.kill();
await faux.arreter();
if (configExistante) fs.writeFileSync(cheminConfig, configExistante);
else fs.rmSync(cheminConfig, { force: true });

console.log(`\n${echecs.length ? echecs.length + ' echec(s).' : 'Interface locale : tout est vert.'}\n`);
process.exit(echecs.length ? 1 : 0);
