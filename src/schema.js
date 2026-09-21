// Traduit la structure d'une collection Webflow en schema JSON exploitable par
// Claude, puis reconvertit les valeurs rendues en `fieldData` Webflow.

// Champs remplis automatiquement par l'outil (photos, fiche PDF, slug) ou non
// gerables depuis une fiche papier : on ne les demande pas a Claude.
const TYPES_MEDIA = new Set(['Image', 'MultiImage', 'File', 'ExtFileRef']);
// Les references pointent vers une autre collection : on ne les lit pas dans la
// fiche, on les fait choisir a l'ecran parmi les elements existants.
const TYPES_REFERENCE = new Set(['Reference', 'MultiReference']);
const TYPES_IGNORES = new Set(['Color', 'User', 'SkuValues']);
const SLUGS_IGNORES = new Set(['slug', '_archived', '_draft']);

// Comparaison indulgente : l'utilisateur ecrit « Office » dans la
// configuration, la collection expose le slug « office-notarial » ou le nom
// « Office ». Accents et majuscules ne doivent pas faire echouer la
// correspondance.
const normaliserNom = (texte) =>
  String(texte ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const correspond = (champ, nom) =>
  normaliserNom(champ.slug) === nom || normaliserNom(champ.displayName) === nom;

/**
 * `champsObligatoires` : noms ou slugs que l'etude veut toujours voir remplis,
 * en plus de ceux que Webflow declare obligatoires. Une annonce sans sa ville
 * ou son office ne doit pas partir, meme si Webflow les accepte vides. La liste
 * vient de la configuration, jamais du code : chaque etude a la sienne.
 */
export function analyserCollection(collection, champsObligatoires = []) {
  const exiges = champsObligatoires.map(normaliserNom).filter(Boolean);
  const champs = (collection?.fields ?? [])
    .filter((c) => c?.slug)
    .map((c) => {
      const exigeParEtude = exiges.some((nom) => correspond(c, nom));
      return { ...c, exigeParEtude, obligatoire: Boolean(c.isRequired) || exigeParEtude };
    });
  return {
    id: collection.id,
    nom: collection.displayName,
    slug: collection.slug,
    champs,
    champsImage: champs.filter((c) => c.type === 'Image'),
    champsGalerie: champs.filter((c) => c.type === 'MultiImage'),
    champsFichier: champs.filter((c) => c.type === 'File'),
    champsExtraits: champs.filter(
      (c) =>
        !TYPES_MEDIA.has(c.type) &&
        !TYPES_IGNORES.has(c.type) &&
        !TYPES_REFERENCE.has(c.type) &&
        !SLUGS_IGNORES.has(c.slug)
    ),
    champsReference: champs.filter((c) => TYPES_REFERENCE.has(c.type)),
    champsNonGeres: champs.filter((c) => TYPES_IGNORES.has(c.type)),
  };
}

/**
 * Choisit le champ « photo principale » : preference de config, sinon
 * heuristique. Si le slug configure n'existe pas dans la collection, on
 * retombe sur la detection automatique : mieux vaut une annonce illustree et
 * un avertissement qu'une annonce sans photo, sans que personne le remarque.
 */
export function choisirChampImage(structure, prefere) {
  if (prefere) {
    const exact = structure.champsImage.find((c) => c.slug === prefere);
    if (exact) return exact;
  }
  if (structure.champsImage.length === 0) return null;
  if (structure.champsImage.length === 1) return structure.champsImage[0];
  const indices = ['principal', 'main', 'cover', 'couverture', 'vignette', 'thumbnail', 'une'];
  return (
    structure.champsImage.find((c) =>
      indices.some((i) => c.slug.toLowerCase().includes(i))
    ) ?? structure.champsImage[0]
  );
}

export function choisirChampGalerie(structure, prefere) {
  if (prefere) {
    const exact = structure.champsGalerie.find((c) => c.slug === prefere);
    if (exact) return exact;
  }
  return structure.champsGalerie[0] ?? null;
}

/**
 * Repere le champ « prix » pour l'afficher dans la liste des biens. On ne se
 * rabat jamais sur « le premier champ numerique venu » : ce serait afficher un
 * nombre de pieces en guise de prix.
 */
export function choisirChampPrix(structure, prefere) {
  const nombres = structure.champs.filter((c) => c.type === 'Number');
  if (prefere) {
    const exact = nombres.find((c) => c.slug === prefere);
    if (exact) return exact;
  }
  const indices = ['prix', 'price', 'montant', 'tarif'];
  return (
    nombres.find((c) =>
      indices.some(
        (i) =>
          c.slug.toLowerCase().includes(i) ||
          sansAccent(c.displayName ?? '').includes(i)
      )
    ) ?? null
  );
}

/** Signale un slug configure qui ne correspond a aucun champ de la collection. */
export function reglagesIncoherents(structure, config) {
  const soucis = [];
  const verifier = (slug, liste, quoi) => {
    if (slug && !liste.some((c) => c.slug === slug)) {
      soucis.push(
        `Le champ « ${slug} » configuré pour ${quoi} n'existe pas dans la collection `
        + `« ${structure.nom} ». La détection automatique a pris le relais.`
      );
    }
  };
  verifier(config.champImagePrincipale, structure.champsImage, 'la photo principale');
  verifier(config.champGalerie, structure.champsGalerie, 'la galerie');
  verifier(config.champFichePdf, structure.champsFichier, 'la fiche PDF');

  // Un champ declare obligatoire mais absent de la collection ne bloquerait
  // rien : il passerait inapercu, et l'annonce partirait sans l'information.
  for (const exige of config.champsObligatoires ?? []) {
    const nom = normaliserNom(exige);
    if (nom && !structure.champs.some((c) => correspond(c, nom))) {
      soucis.push(
        `Le champ « ${exige} », déclaré obligatoire, n'existe pas dans la collection `
        + `« ${structure.nom} » : personne ne sera averti s'il reste vide.`
      );
    }
  }
  return soucis;
}

function typeJson(champ) {
  switch (champ.type) {
    case 'Number':
      return { type: ['number', 'null'] };
    case 'Switch':
      return { type: ['boolean', 'null'] };
    case 'Option':
      return {
        type: ['string', 'null'],
        enum: [...(champ.validations?.options ?? []).map((o) => o.name), null],
      };
    case 'DateTime':
      return {
        type: ['string', 'null'],
        description: 'Date au format ISO 8601, par exemple 2026-03-14T00:00:00Z.',
      };
    case 'RichText':
      return {
        type: ['string', 'null'],
        description: 'HTML simple accepté : <p>, <ul>, <li>, <strong>, <br>.',
      };
    default:
      return { type: ['string', 'null'] };
  }
}

/**
 * Construit le schema JSON demande a Claude. Tous les champs sont « requis »
 * mais peuvent valoir null : c'est la facon la plus fiable d'obtenir une reponse
 * complete sans inventer de valeur quand la fiche est muette.
 */
export function schemaExtraction(structure) {
  const properties = {};
  for (const champ of structure.champsExtraits) {
    const base = typeJson(champ);
    const contexte = [
      `Champ Webflow « ${champ.displayName} » (type ${champ.type}).`,
      champ.helpText ? `Aide de l'éditeur : ${champ.helpText}` : null,
      champ.isRequired ? 'Champ obligatoire.' : null,
      base.description ?? null,
    ]
      .filter(Boolean)
      .join(' ');
    properties[champ.slug] = { ...base, description: contexte };
  }

  return {
    type: 'object',
    properties: {
      ...properties,
      _remarques: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Points d'attention pour le relecteur : information absente de la fiche, "
          + 'montant ambigu, mention légale à vérifier. Liste vide si tout est clair.',
      },
    },
    required: [...Object.keys(properties), '_remarques'],
    additionalProperties: false,
  };
}

