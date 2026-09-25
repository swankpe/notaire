// Lecture de la fiche PDF : la fiche est transmise telle quelle a Claude
// (y compris si elle est scannee) et revient sous forme de champs structures,
// calques sur la collection Webflow.
import { cleAnthropic } from './config.js';
import { clientClaude, messageClaude } from './claude.js';
import { schemaExtraction } from './schema.js';

const TAILLE_MAX_PDF = 28 * 1024 * 1024; // marge sous la limite de 32 Mo par requete

const CONSIGNES = `Tu assistes le collaborateur d'une étude notariale qui met en ligne les biens
immobiliers à vendre sur le site de l'étude.

À partir de la fiche fournie, remplis exactement les champs demandés.

Règles impératives :
- N'invente jamais une information. Si la fiche ne la donne pas, mets null.
- Recopie les montants, surfaces et références exactement tels qu'ils figurent
  sur la fiche. Les prix sont en euros ; pour un champ numérique, ne renvoie que
  le nombre, sans symbole ni séparateur de milliers.
- **Le prix à retenir est celui honoraires de négociation inclus.** Une fiche
  notariale en porte souvent plusieurs : prix net vendeur, honoraires de
  négociation, prix hors honoraires, « FAI », « honoraires inclus », « HNI ».
  C'est le prix total payé par l'acquéreur — le plus élevé des deux, celui qui
  comprend les honoraires — qui va dans le champ prix. Le net vendeur ne doit
  jamais s'y retrouver : il ferait afficher sur le site un prix inférieur à la
  réalité. Si la fiche ne permet pas de trancher, mets null et dis-le dans
  « _remarques » plutôt que de choisir au hasard.
- Le champ « nom » (name) est le titre de l'annonce sur le site : court et
  explicite, du type « Maison 5 pièces - Saint-Brieuc ». S'il est déjà donné
  dans la fiche, garde le libellé de la fiche.
- Pour une description ou un texte riche, rédige en français soigné, au présent,
  sans superlatif commercial excessif, en reprenant fidèlement les éléments de la
  fiche. Structure en courts paragraphes <p>.
- Les mentions réglementaires (DPE, GES, honoraires, charge des honoraires,
  copropriété, nombre de lots, procédure en cours, montant des charges) doivent
  être reprises à l'identique : elles engagent l'étude.
- Signale dans « _remarques » tout ce qui manque, tout montant ambigu et toute
  mention légale à vérifier avant publication.`;

export function extractionDisponible() {
  return Boolean(cleAnthropic());
}

/**
 * @param {{pdf?: Buffer, images?: Buffer[]}} source  la fiche, en PDF ou en pages
 *   deja converties en images par le navigateur quand le PDF depassait la
 *   limite de taille d'une requete
 * @param {object} structure        resultat de analyserCollection()
 * @param {object} options          { consignes, modele, texteSecours }
 * @returns {Promise<{extrait: object, remarques: string[], usage: object}>}
 */
export async function lireFiche(source, structure, options = {}) {
  const { pdf = null, images = [] } = source instanceof Uint8Array ? { pdf: source } : (source ?? {});

  if (!cleAnthropic()) {
    throw new Error(
      'ANTHROPIC_API_KEY absente : la lecture automatique de la fiche est désactivée. '
      + "Renseignez la clé dans .env, ou saisissez les champs à la main dans l'écran de relecture."
    );
  }
  const poids = (pdf?.length ?? 0) + images.reduce((t, i) => t + i.length, 0);
  if (poids > TAILLE_MAX_PDF) {
    throw new Error(
      `La fiche fait ${(poids / 1024 / 1024).toFixed(1)} Mo, au-delà de la limite `
      + 'de lecture automatique (28 Mo). Allégez-la ou saisissez les champs à la main.'
    );
  }

  const client = clientClaude('la lecture automatique de la fiche');
  const schema = schemaExtraction(structure);

  const consignesEtude = options.consignes?.trim()
    ? `\n\nConsignes propres à l'étude :\n${options.consignes.trim()}`
    : '';

  let reponse;
  try {
    reponse = await client.messages.create({
    model: options.modele || 'claude-opus-5',
    max_tokens: 16000,
    system: CONSIGNES + consignesEtude,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [
      {
        role: 'user',
        content: [
          // Soit le PDF d'origine, soit ses pages converties en images : Claude
          // lit les deux, et une fiche scannee est de toute facon une image.
          ...(pdf
            ? [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: pdf.toString('base64'),
                  },
                },
              ]
            : images.map((image) => ({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: image.toString('base64'),
                },
              }))),
          {
            type: 'text',
            text:
              'Voici la fiche du bien'
              + (images.length ? ` (${images.length} page(s))` : '')
              + `. Remplis les champs de la collection Webflow « ${structure.nom} ».`,
          },
        ],
      },
    ],
    });
  } catch (erreur) {
    throw new Error(messageClaude(erreur));
  }

  if (reponse.stop_reason === 'refusal') {
    throw new Error(
      "Claude n'a pas traité cette fiche (" + (reponse.stop_details?.category ?? 'refus') + '). '
      + "Saisissez les champs à la main dans l'écran de relecture."
    );
  }

  const texte = reponse.content
    .filter((bloc) => bloc.type === 'text')
    .map((bloc) => bloc.text)
    .join('');

  let extrait;
  try {
    extrait = JSON.parse(texte);
  } catch {
    throw new Error("La réponse de lecture de la fiche n'est pas exploitable. Réessayez.");
  }

  const remarques = Array.isArray(extrait._remarques) ? extrait._remarques : [];
  delete extrait._remarques;

  return { extrait, remarques, usage: reponse.usage };
}
