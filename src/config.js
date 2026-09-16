// Chargement de la configuration : .env (secrets) + config/config.json (site,
// collection, correspondance des champs). Les deux fichiers ne sont jamais
// versionnes (voir .gitignore).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const cheminConfig = path.join(racine, 'config', 'config.json');

dotenv.config({ path: path.join(racine, '.env'), quiet: true });

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

export function lireConfig() {
  if (!fs.existsSync(cheminConfig)) return { ...CONFIG_PAR_DEFAUT };
  const brut = JSON.parse(fs.readFileSync(cheminConfig, 'utf8'));
  return { ...CONFIG_PAR_DEFAUT, ...brut };
}

export function ecrireConfig(config) {
  fs.mkdirSync(path.dirname(cheminConfig), { recursive: true });
  fs.writeFileSync(cheminConfig, JSON.stringify(config, null, 2) + '\n');
  return config;
}

export function jetonWebflow() {
  const jeton = process.env.WEBFLOW_TOKEN?.trim();
  if (!jeton) {
    throw new Error(
      "WEBFLOW_TOKEN absent. Copiez .env.example vers .env et collez-y votre jeton d'API Webflow."
    );
  }
  return jeton;
}

export function cleAnthropic() {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}