/** Nettoie la reponse de Claude et la convertit en fieldData Webflow. */
export function versFieldData(structure, extrait) {
  const fieldData = {};
  const avertissements = [];

  for (const champ of structure.champsExtraits) {
    let valeur = extrait?.[champ.slug];
    if (valeur === null || valeur === undefined || valeur === '') continue;

    if (champ.type === 'Number') {
      const nombre = typeof valeur === 'number' ? valeur : nombreDepuisTexte(valeur);
      if (nombre === null) {
        avertissements.push(`« ${champ.displayName} » : « ${valeur} » n'est pas un nombre, champ ignoré.`);
        continue;
      }
      valeur = nombre;
    } else if (champ.type === 'Switch') {
      valeur = Boolean(valeur);
    } else if (champ.type === 'Option') {
      const options = champ.validations?.options ?? [];
      const trouvee = options.find((o) => sansAccent(o.name) === sansAccent(String(valeur)));
      if (!trouvee) {
        avertissements.push(
          `« ${champ.displayName} » : « ${valeur} » ne fait pas partie des choix possibles `
          + `(${options.map((o) => o.name).join(', ')}), champ ignoré.`
        );
        continue;
      }
      valeur = trouvee.name;
    } else if (typeof valeur !== 'string') {
      valeur = String(valeur);
    }

    fieldData[champ.slug] = valeur;
  }

  return { fieldData, avertissements };
}

/**
 * Webflow accepte, selon les collections, le libelle ou l'identifiant d'une
 * option. On prepare la variante « identifiants » pour retenter en cas de refus.
 */
export function variantePourOptions(structure, fieldData) {
  let modifie = false;
  const copie = { ...fieldData };
  for (const champ of structure.champsExtraits) {
    if (champ.type !== 'Option' || !(champ.slug in copie)) continue;
    const option = (champ.validations?.options ?? []).find(
      (o) => sansAccent(o.name) === sansAccent(String(copie[champ.slug]))
    );
    if (option?.id) {
      copie[champ.slug] = option.id;
      modifie = true;
    }
  }
  return modifie ? copie : null;
}

/**
 * « 285 000 EUR » -> 285000, « 4,5 % » -> 4.5, « 142,5 m2 » -> 142.5,
 * « nous consulter » -> null.
 *
 * On extrait le premier nombre au lieu de retirer les caracteres indesirables :
 * un simple filtrage collerait le « 2 » de « m2 » a la valeur, et une surface
 * de 142,5 m2 deviendrait 142,52. Et un texte sans chiffre ne doit surtout pas
 * devenir 0 : sur un prix, l'erreur se verrait en ligne.
 */
function nombreDepuisTexte(valeur) {
  const texte = String(valeur)
    .replace(/[\u202f\u00a0\u2007]/g, ' ') // espaces insecables des PDF
    .replace(/(\d) (?=\d{3}(?:\D|$))/g, '$1'); // separateurs de milliers

  const trouve = texte.match(/-?\d+(?:[.,]\d+)?/);
  if (!trouve) return null;

  const nombre = Number(trouve[0].replace(',', '.'));
  return Number.isFinite(nombre) ? nombre : null;
}

function sansAccent(texte) {
  return String(texte)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export function fabriquerSlug(texte) {
  return sansAccent(texte)
    .replace(/['’]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'bien-' + Date.now().toString(36);
}
