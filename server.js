// Point d'entree unique : en local (npm start) comme sur Vercel, qui detecte
// automatiquement un server.js a la racine et route les requetes vers lui.
import { creerApplication } from './web/app.js';
import { lireConfig, cleAnthropic, racine, surVercel } from './src/config.js';
import { alerteConfiguration } from './src/auth.js';

const app = creerApplication();
const port = Number(process.env.PORT) || 4000;

app.listen(port, surVercel ? undefined : '127.0.0.1', () => {
  if (surVercel) return console.log('Application prête.');

  const config = lireConfig();
  console.log(`\n  Outil de publication Webflow — http://localhost:${port}`);
  console.log(
    config.collectionId
      ? `  Site « ${config.siteNom} », collection « ${config.collectionNom} »`
      : '  Aucune collection configurée : lancez « npm run setup ».'
  );
  if (!cleAnthropic()) {
    console.log('  Lecture automatique des fiches désactivée (ANTHROPIC_API_KEY absente).');
  }
  const alerte = alerteConfiguration();
  if (alerte) console.log(`  ${alerte}`);
  console.log(`  Dossier du projet : ${racine}\n`);
});
