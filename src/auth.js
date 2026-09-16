// Protection par mot de passe : l'outil publie sur le site de l'etude, il ne
// peut pas rester ouvert a qui connait l'adresse.
//
// Le mot de passe vient de la variable MOT_DE_PASSE. La session est un cookie
// signe (HMAC) dont la cle derive du mot de passe : changer le mot de passe
// invalide donc toutes les sessions ouvertes.
import crypto from 'node:crypto';
import { motDePasse, surVercel } from './config.js';

const DUREE_SESSION_MS = 12 * 60 * 60 * 1000;
const NOM_COOKIE = 'notaire_session';

// Ralentissement des essais. En environnement sans etat (Vercel), ce compteur
// ne vaut que pour l'instance courante : c'est un ralentisseur, pas un verrou.
// La vraie protection reste la longueur du mot de passe.
const MAX_ESSAIS = 10;
const BLOCAGE_MS = 15 * 60 * 1000;
let essaisRates = 0;
let blocageJusqua = 0;

export function protectionActive() {
  return Boolean(motDePasse());
}

/** Message d'alerte a afficher au demarrage, ou null si tout va bien. */
export function alerteConfiguration() {
  const secret = motDePasse();
  if (!secret) {
    return surVercel
      ? 'MOT_DE_PASSE absente : le site est accessible a tous. Ajoutez-la dans les variables Vercel.'
      : 'MOT_DE_PASSE absente : aucune protection (acceptable en local, jamais en ligne).';
  }
  if (secret.length < 12) {
    return `Le mot de passe ne fait que ${secret.length} caracteres. Visez-en au moins 16.`;
  }
  return null;
}

function empreinte(texte) {
  return crypto.createHash('sha256').update(texte, 'utf8').digest();
}

function cleDeSignature(secret) {
  return empreinte('notaire-session-v1|' + secret);
}

export function verifierMotDePasse(saisi) {
  const secret = motDePasse();
  if (!secret || typeof saisi !== 'string') return false;
  if (Date.now() < blocageJusqua) return false;

  // Comparaison a duree constante : on compare les empreintes, de longueur fixe.
  const exact = crypto.timingSafeEqual(empreinte(saisi), empreinte(secret));
  if (exact) {
    essaisRates = 0;
    return true;
  }
  essaisRates += 1;
  if (essaisRates >= MAX_ESSAIS) {
    blocageJusqua = Date.now() + BLOCAGE_MS;
    essaisRates = 0;
  }
  return false;
}

export function tropDEssais() {
  return Date.now() < blocageJusqua;
}

export function creerSession() {
  const secret = motDePasse();
  const expiration = String(Date.now() + DUREE_SESSION_MS);
  const signature = crypto
    .createHmac('sha256', cleDeSignature(secret))
    .update(expiration)
    .digest('base64url');
  return `${expiration}.${signature}`;
}

export function sessionValide(valeur) {
  const secret = motDePasse();
  if (!secret || typeof valeur !== 'string') return false;

  const separateur = valeur.lastIndexOf('.');
  if (separateur < 1) return false;
  const expiration = valeur.slice(0, separateur);
  const signature = valeur.slice(separateur + 1);
  if (!/^\d+$/.test(expiration)) return false;

  const attendue = crypto
    .createHmac('sha256', cleDeSignature(secret))
    .update(expiration)
    .digest('base64url');
  if (!crypto.timingSafeEqual(empreinte(signature), empreinte(attendue))) return false;

  return Number(expiration) > Date.now();
}

export function enteteCookie(valeur) {
  const options = [
    `${NOM_COOKIE}=${valeur}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    valeur ? `Max-Age=${Math.floor(DUREE_SESSION_MS / 1000)}` : 'Max-Age=0',
  ];
  if (surVercel) options.push('Secure');
  return options.join('; ');
}

export function lireCookie(entete) {
  if (!entete) return null;
  for (const morceau of entete.split(';')) {
    const [nom, ...reste] = morceau.trim().split('=');
    if (nom === NOM_COOKIE) return reste.join('=');
  }
  return null;
}

/** Middleware Express : laisse passer si la session est valide. */
export function exigerSession(requete, reponse, suite) {
  if (!protectionActive()) return suite(); // usage local sans mot de passe
  if (sessionValide(lireCookie(requete.headers.cookie))) return suite();
  reponse.status(401).json({ erreur: 'Session expirée ou absente.', connexionRequise: true });
}
