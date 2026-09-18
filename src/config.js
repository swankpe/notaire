// Configuration : secrets dans .env (en local) ou dans les variables
// d'environnement (sur Vercel), reglages dans config/config.json ou, la aussi,
// dans des variables d'environnement.
//
// Sur Vercel le disque est en lecture seule et ephemere : config/config.json
// n'y existe pas. Les variables d'environnement prennent alors le relais.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Reglages non secrets (site, collection, champs) : versionnes, donc deployes
// avec le code. Rien ici ne donne d'acces sans le jeton d'API.
export const cheminConfigPartagee = path.join(racine, 'config', 'webflow.json');
// Surcharge locale, jamais versionnee.
export const cheminConfig = path.join(racine, 'config', 'config.json');

dotenv.config({ path: path.join(racine, '.env'), quiet: true });

export const surVercel = Boolean(process.env.VERCEL);

export const CONFIG_PAR_DEFAUT = {
  siteId: null,
  siteNom: null,
  collectionId: null,
  collectionNom: null,
  // Slug du champ image principale et du champ galerie. `null` = detection auto
  // d'apres le type de champ Webflow (Image / MultiImage).
  champImagePrincipale: null,
  champGalerie: null,
  // Slug d'un champ « File » ou deposer la fiche PDF elle-meme (null = ignore).
  champFichePdf: null,
  // Slug du champ prix, affiche dans la liste des biens. null = detection auto.
  champPrix: null,
  // Consignes libres transmises a Claude pour la lecture des fiches
  // (vocabulaire de l'etude, conventions de redaction, mentions obligatoires...).
  consignes: '',
  // Redimensionnement des photos avant envoi.
  photoLargeurMax: 2400,
  photoQualite: 82,
  // Publier immediatement plutot que de creer un brouillon. Laisser `false` :
  // on relit toujours avant de publier.
  publierParDefaut: false,
  modele: 'claude-opus-5',
};

// Variables d'environnement equivalentes aux reglages du fichier.
const DEPUIS_ENV = {
  siteId: 'WEBFLOW_SITE_ID',
  siteNom: 'WEBFLOW_SITE_NOM',
  collectionId: 'WEBFLOW_COLLECTION_ID',
  collectionNom: 'WEBFLOW_COLLECTION_NOM',
  champImagePrincipale: 'WEBFLOW_CHAMP_IMAGE',
  champGalerie: 'WEBFLOW_CHAMP_GALERIE',
  champFichePdf: 'WEBFLOW_CHAMP_FICHE_PDF',
  champPrix: 'WEBFLOW_CHAMP_PRIX',
  consignes: 'CONSIGNES',
  modele: 'MODELE',
};

function lireFichier(chemin) {
  if (!fs.existsSync(chemin)) return {};
  try {
    return JSON.parse(fs.readFileSync(chemin, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Par ordre de priorite croissante : valeurs par defaut, fichier versionne,
 * surcharge locale, variables d'environnement.
 */
export function lireConfig() {
  const partagee = lireFichier(cheminConfigPartagee);
  const locale = lireFichier(cheminConfig);

  const environnement = {};
  for (const [cle, variable] of Object.entries(DEPUIS_ENV)) {
    const valeur = process.env[variable]?.trim();
    if (valeur) environnement[cle] = valeur;
  }
  for (const [cle, variable] of [
    ['photoLargeurMax', 'PHOTO_LARGEUR_MAX'],
    ['photoQualite', 'PHOTO_QUALITE'],
  ]) {
    const valeur = Number(process.env[variable]);
    if (Number.isFinite(valeur) && valeur > 0) environnement[cle] = valeur;
  }

  return { ...CONFIG_PAR_DEFAUT, ...partagee, ...locale, ...environnement };
}

/** Ecrit les reglages non secrets, ceux qui doivent partir avec le code. */
export function ecrireConfig(config) {
  const aGarder = [
    'siteId', 'siteNom', 'collectionId', 'collectionNom',
    'champImagePrincipale', 'champGalerie', 'champFichePdf', 'champPrix',
    'consignes', 'photoLargeurMax', 'photoQualite', 'modele',
  ];
  const reglages = {};
  for (const cle of aGarder) {
    if (config[cle] !== null && config[cle] !== undefined) reglages[cle] = config[cle];
  }
  fs.mkdirSync(path.dirname(cheminConfigPartagee), { recursive: true });
  fs.writeFileSync(cheminConfigPartagee, JSON.stringify(reglages, null, 2) + '\n');
  return config;
}

/** Les reglages a recopier dans les variables d'environnement Vercel. */
export function configPourVercel(config) {
  const lignes = [];
  for (const [cle, variable] of Object.entries(DEPUIS_ENV)) {
    const valeur = config[cle];
    if (valeur !== null && valeur !== undefined && valeur !== '') {
      lignes.push([variable, String(valeur)]);
    }
  }
  return lignes;
}

/** Le jeton s'il est present, sans lever d'erreur : sert a l'ecran de configuration. */
export function jetonWebflowOptionnel() {
  return process.env.WEBFLOW_TOKEN?.trim() || null;
}

export function jetonWebflow() {
  const jeton = jetonWebflowOptionnel();
  if (!jeton) {
    throw new Error(
      surVercel
        ? "WEBFLOW_TOKEN absent des variables d'environnement Vercel (Settings → Environment Variables)."
        : "WEBFLOW_TOKEN absent. Copiez .env.example vers .env et collez-y votre jeton d'API Webflow."
    );
  }
  return jeton;
}

export function cleAnthropic() {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

export function motDePasse() {
  return process.env.MOT_DE_PASSE?.trim() || null;
}
