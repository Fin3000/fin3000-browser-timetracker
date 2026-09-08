# Fin3000 Browser-Zeiterfassung

Firefox ab 140 und Microsoft Edge ab 152: Element per Rechtsklick erfassen, eigene Zeit starten/stoppen,
Beschreibung, Projekt und Abrechenbarkeit im Toolbar-Popup bearbeiten.
Kunden filtern die Projektauswahl; die Kundenzuordnung kommt vom Projekt.
Das Popup zeigt Account und tatsächlichen Mitarbeiter. Änderungen werden
ausdrücklich gespeichert. Stop bucht den zuletzt bestätigten Serverstand;
ungespeicherte Änderungen bleiben als gekennzeichneter Entwurf erhalten.

## Repository und Build

GitLab: [ideal3000-library/fin3000-browser-timetracker](https://gitlab.com/ideal3000-library/fin3000-browser-timetracker).
Lokaler Workspace-Pfad: `fin3000/tools/browser-timetracker`.

```bash
git clone git@gitlab.com:ideal3000-library/fin3000-browser-timetracker.git
cd fin3000-browser-timetracker
npm ci
npm run typecheck
npm test
npm run build
```

Für die DOM-Tests einmal `npx playwright install chromium` ausführen oder
`FIN3000_CHROMIUM` auf ein vorhandenes Chromium setzen. `zip` wird für den
Paketbuild benötigt. Build und Tests benötigen keinen Angular-Checkout.
API und OAuth-Consent bleiben in `fin3000-backend` bzw. `fin3000-frontend`;
der vollständige Verbindungstest benötigt deren isolierten QA-Stack.

Die Auslagerung übernimmt den Extensionstand aus `fin3000-frontend` Commit
`f64f9a14` einschließlich der korrigierten Suchfelder. Die Version `0.19.0`
bleibt erhalten, um ein Add-on-Downgrade zu vermeiden; künftige Versionen
werden unabhängig von der Web-App geführt. Release im Workspace über
`scripts/release.sh cut <feature-worktree> patch`.

Quellen liegen unter `src/`, Konfiguration unter `config/`, native Übersetzungen
unter `_locales/`, eigene Assets unter `assets/`, Werkzeuge unter `scripts/`.
Inter stammt aus [rsms/inter](https://github.com/rsms/inter) und wird unter der
[Sil Open Font License](assets/Inter-OFL.txt) mitgeliefert.

## Isoliert ausprobieren

Node 22+, `npm ci`, `zip`, Firefox und geckodriver werden lokal benötigt.
Der Runner installiert nichts in einem persönlichen Browserprofil.

```bash
# Backend-Worktree, separates Terminal:
QA_SLUG=firefox-timetracker bash scripts/qa_server.sh --fresh --worker --clamd-stub

# Frontend-Worktree, separates Terminal:
QA_SLUG=firefox-timetracker npm run qa

# Dieses Erweiterungs-Repository:
QA_SLUG=firefox-timetracker npm run timer-extension:doctor -- --json
QA_SLUG=firefox-timetracker npm run timer-extension:build:qa
```

Firefox → `about:debugging#/runtime/this-firefox` → „Temporäres Add-on laden“ →
`dist/timer-extension/qa/unpacked/manifest.json`. Fin3000 über das
Erweiterungsmenü an die Symbolleiste anheften. Popup öffnen und verbinden.
Seedkonto: `qa-timer-full@fin3000.test`; das QA-Passwort steht ausschließlich
im bestehenden Seedvertrag `backend/src/common/qa_seed/base.py`.

Die synthetische Testseite ist `tests/fixtures/timer-extension.html`.
Der native Runner stellt sie über einen eigenen Loopback-Webserver bereit:

```bash
QA_SLUG=firefox-timetracker npm run timer-extension:smoke:firefox -- \
  --mode temporary --scenario interactive --duration 600

# Automatisch; FIN3000_QA_PASSWORD aus dem QA-Seedvertrag setzen:
QA_SLUG=firefox-timetracker npm run timer-extension:smoke:firefox -- \
  --mode temporary --json

# Einmaliger Antwortverlust nach Commit; Paketupdate und Prozessneustart:
QA_SLUG=firefox-timetracker npm run timer-extension:smoke:firefox -- \
  --mode packaged --fault response-loss --json
```

`FIN3000_FIREFOX` und `FIN3000_GECKODRIVER` wählen explizite Binaries.
Bei Snap-Firefox muss geckodriver im passenden Snap-Kontext laufen; für eine
separate Mozilla-Installation einen unbeschränkten geckodriver verwenden.
Der Runner benötigt dessen `--allow-system-access` für native Browser-UI.

## Microsoft Edge installieren und testen

Firefox und Edge verwenden denselben Quellcode und dieselbe Bedienung. Die
Edge-Variante benötigt Webseitenzugriff für den unmittelbaren Element-Rechtsklick.
Sie merkt sich beim Rechtsklick kurz das Ziel; erst „Zeit starten“ liest Text.

```bash
QA_SLUG=edge-timetracker npm run build:edge:qa
QA_SLUG=edge-timetracker npm run doctor -- --browser edge --json
QA_SLUG=edge-timetracker npm run inspect -- --browser edge
```

Den Backend-/Frontend-QA-Stack mit demselben `QA_SLUG=edge-timetracker` starten.
Edge → `edge://extensions` → Entwicklermodus einschalten → **Entpackte Erweiterung
laden** → Ordner `dist/timer-extension/edge/qa/unpacked` auswählen. Anschließend
Fin3000 im Erweiterungsmenü an die Symbolleiste anheften, öffnen und verbinden.
Das ZIP ist zum Entpacken/Weitergeben; Edge lädt den darin enthaltenen Ordner.
Ein gewöhnlicher HTTP(S)-Webseiten-Tab muss nach der Installation neu geladen
werden, damit der Kontextmenü-Listener verfügbar ist.

Der Backend-Befehl `python manage.py provision_browser_timer_oauth --check`
prüft beide festen Browserclients. `--browser edge` begrenzt die Auswahl.
Der Timer muss aktiviert sein und `timer:self` in den OAuth-Scopes enthalten;
das ursprüngliche Backend-Timer-Feature und der Angular-Consent sind Voraussetzung.

```bash
# Echter Edge, eigener X11-Display (z. B. Xvfb), disposable Browserprofil:
# FIN3000_QA_PASSWORD aus dem bestehenden Seedvertrag setzen.
QA_SLUG=edge-timetracker FIN3000_QA_DISPLAY=:93 npm run smoke:edge -- --json
QA_SLUG=edge-timetracker FIN3000_QA_DISPLAY=:93 npm run smoke:edge -- --fault response-loss --json

# Reproduzierbare Pakete für lokale entpackte Installation:
npm run build:edge
npm run repro:edge
```

Native Linux-QA benötigt `xdotool`. `FIN3000_EDGE` und `FIN3000_XDOTOOL` können
Binaries auswählen. Der Runner benutzt die installierte Edge-Version, das echte
Kontextmenü und Toolbar-Popup sowie einen eigenen, anschließend entfernten Profilordner.
Der Antwortverlust-Test verwendet denselben lokalen Fehler-Proxy wie Firefox und
prüft nach echtem Worker-Neustart einen Serverbeleg ohne doppelte Startbuchung.
Er verwendet weder ein persönliches Profil noch den normalen Dev-Stack.
Die öffentliche Manifest-Key-Datei bindet QA und Produktion an getrennte IDs.
Der Produktionsbuild ist ein **Paket zur entpackten Installation**, kein Store-Release.
Vor Edge-Add-ons-Veröffentlichung muss die tatsächliche Store-ID mit dem
OAuth-Client/Redirect abgestimmt werden; ein Upload ist nicht Teil dieses Builds.

## Paketinstallation und Neustart

Das erzeugte XPI ist **unsigniert**. Normales Firefox akzeptiert es dauerhaft
erst nach Mozilla-Signierung. Für lokale Paket-QA Developer Edition/Nightly
als `FIN3000_FIREFOX` wählen und `--mode packaged` verwenden. Der Runner
deaktiviert die Signaturpflicht ausschließlich im disposable QA-Profil,
bedient `about:addons`, lehnt den echten Berechtigungs-/Datendialog zunächst
ab und bestätigt ihn beim zweiten Versuch. Ein echter Prozessneustart prüft
anschließend Installation, Verbindung und Entwurf ohne Neuinstallation.
Ein temporäres Add-on ersetzt diese Prüfung nicht.

Der Paketmodus erzeugt zusätzlich ein separates kompatibles QA-Update mit
erhöhter Testversion und prüft den Entwurf vor dem Neustart. `--fault
response-loss` verwirft genau eine Startantwort nach Server-Commit;
`--fault request-loss` genau eine Startanfrage davor. Ein eigener Loopback-
Proxy zählt ausschließlich Requests, erfolgreiche Starts und Belegabfragen.
Der Proxy liefert dafür einmalig HTTP 502, damit Firefox die Anfrage nicht
selbst transparent wiederholt. Er speichert keine Header, Tokens oder Inhalte. Ein Produktpaket wird durch
diese Testartefakte nicht ersetzt; vor Weitergabe neu bauen.

`--scenario compatibility --mode packaged` prüft außerdem die sichtbare Sperre
bei unbekanntem Protokoll und nach einem IndexedDB-Downgrade sowie die
Wiederherstellung von Verbindung und Entwurf durch ein kompatibles Update.
`--scenario auth --username qa-2fa-totp@fin3000.test` prüft nur Verbindung und
Trennung; `FIN3000_QA_TOTP_SECRET` nimmt den benannten TOTP-Seed aus dem
QA-Vertrag entgegen. Zugangsdaten erscheinen nicht im Bericht.

Das Popup ist 320–360 CSS-Pixel breit und passt seine Höhe zwischen 300 und
580 CSS-Pixeln an. Der Stop-Knopf bleibt über dem scrollbaren Formular
sichtbar; das gilt auch bei 200 % Zoom. Helles und dunkles Firefox-Theme
werden über die Systemeinstellung übernommen.

## Prüfungen und Artefakte

```bash
npm run timer-extension:typecheck
QA_SLUG=firefox-timetracker npm run timer-extension:test
QA_SLUG=firefox-timetracker npm run timer-extension:repro:qa
npm run timer-extension:build:production
npm run timer-extension:inspect -- --profile production
```

DOM-Tests benötigen Playwright-Chromium; `FIN3000_CHROMIUM` kann ein bereits
installiertes Chromium-Binary wählen. CI stellt Chromium bereit.
`--help` und `--json` gelten für alle Timer-CLIs. Exitcodes: 2 ungültige
Argumente/Konfiguration, 3 fehlende Voraussetzung, 4 fehlgeschlagene Prüfung.
Build und Inspector prüfen feste Identitäten, Berechtigungen, Dateiliste
und alle 26 Sprachkataloge. Repro baut zweimal und vergleicht XPI-SHA256.
Firefox-Artefakte liegen unter `dist/timer-extension/<qa|production>/`,
Edge unter `dist/timer-extension/edge/<qa|production>/`; native
Screenshots unter `qa/native/`. Ein erneuter Build ersetzt dieses Verzeichnis.

## Verbindungs- und Datenschutzvertrag

OAuth-PKCE verwendet ausschließlich `timer:self`, bestehende Anmeldung und
aktuelle Bestätigung. Keine API-Token-Eingabe, kein Zugriff auf fremde Timer.
Produktions-URLs und OAuth-Identität sind im Profil fest. Nur das QA-Profil
akzeptiert `QA_SLUG` und explizite `FIN3000_TIMER_API_ORIGIN`/
`FIN3000_TIMER_FRONTEND_ORIGIN` mit HTTP-Loopback-Origins. Firefox unterstützt
keine Ports in Host-Match-Patterns; das QA-Manifest nennt deshalb den genauen
Loopback-Host, während sämtliche API-Aufrufe den konfigurierten Port behalten.
Siehe [Mozilla Match Patterns](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns).

Nur der Hintergrundprozess speichert Tokens und angenommene Aktionen in
IndexedDB. Popup-Nachrichten enthalten keine Tokens. Privater Modus ist gesperrt.
Firefox nutzt `activeTab` im konkreten Frame ohne dauerhaftes Content-Script.
Edge lädt einen isolierten Listener auf HTTP(S)-Webseiten in deren jeweiligen
Frames. Dieser hält maximal zwei Minuten eine Knotenreferenz und liest erst
nach der expliziten Fin3000-Menüaktion sichtbaren Elementtext, höchstens
500 Unicode-Codepoints. Kein Auslesen auf Browser-/Store-Seiten; `about:blank`
und `srcdoc`-Frames erfordern manuelle Eingabe. Die Referenz wird einmalig verbraucht,
bei Navigation oder neuem Pointer-/Tastaturevent verworfen. Ein angemeldeter
Startwunsch wird vor dem API-Abgleich maximal eine Minute dauerhaft gehalten. HTML, URL und Formularwerte
werden nicht übertragen. Details: [PRIVACY.md](PRIVACY.md).

Ungewisse Aktionen werden mit derselben ID über einen Serverbeleg abgeglichen.
Ein 404-Beleg bedeutet keinen nachgewiesenen Rollback. Nach Ablauf des
300-Sekunden-Fensters entsteht nur durch einen neuen bewussten Klick eine neue
Aktion. Offline-Zeiten werden nicht lokal gebucht. Disconnect stoppt keinen
laufenden Server-Timer. Nach fehlgeschlagener Tokenrotation erneut verbinden.
Ein unbekanntes Protokoll oder Speicherschema sperrt Aktionen sichtbar.

Chrome und Safari bleiben Folgeziele. Safari benötigt zusätzlich die Apple-Verpackung. Der gemeinsame Timer-/OAuth-/Zustandskern bleibt
unabhängig vom Angular-Bundle und wird dafür wiederverwendet.
