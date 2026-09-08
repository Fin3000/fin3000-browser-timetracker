# Changelog

## [Unreleased]

### Changed

- Rename the repository to fin3000-browser-timetracker and the npm package to @fin3000/browser-timetracker to reflect the shared browser extension.

### Added

- Microsoft Edge 152+ support with native context-menu capture and toolbar timer, shared searchable pickers, exact browser-bound OAuth clients, separate reproducible ZIP packages and native Edge QA.
- Persist context-menu start intent before synchronization so a background restart cannot lose an accepted click.

- Independent Firefox time tracker repository, extracted from fin3000-frontend commit f64f9a14: context-menu capture, toolbar timer, searchable client/project selection, OAuth PKCE, 26 languages and native Firefox QA tooling.
- Standalone locked build/test dependencies, reproducible unsigned XPI packages and GitLab verification pipeline.
- Bundle the Inter font license with the extension.
