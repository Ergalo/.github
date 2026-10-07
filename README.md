# Ergalo — réglages communs GitHub

Dépôt public de l'organisation Ergalo. Il ne contient que des réglages génériques, aucun secret ni code métier.

- `.github/workflows/ci.yml` : contrôles communs réutilisables (types, lint, tests unitaires, build, tests de bout en bout avec Postgres, OSV-Scanner, Semgrep CE).
- `.github/workflows/claude-review.yml` : revue optionnelle d'une pull request par Claude, avec la clé API du dépôt appelant.
- `PULL_REQUEST_TEMPLATE.md` : modèle de pull request avec la checklist « terminé », appliqué par défaut aux dépôts de l'organisation.

## Utilisation dans un projet

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  ci:
    uses: Ergalo/.github/.github/workflows/ci.yml@v1
```

Le projet doit fournir les scripts pnpm `typecheck`, `lint`, `test`, `build`, `db:migrate` et `test:e2e`.

## Versions

Les projets appellent `@v1`. Une évolution compatible déplace l'étiquette `v1` ; une évolution incompatible crée `v2`.
