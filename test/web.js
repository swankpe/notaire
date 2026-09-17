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
// Les reglages versionnes du depot ne doivent pas influencer les tests :
// on les met de cote le temps de l'execution.
const cheminPartage = path.join(racine, 'config', 'webflow.json');
const partageExistant = fs.existsSync(cheminPartage) ? fs.readFileSync(cheminPartage) : null;
if (partageExistant) fs.rmSync(cheminPartage);
const rendreReglages = () => {
  if (partageExistant) fs.writeFileSync(cheminPartage, partageExistant);
};
process.on('exit', rendreReglages);

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
  assert.ok(!slugs.includes('notaire'), 'les references ont leur propre liste');
  assert.deepEqual(config.champsNonGeres, ['Couleur']);
  assert.deepEqual(config.champsReference, [
    {
      slug: 'notaire',
      libelle: 'Notaire',
      type: 'Reference',
      obligatoire: false,
      collectionReferencee: 'col2',
    },
    {
      slug: 'quartiers',
      libelle: 'Quartiers',
      type: 'MultiReference',
      obligatoire: false,
      collectionReferencee: 'col2',
    },
  ]);
});

await verifier('les listes deroulantes de reference sont alimentees', async () => {
  const { statut, corps } = await appel('/api/references?collectionId=col2');
  assert.equal(statut, 200);
  assert.deepEqual(corps.items, [
    { id: 'ref1', nom: 'Maitre Alain Bernard' },
    { id: 'ref2', nom: 'Maitre Zoé Dupont' },
  ]);

  const sansCollection = await appel('/api/references');
  assert.equal(sansCollection.statut, 400);
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
        notaire: 'ref1',
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
  assert.equal(item.fieldData.notaire, 'ref1', "la reference choisie a l'ecran est enregistree");
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

console.log('\nPublication Facebook');

await verifier('la liste des biens est servie, du plus recent au plus ancien', async () => {
  const { statut, corps } = await appel('/api/biens');
  assert.equal(statut, 200);
  assert.ok(corps.biens.length >= 2, 'les annonces creees plus haut doivent apparaitre');
  assert.ok(corps.biens.every((b) => b.id && b.nom));
  assert.ok(corps.biens.some((b) => b.brouillon), 'le statut brouillon est signale');
});

await verifier('la redaction exige un bien', async () => {
  const { statut, corps } = await appel('/api/publication', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(statut, 400);
  assert.match(corps.erreur, /bien/);
});

await verifier('sans cle Claude, la redaction remonte un message clair', async () => {
  const premier = (await appel('/api/biens')).corps.biens[0];
  const { statut, corps } = await appel('/api/publication', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: premier.id }),
  });
  assert.equal(statut, 500);
  assert.match(corps.erreur, /ANTHROPIC_API_KEY/);
});

await verifier('la deconnexion ferme la session', async () => {
  await appel('/api/deconnexion', { method: 'POST' });
  cookie = 'notaire_session=';
  const { statut } = await appel('/api/config');
  assert.equal(statut, 401);
});

console.log('\nEcran de configuration');

