// Test de l'interface : faux Webflow + serveur web, puis le parcours complet
// connexion -> lecture -> slug -> photos une par une -> creation.
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

const MOT_DE_PASSE = 'mot-de-passe-de-test-suffisamment-long';
const faux = await demarrerFauxWebflow(4598);
const configExistante = fs.existsSync(cheminConfig) ? fs.readFileSync(cheminConfig) : null;
if (configExistante) fs.rmSync(cheminConfig);

const serveur = spawn(process.execPath, [path.join(racine, 'server.js')], {
  env: {
    ...process.env,
    PORT: '4597',
    WEBFLOW_TOKEN: 'JETON-TEST',
    WEBFLOW_API_BASE: faux.base,
    // La configuration passe par l'environnement, comme sur Vercel.
    WEBFLOW_SITE_ID: 'site1',
    WEBFLOW_SITE_NOM: 'Etude de Saint-Brieuc',
    WEBFLOW_COLLECTION_ID: 'col1',
    WEBFLOW_COLLECTION_NOM: 'Biens a vendre',
    WEBFLOW_CHAMP_FICHE_PDF: 'fiche-pdf',
    PHOTO_LARGEUR_MAX: '1600',
    MOT_DE_PASSE,
    ANTHROPIC_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
serveur.stderr.on('data', (d) => process.stderr.write('[serveur] ' + d));

const BASE = 'http://127.0.0.1:4597';
let cookie = '';

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

async function appel(chemin, options = {}) {
  const reponse = await fetch(BASE + chemin, {
    ...options,
    headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  const miam = reponse.headers.get('set-cookie');
  if (miam) cookie = miam.split(';')[0];
  return { statut: reponse.status, corps: await reponse.json().catch(() => ({})) };
}

for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(BASE + '/api/session')).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const fichier = (nom, type) =>
  new Blob([fs.readFileSync(path.join(fixtures, nom))], { type });

console.log('\nProtection par mot de passe');

await verifier('les routes sont fermees sans session', async () => {
  for (const chemin of ['/api/config', '/api/analyse', '/api/slug', '/api/media', '/api/creer']) {
    const { statut, corps } = await appel(chemin, { method: 'POST' });
    assert.equal(statut, 401, chemin + ' devrait etre ferme');
    assert.equal(corps.connexionRequise, true);
  }
});

await verifier('la page annonce que le site est protege', async () => {
  const { corps } = await appel('/api/session');
  assert.equal(corps.protege, true);
});

await verifier('un mauvais mot de passe est refuse', async () => {
  const { statut, corps } = await appel('/api/connexion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ motDePasse: 'raté' }),
  });
  assert.equal(statut, 401);
  assert.match(corps.erreur, /incorrect/);
  assert.equal(cookie, '', 'aucun cookie ne doit etre pose');
});

await verifier('le bon mot de passe ouvre une session', async () => {
  const { statut } = await appel('/api/connexion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ motDePasse: MOT_DE_PASSE }),
  });
  assert.equal(statut, 200);
  assert.match(cookie, /^notaire_session=/);
});

console.log('\nParcours de publication');

let config;
await verifier('la configuration vient des variables d\'environnement', async () => {
  const { statut, corps } = await appel('/api/config');
  assert.equal(statut, 200);
  config = corps;
  assert.equal(config.configure, true);
  assert.equal(config.site, 'Etude de Saint-Brieuc');
  assert.equal(config.collection, 'Biens a vendre');
  assert.equal(config.fichePdfActivee, true);
  assert.equal(config.photoLargeurMax, 1600);
  assert.equal(config.lectureAuto, false);
  const slugs = config.champs.map((c) => c.slug);
  assert.ok(slugs.includes('prix'));
  assert.ok(!slugs.includes('galerie'), 'les champs photos ne sont pas des champs de formulaire');
  assert.deepEqual(config.champsNonGeres, ['Notaire']);
});

await verifier('la page se charge', async () => {
  const page = await (await fetch(BASE + '/')).text();
  assert.match(page, /Publication d'un bien/);
  assert.match(page, /Accès réservé/);
  assert.match(page, /noindex/, 'la page ne doit pas etre indexee');
});

await verifier('la fiche PDF est lue seule, sans les photos', async () => {
  const formulaire = new FormData();
  formulaire.append('fiche', fichier('fiche.pdf', 'application/pdf'), 'fiche.pdf');
  const { statut, corps } = await appel('/api/analyse', { method: 'POST', body: formulaire });
  assert.equal(statut, 200, JSON.stringify(corps));
  assert.equal(corps.fieldData.name, 'Nouveau bien');
  assert.ok(corps.avertissements.some((a) => /ANTHROPIC_API_KEY/.test(a)));
});

let slug;
await verifier('le slug est arrete avant l\'envoi des photos', async () => {
  const { statut, corps } = await appel('/api/slug', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fieldData: { name: 'Maison 6 pièces — Saint-Brieuc' } }),
  });
  assert.equal(statut, 200);
  slug = corps.slug;
  assert.equal(slug, 'maison-6-pieces-saint-brieuc');
  assert.equal(corps.renomme, false);
});

