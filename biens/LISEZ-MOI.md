# Dossiers des biens

Un sous-dossier par bien, contenant **une** fiche PDF et les photos :

```
biens/
└── maison-saint-brieuc/
    ├── fiche.pdf
    ├── photo-01.jpg
    ├── photo-02.jpg
    └── photo-03.jpg
```

Puis :

```bash
npm run import -- ./biens/maison-saint-brieuc
```

Les photos sont classées comme dans l'explorateur de fichiers : nommez-les
`photo-01`, `photo-02`… pour maîtriser l'ordre du diaporama. La première
devient la photo principale de l'annonce.

Le contenu de ces dossiers n'est pas versionné (voir `.gitignore`) : les fiches
et photos des clients de l'étude n'ont pas à se retrouver sur GitHub.
