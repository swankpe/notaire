// Nomme les photos d'un bien et propose un ordre de passage, pour la video
// diaporama publiee sur Facebook.
//
// La video elle-meme se fabrique dans le navigateur : une requete ne peut pas
// depasser 4,5 Mo sur Vercel, et un fichier video en fait dix fois plus. Ici on
// ne fait que l'analyse — quelques dizaines de kilo-octets de photos a
// l'aller, une liste de titres au retour.
import { clientClaude, messageClaude } from './claude.js';

const CONSIGNES = `Tu prepares une video diaporama pour l'annonce immobiliere d'une etude notariale.

On te donne les photos d'un bien, numerotees a partir de 0 dans l'ordre ou elles
ont ete deposees. Pour chacune, donne un titre court qui sera incruste a l'ecran,
et remets l'ensemble dans un ordre de visite naturel.

Le titre :
- un ou deux mots, sans article ni ponctuation. Dans la maison : « Entree »,
  « Sejour », « Cuisine », « Salle a manger », « Chambre », « Salle de bain »,
  « Bureau », « Buanderie », « Cave », « Combles », « Veranda ». Autour :
  « Facade », « Jardin », « Terrasse », « Cour », « Terrain », « Vue ». Les
  annexes, frequentes sur ces biens : « Grange », « Dependance », « Hangar »,
  « Appentis », « Atelier », « Garage », « Puits », « Longere ».
- une majuscule au premier mot seulement.
- deux photos de la meme piece portent le meme titre : l'ordre les regroupe.
- si la photo ne montre rien d'identifiable, ou si tu hesites, laisse le titre
  vide. Une video sans texte sur une image vaut mieux qu'un titre faux : c'est
  une annonce notariale, pas une illustration.

Beaucoup de ces biens sont a renover : pieces vides, murs abimes, batiments
envahis par la vegetation, terrain en friche. C'est normal, ce n'est pas une
raison pour renoncer au titre. Une piece vide reste une piece : on la nomme par
ce qu'elle est (cheminee et volume = sejour, evier ou hotte = cuisine, porte
d'entree = entree). En revanche on ne promet rien : jamais « Cuisine amenagee »
ni « Beau sejour », le titre nomme, il ne vend pas.

L'ordre de visite : on arrive par l'exterieur (facade), on entre, on traverse
les pieces de vie (sejour, cuisine, salle a manger), puis les chambres et salles
de bain, puis on ressort (terrasse, jardin), puis les annexes (grange,
dependance, hangar) et le terrain. Une vue remarquable termine bien une video.

Renvoie chaque photo une fois et une seule, dans l'ordre choisi.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plans', 'remarques'],
  properties: {
    plans: {
      type: 'array',
      description: "Les photos dans l'ordre de passage retenu.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['photo', 'titre'],
        properties: {
          photo: { type: 'integer', description: 'Numero de la photo fournie, a partir de 0.' },
          titre: { type: 'string', description: 'Titre incruste, ou chaine vide si incertain.' },
        },
      },
    },
    remarques: {
      type: 'array',
      description: "Ce qui merite l'oeil de l'utilisateur : photo floue, doublon, piece indevinable.",
      items: { type: 'string' },
    },
  },
};

/**
 * Remet la liste d'aplomb : chaque photo une fois, aucune inventee.
 *
 * Un modele peut oublier une photo ou en citer une deux fois. Laisser passer
 * reviendrait a fabriquer une video amputee sans que personne le remarque —
 * on complete plutot, et on le dit.
 */
export function ordonnerPlans(plans, nombre) {
  const retenus = [];
  const vus = new Set();
  const remarques = [];

  for (const plan of plans ?? []) {
    const photo = Number(plan?.photo);
    if (!Number.isInteger(photo) || photo < 0 || photo >= nombre || vus.has(photo)) continue;
    vus.add(photo);
    retenus.push({ photo, titre: String(plan.titre ?? '').trim() });
  }

  const oubliees = [];
  for (let photo = 0; photo < nombre; photo++) {
    if (vus.has(photo)) continue;
    oubliees.push(photo + 1);
    retenus.push({ photo, titre: '' });
  }
  if (oubliees.length) {
    remarques.push(
      `Photo(s) ${oubliees.join(', ')} : aucun titre proposé, ajoutée(s) à la fin sans texte.`
    );
  }
  return { plans: retenus, remarques };
}

/**
 * @param {Buffer[]} images  photos reduites, dans l'ordre de depot
 * @param {object} options   { modele, consignes }
 */
export async function nommerLesPieces(images, options = {}) {
  if (!images.length) throw new Error('Aucune photo à analyser.');

  const client = clientClaude('la reconnaissance des pièces');
  const consignesEtude = options.consignes?.trim()
    ? `\n\nConsignes propres à l'étude :\n${options.consignes.trim()}`
    : '';

  let reponse;
  try {
    reponse = await client.messages.create({
      model: options.modele || 'claude-opus-5',
      max_tokens: 4000,
      system: CONSIGNES + consignesEtude,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            ...images.map((image) => ({
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') },
            })),
            {
              type: 'text',
              text:
                `Voici les ${images.length} photos du bien, numérotées de 0 à ${images.length - 1} `
                + "dans l'ordre d'affichage.",
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
      "Claude n'a pas traité ces photos (" + (reponse.stop_details?.category ?? 'refus') + '). '
      + 'Saisissez les titres à la main.'
    );
  }

  const texte = reponse.content
    .filter((bloc) => bloc.type === 'text')
    .map((bloc) => bloc.text)
    .join('');

  let resultat;
  try {
    resultat = JSON.parse(texte);
  } catch {
    throw new Error("La réponse n'est pas exploitable. Réessayez.");
  }

  const { plans, remarques } = ordonnerPlans(resultat.plans, images.length);
  return { plans, remarques: [...(resultat.remarques ?? []), ...remarques] };
}