await verifier('un titre absent est refuse', async () => {
  const { statut } = await appel('/api/slug', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fieldData: {} }),
  });
  assert.equal(statut, 400);
});

const medias = [];
await verifier('les photos partent une par une, nommees selon leur rang', async () => {
  // Le collaborateur a mis photo-3 en principale.
  for (const [index, nom] of ['photo-3.jpg', 'photo-1.jpg', 'photo-2.jpg'].entries()) {
    const formulaire = new FormData();
    formulaire.append('fichier', fichier(nom, 'image/jpeg'), nom);
    formulaire.append('slug', slug);
    formulaire.append('index', String(index));
    const { statut, corps } = await appel('/api/media', { method: 'POST', body: formulaire });
    assert.equal(statut, 200, JSON.stringify(corps));
    medias.push(corps);
  }
  assert.equal(medias.length, 3);
  const noms = faux.medias.slice(-3).map((m) => m.fileName);
  assert.deepEqual(noms, [
    'maison-6-pieces-saint-brieuc-01.jpg',
    'maison-6-pieces-saint-brieuc-02.jpg',
    'maison-6-pieces-saint-brieuc-03.jpg',
  ]);
});

await verifier('un fichier illisible est refuse sans casser l\'envoi', async () => {
  const formulaire = new FormData();
  formulaire.append('fichier', new Blob([Buffer.from('pas une image')], { type: 'image/jpeg' }), 'cassee.jpg');
  formulaire.append('slug', slug);
  formulaire.append('index', '9');
  const { statut, corps } = await appel('/api/media', { method: 'POST', body: formulaire });
  assert.equal(statut, 422, 'un code distinct pour « on continue sans cette photo »');
  assert.match(corps.erreur, /cassee\.jpg/);
});

let mediaPdf;
await verifier('la fiche PDF est jointe comme fichier', async () => {
  const formulaire = new FormData();
  formulaire.append('fichier', fichier('fiche.pdf', 'application/pdf'), 'fiche.pdf');
  formulaire.append('slug', slug);
  formulaire.append('type', 'pdf');
  const { statut, corps } = await appel('/api/media', { method: 'POST', body: formulaire });
  assert.equal(statut, 200, JSON.stringify(corps));
  mediaPdf = corps;
  assert.match(faux.medias.at(-1).fileName, /\.pdf$/);
});

await verifier('l\'annonce est creee en brouillon, photos dans l\'ordre choisi', async () => {
  const { statut, corps } = await appel('/api/creer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fieldData: {
        name: 'Maison 6 pièces — Saint-Brieuc',
        prix: 285000,
        commune: 'Saint-Brieuc',
        'type-de-bien': 'Maison',
      },
      slug,
      medias,
      mediaPdf,
      publier: false,
    }),
  });
  assert.equal(statut, 200, JSON.stringify(corps));
  assert.equal(corps.publie, false);
  assert.equal(corps.photos, 3);

  const item = faux.items.at(-1);
  assert.equal(item.isDraft, true);
  assert.equal(item.fieldData.slug, slug);
  assert.equal(item.fieldData.galerie.length, 3);
  assert.equal(item.fieldData['photo-principale'].url, item.fieldData.galerie[0].url);
  assert.match(item.fieldData['photo-principale'].url, /-01\.jpg$/);
  assert.ok(item.fieldData['fiche-pdf'].url.endsWith('.pdf'));
});

await verifier('aucun etat serveur n\'est necessaire entre les etapes', async () => {
  // On rejoue une creation complete sans avoir rappele /api/analyse :
  // le serveur ne garde rien, chaque requete se suffit a elle-meme.
  const { corps: reserve } = await appel('/api/slug', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fieldData: { name: 'Longère à Plouha' } }),
  });
  const { statut, corps } = await appel('/api/creer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fieldData: { name: 'Longère à Plouha', prix: 198000 },
      slug: reserve.slug,
      medias: [],
      publier: false,
    }),
  });
  assert.equal(statut, 200, JSON.stringify(corps));
  assert.equal(corps.slug, 'longere-a-plouha');
});

await verifier('la deconnexion ferme la session', async () => {
  await appel('/api/deconnexion', { method: 'POST' });
  cookie = 'notaire_session=';
  const { statut } = await appel('/api/config');
  assert.equal(statut, 401);
});

serveur.kill();
await faux.arreter();
if (configExistante) fs.writeFileSync(cheminConfig, configExistante);

console.log(`\n${echecs.length ? echecs.length + ' echec(s).' : 'Interface : tout est vert.'}\n`);
process.exit(echecs.length ? 1 : 0);
