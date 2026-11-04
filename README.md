# Ergalo — réglages communs GitHub

Dépôt public de l'organisation Ergalo. Il ne contient que des réglages génériques, aucun secret ni code métier.

- `.github/workflows/ci.yml` : contrôles communs réutilisables (types, lint, tests unitaires, build, tests de bout en bout avec Postgres) et analyses de sécurité (appel de `securite.yml`).
- `.github/workflows/securite.yml` : analyses de sécurité, appelables seules par un dépôt qui garde sa propre CI : secrets (gitleaks), workflows (zizmor), failles connues des dépendances (OSV-Scanner), code (Semgrep CE). Images épinglées par version et empreinte, actions par SHA.
- `.github/workflows/controle.yml` : contrôle de ce dépôt (chaque pull request passe `securite.yml`).
- `.github/workflows/claude-review.yml` : revue optionnelle d'une pull request par Claude, avec la clé API du dépôt appelant. Le workflow appelant doit accorder `pull-requests: write`, `issues: write` et `id-token: write`.
- `.github/workflows/gardien-pr.yml` et `gardien-pr/` : gardien des PR, commun à tous les dépôts (voir plus bas).
- `PULL_REQUEST_TEMPLATE.md` : modèle de pull request avec la checklist « terminé », appliqué par défaut aux dépôts de l'organisation.

## Utilisation dans un projet

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  ci:
    uses: Ergalo/.github/.github/workflows/ci.yml@v2
```

Le projet doit fournir les scripts pnpm `typecheck`, `lint`, `test`, `build`, `db:migrate` et `test:e2e`. Contrôles obligatoires à déclarer dans le ruleset du dépôt : `ci / Types, lint, tests unitaires, build`, `ci / Tests de bout en bout`, `ci / securite / Sécurité`.

Un dépôt qui garde sa propre CI (site, integrations, hq) appelle seulement les analyses de sécurité :

```yaml
jobs:
  securite:
    uses: Ergalo/.github/.github/workflows/securite.yml@v2
    with:
      runner: '["self-hosted","ergalo"]'   # runners d'ergalo-ci ; par défaut '"ubuntu-latest"'
```

Contrôle obligatoire : `securite / Sécurité`. Une alerte se corrige, ou se justifie dans le dépôt appelant (voir l'en-tête de `securite.yml`), jamais en coupant l'analyse.

## Gardien des PR

Né du constat du 04/11 : des PR visaient des branches intermédiaires déjà fusionnées dans `main` et ne pouvaient plus arriver, d'autres restaient rouges ou en conflit des jours sans que personne le voie. Pour chaque PR ouverte, sans IA (`gardien-pr/gardien-pr.mjs`) :

- base déjà fusionnée dans la branche par défaut (plus aucun commit d'avance et une PR fusionnée l'avait pour tête) : la PR est reciblée vers la branche par défaut ;
- conflit avec sa base : étiquette `a-revoir` et liste des fichiers modifiés des deux côtés ;
- une PR de la file de fusion (`a-fusionner`) touche les mêmes fichiers : la note le dit, avec l'ordre de passage conseillé ;
- CI rouge depuis plus de 24 h sur le dernier commit : étiquette `a-revoir` ;
- une seule note par PR, mise à jour sur place ; `a-revoir` n'est retirée que si le gardien l'a posée et que le problème a disparu. Il ne touche jamais à `a-fusionner`, `fusion-bloquee` ni `zone-partagee` (file de fusion).

Une PR à laisser de côté porte l'étiquette `gardien-ignore` (ou sa branche est dans l'entrée `ignorer`). Jeton : l'application `ergalo-fusion` (variable `FUSION_APP_ID`, secret `FUSION_APP_PRIVATE_KEY`), sinon le jeton du workflow. Chaque dépôt appelle le workflow à chaque changement de PR (exemple en tête de `gardien-pr.yml`) ; le passage horaire sur toute l'organisation part de `Ergalo/site` et couvre tous les dépôts où l'application est installée. Essais : `node --test gardien-pr/gardien-pr.test.mjs`.

## Versions

Les projets appellent `@v2` (`@v1` reste en place le temps du passage). Une évolution compatible déplace l'étiquette `v2` ; une évolution incompatible crée `v3`. v2 : actions épinglées par SHA, images par empreinte, droits minimaux, choix du runner, analyses de sécurité à part (gitleaks et zizmor en plus).
