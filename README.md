# Ergalo — réglages communs GitHub

Dépôt public de l'organisation Ergalo. Il ne contient que des réglages génériques, aucun secret ni code métier.

- `.github/workflows/ci.yml` : contrôles communs réutilisables (types, lint, tests unitaires, build, tests de bout en bout avec Postgres) et analyses de sécurité (appel de `securite.yml`).
- `.github/workflows/securite.yml` : analyses de sécurité, appelables seules par un dépôt qui garde sa propre CI : secrets (gitleaks), workflows (zizmor), failles connues des dépendances (OSV-Scanner), code (Semgrep CE). Images épinglées par version et empreinte, actions par SHA.
- `.github/workflows/controle.yml` : contrôle de ce dépôt (chaque pull request passe `securite.yml`).
- `.github/workflows/claude-review.yml` : revue optionnelle d'une pull request par Claude, avec la clé API du dépôt appelant.
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

## Versions

Les projets appellent `@v2` (`@v1` reste en place le temps du passage). Une évolution compatible déplace l'étiquette `v2` ; une évolution incompatible crée `v3`. v2 : actions épinglées par SHA, images par empreinte, droits minimaux, choix du runner, analyses de sécurité à part (gitleaks et zizmor en plus).