await verifier('sans collection choisie, l\'outil bascule en configuration', async () => {
  const nu = spawn(process.execPath, [path.join(racine, 'server.js')], {
    env: {
      ...process.env,
      PORT: '4593',
      WEBFLOW_TOKEN: 'JETON-TEST',
      WEBFLOW_API_BASE: faux.base,
      WEBFLOW_SITE_ID: '',
      WEBFLOW_COLLECTION_ID: '',
      MOT_DE_PASSE,
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const base = 'http://127.0.0.1:4593';
  let biscuit = '';
  const joindre = async (chemin, options = {}) => {
    const r = await fetch(base + chemin, {
      ...options,
      headers: { ...(options.headers ?? {}), ...(biscuit ? { cookie: biscuit } : {}) },
    });
    const pose = r.headers.get('set-cookie');
    if (pose) biscuit = pose.split(';')[0];
    return { statut: r.status, corps: await r.json().catch(() => ({})) };
  };

  try {
    let pret = false;
    for (let i = 0; i < 60 && !pret; i++) {
      try {
        pret = (await fetch(base + '/api/session')).ok;
      } catch {}
      if (!pret) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(pret, "le serveur de configuration n'a pas demarre");

    await joindre('/api/connexion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ motDePasse: MOT_DE_PASSE }),
    });

    const config = await joindre('/api/config');
    assert.equal(config.corps.configure, false);
    assert.equal(config.corps.jetonPresent, true, 'le jeton doit etre signale present');

    const sites = await joindre('/api/sites');
    assert.equal(sites.statut, 200);
    assert.deepEqual(sites.corps.sites, [
      { id: 'site1', nom: 'Etude de Saint-Brieuc', raccourci: 'etude' },
    ]);

    const collections = await joindre('/api/collections?siteId=site1');
    assert.equal(collections.statut, 200);
    assert.equal(collections.corps.collections[0].id, 'col1');

    const sansSite = await joindre('/api/collections');
    assert.equal(sansSite.statut, 400);

    const reglages = await joindre(
      '/api/reglages?siteId=site1&siteNom=Etude%20de%20Saint-Brieuc&collectionId=col1'
    );
    assert.equal(reglages.statut, 200);
    const variables = Object.fromEntries(reglages.corps.variables);
    assert.equal(variables.WEBFLOW_SITE_ID, 'site1');
    assert.equal(variables.WEBFLOW_COLLECTION_ID, 'col1');
    assert.equal(variables.WEBFLOW_COLLECTION_NOM, 'Biens a vendre');
    assert.equal(variables.WEBFLOW_CHAMP_IMAGE, 'photo-principale');
    assert.equal(variables.WEBFLOW_CHAMP_GALERIE, 'galerie');
    assert.ok(!('MODELE' in variables), 'le modele par defaut ne doit pas encombrer la liste');
    assert.deepEqual(reglages.corps.champsFichier, [{ slug: 'fiche-pdf', libelle: 'Fiche PDF' }]);
    assert.deepEqual(reglages.corps.champsReference, ['Notaire', 'Quartiers']);
    assert.deepEqual(reglages.corps.champsNonGeres, ['Couleur']);
  } finally {
    nu.kill();
  }
});

await verifier('les routes de configuration sont aussi fermees sans session', async () => {
  for (const chemin of [
    '/api/sites',
    '/api/collections?siteId=site1',
    '/api/reglages',
    '/api/references?collectionId=col2',
    '/api/biens',
  ]) {
    const reponse = await fetch(BASE + chemin);
    assert.equal(reponse.status, 401, chemin + ' devrait etre ferme');
  }
});

console.log('\nGarde-fou en ligne');

await verifier('en ligne sans mot de passe, l\'outil refuse de servir', async () => {
  // Sur Vercel, une variable ajoutee apres coup n'est prise en compte qu'au
  // deploiement suivant : l'outil doit echouer bruyamment, pas s'ouvrir.
  const nu = spawn(process.execPath, [path.join(racine, 'server.js')], {
    env: {
      ...process.env,
      PORT: '4594',
      VERCEL: '1',
      WEBFLOW_TOKEN: 'JETON-TEST',
      WEBFLOW_API_BASE: faux.base,
      WEBFLOW_SITE_ID: 'site1',
      WEBFLOW_COLLECTION_ID: 'col1',
      MOT_DE_PASSE: '',
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let journal = '';
  nu.stderr.on('data', (d) => (journal += d));

  try {
    let pret = false;
    for (let i = 0; i < 60 && !pret; i++) {
      try {
        pret = (await fetch('http://127.0.0.1:4594/api/session')).ok;
      } catch {}
      if (!pret) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(pret, "le serveur de controle n'a pas demarre");

    for (const chemin of ['/api/config', '/api/slug', '/api/media', '/api/creer']) {
      const reponse = await fetch('http://127.0.0.1:4594' + chemin, { method: 'POST' });
      assert.equal(reponse.status, 503, chemin + ' devrait etre refuse');
      assert.match((await reponse.json()).erreur, /MOT_DE_PASSE/);
    }
    assert.match(journal, /ATTENTION/, 'la mise en garde doit apparaitre dans les journaux');
  } finally {
    nu.kill();
  }
});

serveur.kill();
await faux.arreter();
if (configExistante) fs.writeFileSync(cheminConfig, configExistante);

console.log(`\n${echecs.length ? echecs.length + ' echec(s).' : 'Interface : tout est vert.'}\n`);
process.exit(echecs.length ? 1 : 0);
