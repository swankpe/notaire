// Faux serveur Webflow pour les tests : reproduit les points d'entree utilises
// par l'outil (sites, collections, medias en deux temps, creation d'element).
import express from 'express';

export function demarrerFauxWebflow(port = 4599) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const journal = [];
  const medias = [];
  const items = [];

  // Depot S3 : verifie que les champs de signature precedent bien le binaire.
  app.post('/faux-s3', express.raw({ type: '*/*', limit: '50mb' }), (requete, reponse) => {
    const corps = requete.body.toString('latin1');
    // Attention : « filename="..." » contient « name=" » — d'ou le prefixe exige.
    const champs = [...corps.matchAll(/[;\s]name="([^"]+)"/g)].map((m) => m[1]);
    if (champs[champs.length - 1] !== 'file') {
      return reponse.status(400).send('<Error>le champ file doit etre envoye en dernier</Error>');
    }
    if (!champs.includes('key') || !champs.includes('Policy')) {
      return reponse.status(400).send('<Error>champs de signature manquants</Error>');
    }
    journal.push('POST /faux-s3 (' + champs.join(',') + ')');
    reponse.status(201).send('');
  });

  app.use((requete, reponse, suite) => {
    journal.push(`${requete.method} ${requete.path}`);
    reponse.setHeader('x-ratelimit-limit', '120');
    if (requete.headers.authorization !== 'Bearer JETON-TEST') {
      return reponse.status(401).json({ message: 'Jeton invalide' });
    }
    suite();
  });

  app.get('/v2/sites', (requete, reponse) =>
    reponse.json({ sites: [{ id: 'site1', displayName: 'Etude de Saint-Brieuc', shortName: 'etude' }] })
  );

  app.get('/v2/sites/:site/collections', (requete, reponse) =>
    reponse.json({ collections: [{ id: 'col1', displayName: 'Biens a vendre', slug: 'biens' }] })
  );

  app.get('/v2/collections/:id', (requete, reponse) =>
    reponse.json({
      id: 'col1',
      displayName: 'Biens a vendre',
      slug: 'biens',
      fields: [
        { id: 'f1', slug: 'name', displayName: 'Titre', type: 'PlainText', isRequired: true },
        { id: 'f2', slug: 'slug', displayName: 'Slug', type: 'PlainText', isRequired: true },
        { id: 'f3', slug: 'reference', displayName: 'Reference', type: 'PlainText', isRequired: false },
        { id: 'f4', slug: 'prix', displayName: 'Prix', type: 'Number', isRequired: true },
        { id: 'f5', slug: 'surface', displayName: 'Surface habitable', type: 'Number', isRequired: false },
        { id: 'f6', slug: 'commune', displayName: 'Commune', type: 'PlainText', isRequired: false },
        { id: 'f7', slug: 'descriptif', displayName: 'Descriptif', type: 'RichText', isRequired: false },
        {
          id: 'f8', slug: 'type-de-bien', displayName: 'Type de bien', type: 'Option', isRequired: false,
          validations: { options: [
            { id: 'o1', name: 'Maison' }, { id: 'o2', name: 'Appartement' }, { id: 'o3', name: 'Terrain' },
          ] },
        },
        { id: 'f9', slug: 'dpe', displayName: 'DPE', type: 'PlainText', isRequired: false },
        { id: 'f10', slug: 'vendu', displayName: 'Vendu', type: 'Switch', isRequired: false },
        { id: 'f11', slug: 'photo-principale', displayName: 'Photo principale', type: 'Image', isRequired: false },
        { id: 'f12', slug: 'galerie', displayName: 'Galerie', type: 'MultiImage', isRequired: false },
        { id: 'f13', slug: 'fiche-pdf', displayName: 'Fiche PDF', type: 'File', isRequired: false },
        {
          id: 'f14', slug: 'notaire', displayName: 'Notaire', type: 'Reference', isRequired: false,
          validations: { collectionId: 'col2' },
        },
        {
          id: 'f15', slug: 'quartiers', displayName: 'Quartiers', type: 'MultiReference',
          isRequired: false, validations: { collectionId: 'col2' },
        },
        { id: 'f16', slug: 'couleur', displayName: 'Couleur', type: 'Color', isRequired: false },
      ],
    })
  );

  // La collection referencee par « notaire » et « quartiers ».
  const referencables = [
    { id: 'ref2', fieldData: { name: 'Maitre Zoé Dupont', slug: 'zoe-dupont' } },
    { id: 'ref1', fieldData: { name: 'Maitre Alain Bernard', slug: 'alain-bernard' } },
  ];

  app.get('/v2/collections/:id/items', (requete, reponse) => {
    const lot = requete.params.id === 'col2' ? referencables : items;
    reponse.json({ items: lot, pagination: { total: lot.length } });
  });

  app.post('/v2/sites/:site/assets', (requete, reponse) => {
    const { fileName, fileHash } = requete.body;
    if (!fileName || !fileHash) return reponse.status(400).json({ message: 'fileName et fileHash requis' });
    const id = 'media' + (medias.length + 1);
    medias.push({ id, fileName, fileHash });
    reponse.json({
      id,
      originalFileName: fileName,
      hostedUrl: `https://cdn.test/${id}/${fileName}`,
      assetUrl: `https://s3.test/${id}`,
      uploadUrl: `http://127.0.0.1:${port}/faux-s3`,
      uploadDetails: {
        acl: 'public-read',
        bucket: 'webflow-test',
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': 'test',
        'X-Amz-Date': '20260101T000000Z',
        key: `${id}/${fileName}`,
        Policy: 'eyJ0ZXN0Ijp0cnVlfQ==',
        'X-Amz-Signature': 'signature-de-test',
        'Content-Type': 'image/jpeg',
        success_action_status: '201',
      },
    });
  });

  app.post('/v2/collections/:id/items', (requete, reponse) => {
    const { fieldData, isDraft } = requete.body;
    if (!fieldData?.name || !fieldData?.slug) {
      return reponse.status(400).json({ message: 'name et slug sont obligatoires' });
    }
    // Comme Webflow : une option doit correspondre a un choix connu.
    if (fieldData['type-de-bien'] && !['Maison', 'Appartement', 'Terrain'].includes(fieldData['type-de-bien'])) {
      return reponse.status(400).json({
        message: 'Validation Error',
        details: [`type-de-bien: ${fieldData['type-de-bien']} n'est pas une option valide`],
      });
    }
    const item = { id: 'item' + (items.length + 1), isDraft: Boolean(isDraft), fieldData };
    items.push(item);
    reponse.status(202).json(item);
  });

  app.post('/v2/collections/:id/items/publish', (requete, reponse) =>
    reponse.status(202).json({ publishedItemIds: requete.body.itemIds, errors: [] })
  );

  return new Promise((resoudre) => {
    const serveur = app.listen(port, '127.0.0.1', () =>
      resoudre({
        serveur,
        journal,
        medias,
        items,
        base: `http://127.0.0.1:${port}/v2`,
        arreter: () => new Promise((r) => serveur.close(r)),
      })
    );
  });
}
