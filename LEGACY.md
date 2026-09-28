# Legacy prototype code (repo root)

The following repo-root paths are the **original pre-Phase-8 prototype**,
kept only for historical reference:

- `src/`
- `server/`
- `index.html`
- `vite.config.js`

## What this was

Before the Phase 8 infra work, the OMS web/native crew app and its photo
upload service lived directly at the repo root as one combined codebase
(see `INTEGRATION_NOTES.md` for how it was originally built). It has since
been **superseded by the workspace split**:

- `frontend/` — the deployed control room web app (Vite + nginx)
- `backend/` — the deployed API service
- `mobile/` — the Expo crew app (native + web)

## Not part of the deployed stack

This legacy code is **not referenced by**:

- `helm-oms/` (the Helm chart deploys `oms-frontend`/`oms-backend` images
  built from `frontend/Dockerfile` and `backend/Dockerfile`)
- Any Dockerfile in this repo
- `.github/workflows/ci.yml`

## Do not develop here

No active development should happen in `src/`, `server/`, `index.html`,
or `vite.config.js`. Make changes in `frontend/`, `backend/`, or `mobile/`
instead. These root paths are kept around only so the prototype's history
isn't lost, and may be deleted in a future cleanup.
