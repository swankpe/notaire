// Nomme les photos d'un bien et propose un ordre de passage, pour la video
// diaporama publiee sur Facebook.
//
// La video elle-meme se fabrique dans le navigateur : une requete ne peut pas
// depasser 4,5 Mo sur Vercel, et un fichier video en fait dix fois plus. Ici on
// ne fait que l'analyse — quelques dizaines de kilo-octets de photos a
// l'aller, une liste de titres au retour.
import { clientClaude, messageClaude } from './claude.js';
import {
  choisirChampImage,
  choisirChampGalerie,
  choisirChampPrix,
  choisirChampParNom,
} from './schema.js';
import { preparerPhoto } from './photos.js';

/**
 * Les photos d'un bien, telles qu'elles sont deja sur le site : la photo
 * principale d'abord, puis la galerie. La principale est souvent reprise dans
 * la galerie — on ne la montre pas deux fois.
 */
export function photosDuBien(structure, item, config) {
  const donnees = item?.fieldData ?? {};
  const champImage = choisirChampImage(structure, config.champImagePrincipale);
  const champGalerie = choisirChampGalerie(structure, config.champGalerie);

  const photos = [];
  const vues = new Set();
  const ajouter = (media) => {
    const url = media?.url;
    if (!url || vues.has(url)) return;
    vues.add(url);
    photos.push({ url, nom: media.alt || nomDepuisUrl(url) });
  };

  if (champImage) ajouter(donnees[champImage.slug]);
  for (const media of donnees[champGalerie?.slug] ?? []) ajouter(media);
  return photos;
}

const nomDepuisUrl = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'photo';
  } catch {
    return 'photo';
  }
};

/**
 * Ce qui s'affiche sur l'image d'ouverture : la commune, ce qu'on vend, le
 * prix. Tout est relu dans la fiche du site — un carton d'annonce notariale
 * ne s'invente pas. Un champ absent sort a `null` et la ligne ne s'affiche
 * simplement pas.
 *
 * Les champs sont reconnus a leur intitule, comme le champ prix, et un slug
 * peut etre impose dans la configuration : chaque etude nomme les siens.
 */
/**
 * Un identifiant d'element Webflow : 24 caracteres hexadecimaux. Un champ de
 * reference ne contient que ca, et il n'a rien a faire sur un carton.
 */
const ressembleAUnIdentifiant = (texte) => /^[0-9a-f]{24}$/i.test(String(texte).trim());

const texteUtile = (brut) => {
  if (brut === undefined || brut === null || brut === '') return null;
  if (typeof brut === 'number') return String(brut);
  if (typeof brut !== 'string') return null;
  const texte = brut.trim();
  return texte && !ressembleAUnIdentifiant(texte) ? texte : null;
};

// Du plus precis au plus vague : le premier indice qui trouve un champ gagne.
const INDICES_COMMUNE = ['commune', 'ville', 'localite'];
const INDICES_CODE_POSTAL = ['code postal', 'code-postal', 'codepostal', 'code_postal', 'cp', 'zip', 'postal'];
const INDICES_TYPE = [
  'type de bien', 'type-de-bien', 'type_de_bien', 'nature du bien',
  'categorie', 'type', 'nature',
];

const estUnCodePostal = (valeur) => /^\d{5}$/.test(String(valeur).trim());

/**
 * Cherche le code postal dans la fiche d'une commune. Beaucoup de collections
 * « Villes » le portent en propre ; il n'est pas dans la fiche du bien.
 */
function codePostalDans(fiche) {
  if (!fiche) return null;
  for (const [cle, valeur] of Object.entries(fiche)) {
    const nom = cle.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!INDICES_CODE_POSTAL.some((i) => nom.includes(i))) continue;
    if (typeof valeur === 'number') return String(valeur).padStart(5, '0');
    const texte = texteUtile(valeur);
    if (texte) return texte;
  }
  // Aucun champ ne se nomme ainsi : une valeur a cinq chiffres dans une fiche
  // de commune n'est raisonnablement rien d'autre.
  for (const valeur of Object.values(fiche)) {
    if (estUnCodePostal(valeur)) return String(valeur).trim();
  }
  return null;
}

