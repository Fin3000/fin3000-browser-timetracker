# Changelog

## [Unreleased]

### Changed

- Clarify the product description, installation status and Firefox/Edge developer setup.

- Publish the Firefox and Edge time tracker under Apache-2.0 with build and installation instructions.

- Rename the repository to fin3000-browser-timetracker and the npm package to @fin3000/browser-timetracker to reflect the shared browser extension.

### Added

- Microsoft Edge 152+ support with native context-menu capture and toolbar timer, shared searchable pickers, exact browser-bound OAuth clients, separate reproducible ZIP packages and native Edge QA.
- Persist context-menu start intent before synchronization so a background restart cannot lose an accepted click.

- Firefox 140+ time tracking with context-menu capture, toolbar timer, searchable client/project selection, OAuth PKCE and 26 languages.
- Standalone locked build/test dependencies, reproducible unsigned XPI packages and GitLab verification pipeline.
- Bundle the Inter font license with the extension.
