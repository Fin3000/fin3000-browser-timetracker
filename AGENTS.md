# Fin3000 Browser Time Tracker

Independent Firefox and Edge extension. The Fin3000 workspace AGENTS.md applies when
working inside that workspace. The approved plan is
`docs/plans/2026-09-07-firefox-timetracker-context-menu.md` at workspace root.

- Work in a `feature/*` Git worktree; main is MR-only.
- Before edits run the workspace `scripts/changed-files.sh` for all intended
  paths in one invocation. Repository name: `tools/browser-timetracker`.
- Build and test with this repository's own `npm ci`, `npm run typecheck`,
  `npm test`, `npm run build`, `npm run repro` and `git diff --check`.
- Keep dependencies, fonts, icons and build helpers inside this repository.
  Do not import tooling or assets from a sibling Angular checkout.
- API/auth changes belong in fin3000-backend; web consent belongs in
  fin3000-frontend. Preserve the fixed timer:self scope and separate Firefox/Edge identities.
- Maintain identical keys and real translations in all 26 `_locales` catalogs.
- Browser mutations use disposable profiles and the isolated QA stack only.
  Chromium DOM tests do not establish native Firefox behavior.
- Do not publish signed add-ons or deploy without the user's request.
- Native Firefox support starts at 140, Edge at 152. Chrome/Safari remain future targets.
- Edge native QA uses an isolated X11 display and disposable profile; ordinary page screenshots are not proof of native browser UI.