const sansAccents = (texte) =>
  String(texte ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Cherche le code postal dans les textes de la fiche — descriptif, titre.
 *
 * On ne prend pas n'importe quel groupe de cinq chiffres : un prix ecrit sans
 * separateur en serait un. Seul compte un nombre a cinq chiffres **pose a cote
 * du nom de la commune** : « 22300 Ploumilliau », « Ploumilliau (22300) ».
 * C'est une lecture, pas une deduction.
 */
export function codePostalDansTexte(fiche, commune) {
  if (!commune) return null;
  const cible = sansAccents(commune);
  if (cible.length < 3) return null;

  for (const valeur of Object.values(fiche ?? {})) {
    if (typeof valeur !== 'string') continue;
    // Les balises deviennent des espaces : « <p>22300 Lannion</p> » doit rester lisible.
    const texte = sansAccents(valeur.replace(/<[^>]*>/g, ' '));
    let depuis = 0;
    for (;;) {
      const ou = texte.indexOf(cible, depuis);
      if (ou === -1) break;
      depuis = ou + cible.length;
      const fenetre = texte.slice(Math.max(0, ou - 40), ou + cible.length + 40);
      const trouve = fenetre.match(/(?<!\d)\d{5}(?!\d)/);
      if (trouve) return trouve[0];
    }
  }
  return null;
}

const SCHEMA_CODE_POSTAL = {
  type: 'object',
  additionalProperties: false,
  required: ['codePostal', 'certain'],
  properties: {
    codePostal: {
      type: ['string', 'null'],
      description: 'Cinq chiffres, ou null au moindre doute.',
    },
    certain: {
      type: 'boolean',
      description: 'false des qu il existe plusieurs communes de ce nom en France.',
    },
  },
};

/**
 * Demande le code postal d'une commune a Claude, en dernier recours.
 *
 * Les autres communes de la collection servent de contexte : elles situent le
 * departement, ce qui evite de confondre deux communes homonymes. La reponse
 * reste une **proposition** : elle est presentee a l'utilisateur avant le
 * rendu, jamais incrustee sans relecture.
 */
export async function codePostalSuppose(commune, voisines, options = {}) {
  if (!commune) return null;
  const client = clientClaude('la recherche du code postal');

  let reponse;
  try {
    reponse = await client.messages.create({
      model: options.modele || 'claude-opus-5',
      max_tokens: 500,
      system:
        "Tu donnes le code postal d'une commune francaise. Les autres communes citees "
        + 'appartiennent au meme secteur : elles indiquent le departement. '
        + "Si plusieurs communes portent ce nom en France et que le contexte ne tranche "
        + 'pas, ou si tu as le moindre doute, renvoie null et `certain` a false. '
        + "Une annonce notariale ne peut pas porter un code postal approximatif.",
      output_config: { format: { type: 'json_schema', schema: SCHEMA_CODE_POSTAL } },
      messages: [
        {
          role: 'user',
          content:
            `Commune : ${commune}\n`
            + (voisines?.length
              ? `Autres communes du meme secteur : ${voisines.slice(0, 25).join(', ')}`
              : ''),
        },
      ],
    });
  } catch (erreur) {
    throw new Error(messageClaude(erreur));
  }

  if (reponse.stop_reason === 'refusal') return null;
  const texte = reponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let resultat;
  try {
    resultat = JSON.parse(texte);
  } catch {
    return null;
  }
  const code = String(resultat?.codePostal ?? '').trim();
  return resultat?.certain && /^\d{5}$/.test(code) ? code : null;
}

/**
 * Ce qui s'affiche sur l'image d'ouverture : la commune, son code postal, ce
 * qu'on vend, le prix. Tout est relu dans la fiche du site — un carton
 * d'annonce notariale ne s'invente pas. Un champ introuvable sort a `null`,
 * la ligne ne s'affiche pas, et `manques` dit ce qui a echoue.
 *
 * La commune est souvent un champ de reference : sa valeur est l'identifiant
 * d'un element d'une autre collection. `resoudreReference` rend le nom de cet
 * element **et sa fiche**, ou se trouve souvent le code postal, absent de la
 * fiche du bien.
 */
export async function cartonDuBien(structure, item, config, resoudreReference) {
  const donnees = item?.fieldData ?? {};
  const manques = [];

  const champCommune = choisirChampParNom(structure, config.champCommune, INDICES_COMMUNE);
  const champCodePostal = choisirChampParNom(structure, config.champCodePostal, INDICES_CODE_POSTAL);
  const champType = choisirChampParNom(structure, config.champTypeDeBien, INDICES_TYPE);
  const champPrix = choisirChampPrix(structure, config.champPrix);

  const lire = async (champ) => {
    if (!champ) return { valeur: null, fiche: null };
    const brut = donnees[champ.slug];
    if (champ.type === 'MultiReference') return { valeur: null, fiche: null };
    if (champ.type === 'Reference') {
      const vise = await resoudreReference?.(champ.validations?.collectionId, brut);
      return { valeur: texteUtile(vise?.nom), fiche: vise?.donnees ?? null };
    }
    return { valeur: texteUtile(brut), fiche: null };
  };

  const commune = await lire(champCommune);
  if (!champCommune) manques.push("Aucun champ commune ou ville dans la collection.");
  else if (!commune.valeur) manques.push(`Le champ « ${champCommune.displayName} » est vide pour ce bien.`);

  // Trois sources, de la plus sure a la moins sure. L'origine est rendue avec
  // la valeur : l'ecran dit d'ou elle vient, et ce qui reste a verifier.
  let codePostal = (await lire(champCodePostal)).valeur;
  let origineCodePostal = codePostal ? 'fiche' : null;
  if (!codePostal && (codePostal = codePostalDans(commune.fiche))) origineCodePostal = 'commune';
  if (!codePostal && (codePostal = codePostalDansTexte(donnees, commune.valeur))) {
    origineCodePostal = 'descriptif';
  }

  const type = await lire(champType);
  if (!champType) manques.push("Aucun champ type de bien dans la collection.");
  else if (!type.valeur) manques.push(`Le champ « ${champType.displayName} » est vide pour ce bien.`);

  const prix = donnees[champPrix?.slug];
  if (typeof prix !== 'number') {
    manques.push(champPrix ? `Le champ « ${champPrix.displayName} » est vide pour ce bien.`
      : "Aucun champ prix dans la collection.");
  }

  return {
    commune: commune.valeur,
    codePostal,
    origineCodePostal,
    // « maison » saisi en minuscules doit s'afficher « Maison a vendre ».
    typeDeBien: type.valeur ? type.valeur[0].toUpperCase() + type.valeur.slice(1) : null,
    // Le prix affiche est celui de la fiche, honoraires de negociation
    // compris : c'est le seul que l'etude publie.
    prix: typeof prix === 'number' ? prix : null,
    manques,
  };
}

/**
 * Recupere une photo du site et la remet a la taille voulue.
 *
 * L'URL n'est jamais fournie par l'appelant : elle est relue dans l'element
 * Webflow a chaque fois. Une route qui telechargerait l'adresse qu'on lui
 * passe ferait du serveur un relais vers n'importe quoi.
 */
export async function telechargerPhoto(url, { largeurMax, qualite }) {
  const reponse = await fetch(url);
  if (!reponse.ok) {
    throw new Error(`Photo inaccessible sur le site (${reponse.status}).`);
  }
  const brut = Buffer.from(await reponse.arrayBuffer());
  return preparerPhoto(brut, { largeurMax, qualite });
}

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
