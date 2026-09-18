// Client minimal pour la Webflow Data API v2.
// Gere : file d'attente (limite de debit), nouvelles tentatives sur 429/5xx,
// televersement des medias en deux temps (metadonnees Webflow -> depot S3).
import crypto from 'node:crypto';
import { jetonWebflow } from './config.js';

// WEBFLOW_API_BASE n'est utilise que par les tests (faux serveur local).
const BASE = process.env.WEBFLOW_API_BASE || 'https://api.webflow.com/v2';

export class ErreurWebflow extends Error {
  constructor(message, { statut, corps, url } = {}) {
    super(message);
    this.name = 'ErreurWebflow';
    this.statut = statut;
    this.corps = corps;
    this.url = url;
  }
}

// Webflow autorise 60 req/min (offres Starter/Basic) a 120 req/min (CMS et au
// dela). On s'aligne sur le cas le plus strict : 1 requete toutes les ~1,1 s.
let dernierAppel = 0;
let file = Promise.resolve();
let intervalleMs = 1100;

/** Webflow annonce la limite reelle du plan dans ses en-tetes : on s'y ajuste. */
function ajusterCadence(reponse) {
  const limite = Number(reponse.headers.get('x-ratelimit-limit'));
  if (Number.isFinite(limite) && limite > 0) {
    intervalleMs = Math.max(250, Math.ceil((60_000 / limite) * 1.1));
  }
}

