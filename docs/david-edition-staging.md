# David Edition staging integration

This branch integrates a **feature-flagged native Next.js Owner Bridge** into GetDone. It is intentionally OFF by default and is not a production replacement until staging acceptance.

## Enable in staging only
Set server environment variable `GETDONE_DAVID_EDITION=true` on the **staging web service**, rebuild and redeploy staging. Do not set in production.

## Preserved backend
- Home continues to use the existing `BusinessSystem` client, which calls GetDone's authenticated `/api/businesses` routes.
- Decisions and Resources retain their real existing server-side repositories and pages.
- Existing chat composer, approval enforcement, tenant scoping, and runtime workers are unchanged.
- New owner shell links to the real `/`, `/decisions`, and `/resources` routes. No mock approval endpoints.

## 3D universe asset handoff
The optional Explore iframe checks for `/universe-assets/index.html` before rendering. **This PR does not upload the standalone v35 Vite build**; until those files are installed, Explore falls back to the real business catalog. To enable the cinematic universe, build the separately supplied fixed v35 archive and install its `dist/` contents under `public/universe-assets/`, then verify its same-origin message bridge, authenticated catalog and chat contracts. Do not serve sample data in the live mode.

## Staging acceptance
1. `npm run typecheck && npm run build`
2. Signed-out redirect and authenticated owner access; test unauthorized tenant separation.
3. Home -> Decisions -> Resources -> Home and browser refresh.
4. Real business catalog, empty states, error handling.
5. Existing native chat and governed approval flow remain functional.
6. Mobile viewport and keyboard navigation.
7. Feature flag OFF restores original UI.
8. Only after assets are installed: 3D Explore, scene-to-chat bridge, and status evidence mapping.

No deployment, production flag change, or merge is performed by this branch.
