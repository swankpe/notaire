// Redaction d'un post Facebook a partir d'un bien deja publie dans le CMS.
//
// Le style vient de config/publication.json : des consignes, et surtout des
// exemples reels. Les exemples pesent plus lourd que les consignes — c'est en
// ajoutant un bon post a la liste qu'on corrige le tir, pas en reecrivant les
// regles.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { racine, cleAnthropic } from './config.js';

const cheminStyle = path.join(racine, 'config', 'publication.json');

const SCHEMA = {
  type: 'object',
  properties: {
    texte: {
      type: 'string',
      description: 'Le post, pret a coller dans Facebook, sauts de ligne compris.',
    },
    remarques: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Ce qui manquait dans la fiche du bien et qui aurait ete utile, ou ce dont "
        + 'le relecteur doit se mefier. Liste vide si tout etait disponible.',
    },
  },
  required: ['texte', 'remarques'],
  additionalProperties: false,
};

export function lireStyle() {
  if (!fs.existsSync(cheminStyle)) {
    return { urlBien: null, consignes: '', exemples: [] };
  }
  try {
    const brut = JSON.parse(fs.readFileSync(cheminStyle, 'utf8'));
    return {
      urlBien: brut.urlBien ?? null,
      consignes: brut.consignes ?? '',
      exemples: Array.isArray(brut.exemples) ? brut.exemples : [],
    };
  } catch {
    return { urlBien: null, consignes: '', exemples: [] };
  }
}

/** Remet des libelles lisibles sur les valeurs du bien, et ecarte le bruit. */
export function decrireBien(structure, item) {
  const fieldData = item?.fieldData ?? {};
  const lignes = [];

  for (const champ of structure.champs) {
    const valeur = fieldData[champ.slug];
    if (valeur === null || valeur === undefined || valeur === '') continue;
    // Les photos et fichiers n'apportent rien a la redaction.
    if (['Image', 'MultiImage', 'File', 'ExtFileRef'].includes(champ.type)) continue;
    if (champ.slug === 'slug') continue;

    const texte =
      typeof valeur === 'object'
        ? JSON.stringify(valeur)
        : String(valeur).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (texte) lignes.push(`${champ.displayName} : ${texte}`);
  }
  return lignes.join('\n');
}

export function lienDuBien(style, item) {
  const slug = item?.fieldData?.slug;
  if (!style.urlBien || !slug) return null;
  return style.urlBien.replace('{slug}', slug);
}

/**
 * @returns {Promise<{texte: string, remarques: string[]}>}
 */
export async function redigerPublication({ structure, item, style, modele }) {
  const cle = cleAnthropic();
  if (!cle) {
    throw new Error(
      'ANTHROPIC_API_KEY absente : la rédaction automatique est désactivée.'
    );
  }

  const client = new Anthropic({ apiKey: cle });
  const lien = lienDuBien(style, item);

  const exemples = style.exemples.length
    ? style.exemples
        .map((e, i) => `Exemple ${i + 1} :\n${e}`)
        .join('\n\n───────────────\n\n')
    : '(aucun exemple fourni)';

  const consignes = `Tu rédiges les publications Facebook d'une étude notariale qui vend des biens
immobiliers. Ton travail est d'imiter fidèlement le style des publications déjà
parues, à partir de la fiche du bien telle qu'elle figure sur le site.

${style.consignes}

Voici des publications réelles de l'étude. Ce sont elles qui font foi pour le
ton, le rythme et la mise en forme :

${exemples}`;

  const details = [
    'Fiche du bien à annoncer :',
    '',
    decrireBien(structure, item) || '(aucune donnée exploitable)',
    '',
    lien ? `Lien vers la fiche : ${lien}` : "Aucun lien disponible : n'invente pas d'adresse, "
      + 'laisse la ligne « Plus d\'informations » sans URL et signale-le dans les remarques.',
  ].join('\n');

  const reponse = await client.messages.create({
    model: modele || 'claude-opus-5',
    max_tokens: 8000,
    system: consignes,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: details }],
  });

  if (reponse.stop_reason === 'refusal') {
    throw new Error("La rédaction n'a pas abouti. Réessayez.");
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

  return {
    texte: resultat.texte ?? '',
    remarques: Array.isArray(resultat.remarques) ? resultat.remarques : [],
  };
}