function attendre(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function aLaQueue(tache) {
  const resultat = file.then(async () => {
    const ecart = Date.now() - dernierAppel;
    if (ecart < intervalleMs) await attendre(intervalleMs - ecart);
    dernierAppel = Date.now();
    return tache();
  });
  // La file ne doit jamais se rompre sur une erreur applicative.
  file = resultat.then(
    () => undefined,
    () => undefined
  );
  return resultat;
}

async function requete(chemin, { method = 'GET', body, jeton } = {}) {
  const url = chemin.startsWith('http') ? chemin : BASE + chemin;
  const token = jeton || jetonWebflow();

  for (let tentative = 0; ; tentative++) {
    const reponse = await aLaQueue(() =>
      fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    );

    ajusterCadence(reponse);

    if (reponse.status === 429 || reponse.status >= 500) {
      if (tentative < 4) {
        const retryAfter = Number(reponse.headers.get('retry-after'));
        const pause = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2000 * 2 ** tentative;
        await attendre(pause);
        continue;
      }
    }

    const texte = await reponse.text();
    let corps = null;
    try {
      corps = texte ? JSON.parse(texte) : null;
    } catch {
      corps = texte;
    }

    if (!reponse.ok) {
      throw new ErreurWebflow(messageErreur(reponse.status, corps), {
        statut: reponse.status,
        corps,
        url,
      });
    }
    return corps;
  }
}

function messageErreur(statut, corps) {
  const details = corps?.details;
  const suffixe = Array.isArray(details) && details.length
    ? ' — ' + details.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join(' ; ')
    : '';
  const message = corps?.message || corps?.msg || (typeof corps === 'string' ? corps : '');

  if (statut === 401) {
    return `Webflow refuse le jeton (401). Vérifiez WEBFLOW_TOKEN dans .env.${suffixe}`;
  }
  if (statut === 403) {
    return `Webflow refuse l'accès (403) : il manque probablement une portée au jeton `
      + `(cms:read, cms:write, sites:read, assets:write). ${message}${suffixe}`;
  }
  if (statut === 404) {
    return `Ressource Webflow introuvable (404). ${message}${suffixe}`;
  }
  return `Webflow a répondu ${statut}. ${message}${suffixe}`;
}

// ── Sites et collections ──────────────────────────────────────────────────

export async function listerSites(jeton) {
  const r = await requete('/sites', { jeton });
  return r?.sites ?? [];
}

export async function listerCollections(siteId, jeton) {
  const r = await requete(`/sites/${siteId}/collections`, { jeton });
  return r?.collections ?? [];
}

export async function lireCollection(collectionId, jeton) {
  return requete(`/collections/${collectionId}`, { jeton });
}

// ── Elements du CMS ───────────────────────────────────────────────────────

export async function creerItem(collectionId, fieldData, { brouillon = true, jeton } = {}) {
  return requete(`/collections/${collectionId}/items`, {
    method: 'POST',
    jeton,
    body: { isArchived: false, isDraft: brouillon, fieldData },
  });
}

export async function publierItems(collectionId, itemIds, jeton) {
  return requete(`/collections/${collectionId}/items/publish`, {
    method: 'POST',
    jeton,
    body: { itemIds },
  });
}

/**
 * Cherche un element deja en ligne portant ce slug, pour ne pas creer de doublon.
 * On tente d'abord le filtre natif de Webflow, puis on parcourt la collection
 * (5 pages de 100 au maximum) si le filtre n'est pas pris en charge.
 */
export async function chercherItemParSlug(collectionId, slug, jeton) {
  const filtre = await requete(
    `/collections/${collectionId}/items?limit=100&slug=${encodeURIComponent(slug)}`,
    { jeton }
  );
  const trouve = (filtre?.items ?? []).find((i) => i?.fieldData?.slug === slug);
  if (trouve) return trouve;
  if ((filtre?.items ?? []).length <= 1) return null; // le filtre a bien fonctionne

  for (let page = 0; page < 5; page++) {
    const lot = await requete(
      `/collections/${collectionId}/items?limit=100&offset=${page * 100}`,
      { jeton }
    );
    const items = lot?.items ?? [];
    const correspond = items.find((i) => i?.fieldData?.slug === slug);
    if (correspond) return correspond;
    if (items.length < 100) break;
  }
  return null;
}

/**
 * Liste les elements d'une collection, pour alimenter une liste deroulante de
 * champ « Reference ». On s'arrete a 500 : au-dela, une liste deroulante n'est
 * de toute facon plus le bon outil.
 */
export async function listerItems(collectionId, jeton, { tri = 'nom', avecDonnees = false } = {}) {
  const trouves = [];
  for (let page = 0; page < 5; page++) {
    const lot = await requete(
      `/collections/${collectionId}/items?limit=100&offset=${page * 100}`,
      { jeton }
    );
    const items = lot?.items ?? [];
    for (const item of items) {
      trouves.push({
        id: item.id,
        nom: item.fieldData?.name ?? item.fieldData?.slug ?? item.id,
        slug: item.fieldData?.slug ?? null,
        cree: item.createdOn ?? null,
        brouillon: Boolean(item.isDraft),
        ...(avecDonnees ? { donnees: item.fieldData ?? {} } : {}),
      });
    }
    if (items.length < 100) break;
  }

  if (tri === 'recent') {
    // Le bien qu'on veut annoncer est presque toujours le dernier ajoute.
    return trouves.sort((a, b) => String(b.cree ?? '').localeCompare(String(a.cree ?? '')));
  }
  const collateur = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
  return trouves.sort((a, b) => collateur.compare(a.nom, b.nom));
}

/** Lit un element complet, avec toutes ses valeurs de champs. */
export async function lireItem(collectionId, itemId, jeton) {
  return requete(`/collections/${collectionId}/items/${itemId}`, { jeton });
}

// ── Medias ────────────────────────────────────────────────────────────────

/**
 * Televerse un fichier dans la bibliotheque de medias du site.
 * Deux temps : Webflow cree la fiche du media et renvoie une URL S3 pre-signee,
 * puis on y depose le binaire en multipart/form-data.
 */
export async function televerserMedia({ siteId, nomFichier, contenu, typeMime, jeton }) {
  const empreinte = crypto.createHash('md5').update(contenu).digest('hex');

  const media = await requete(`/sites/${siteId}/assets`, {
    method: 'POST',
    jeton,
    body: { fileName: nomFichier, fileHash: empreinte },
  });

  if (!media?.uploadUrl || !media?.uploadDetails) {
    // Le media existait deja (meme empreinte) : Webflow renvoie la fiche sans
    // URL de depot, il n'y a rien a envoyer.
    if (media?.hostedUrl || media?.assetUrl) return normaliserMedia(media);
    throw new ErreurWebflow("Webflow n'a pas renvoyé d'URL de téléversement pour " + nomFichier, {
      corps: media,
    });
  }

  const formulaire = new FormData();
  // L'ordre compte pour S3 : tous les champs de signature d'abord, le binaire en dernier.
  for (const [cle, valeur] of Object.entries(media.uploadDetails)) {
    formulaire.append(cle, String(valeur));
  }
  formulaire.append('file', new Blob([contenu], { type: typeMime }), nomFichier);

  const depot = await fetch(media.uploadUrl, { method: 'POST', body: formulaire });
  if (!depot.ok) {
    const detail = (await depot.text()).slice(0, 500);
    throw new ErreurWebflow(
      `Le dépôt du fichier ${nomFichier} a échoué (${depot.status}). ${detail}`,
      { statut: depot.status }
    );
  }

  return normaliserMedia(media);
}

function normaliserMedia(media) {
  return {
    fileId: media.id,
    url: media.hostedUrl || media.assetUrl,
    nom: media.originalFileName,
  };
}
