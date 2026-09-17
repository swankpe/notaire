// Client Claude partage par la lecture des fiches et la redaction des posts.
//
// Une cle d'API non rattachee a un espace de travail exige l'en-tete
// « anthropic-workspace-id » : sans lui, l'API repond 400 et les deux
// fonctions tombent en meme temps.
import Anthropic from '@anthropic-ai/sdk';
import { cleAnthropic } from './config.js';

export function espaceDeTravail() {
  return process.env.ANTHROPIC_WORKSPACE_ID?.trim() || null;
}

export function clientClaude(sujet) {
  const cle = cleAnthropic();
  if (!cle) {
    throw new Error(
      `ANTHROPIC_API_KEY absente : ${sujet} est désactivée. `
      + 'Renseignez la clé dans les variables d\'environnement.'
    );
  }
  const espace = espaceDeTravail();
  return new Anthropic({
    apiKey: cle,
    ...(espace ? { defaultHeaders: { 'anthropic-workspace-id': espace } } : {}),
  });
}

/**
 * Traduit les erreurs de l'API en message actionnable. Les deux cas qui
 * arrivent vraiment sont la cle sans espace de travail et le quota epuise.
 */
export function messageClaude(erreur) {
  const brut = String(erreur?.message ?? erreur);

  if (/workspace/i.test(brut)) {
    return (
      "Votre clé Anthropic n'est rattachée à aucun espace de travail. "
      + 'Deux solutions : créer une clé depuis un espace de travail dans la console '
      + 'Anthropic, ou ajouter la variable ANTHROPIC_WORKSPACE_ID avec l\'identifiant '
      + 'de l\'espace (puis redéployer).'
    );
  }
  if (/credit|quota|billing/i.test(brut)) {
    return 'Le crédit Anthropic est épuisé ou la facturation est en défaut. Vérifiez la console Anthropic.';
  }
  if (/rate.?limit|429/i.test(brut)) {
    return 'Trop de demandes à la suite. Patientez une minute et réessayez.';
  }
  return brut;
}
