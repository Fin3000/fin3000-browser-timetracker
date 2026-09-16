<p>
  <a href="https://fin3000.com/">
    <img src="docs/assets/favicon.svg" width="64" height="64" alt="Fin3000 – zur Website">
  </a>
</p>

# Fin3000 Browser-Zeiterfassung

[Fin3000.com](https://fin3000.com/)
· [Tools & Downloads](https://fin3000.com/tools/)
· [Projektseite](https://fin3000.github.io/fin3000-browser-timetracker/)

Zeiterfassung für [Fin3000.com](https://fin3000.com) in Firefox und Microsoft Edge.

Starte und stoppe deine Arbeitszeit direkt im Browser. Übernimm per Rechtsklick
Text von einer Webseite als Tätigkeitsbeschreibung und ordne deine Zeit einem
Projekt zu – ohne zwischen Browser-Tab und Zeiterfassung zu wechseln.

## Funktionen

- Zeit über das Erweiterungs-Popup starten und stoppen.
- Sichtbaren Text eines angeklickten Elements als Beschreibung übernehmen.
- Projekte nach Kunden filtern und auswählen.
- Beschreibung, Projekt und Abrechenbarkeit bearbeiten und speichern.
- Helles und dunkles Design sowie 26 Sprachen.

Unterstützt werden Firefox ab Version 140 und Microsoft Edge ab Version 152.

## Verfügbarkeit

Die Erweiterung ist derzeit eine Entwicklerversion. Die Veröffentlichung in den
Browser-Stores und die Freigabe für das Fin3000-Produktivsystem stehen noch aus.
Du kannst den Quellcode bereits bauen und die Oberfläche lokal ausprobieren.
Für Anmeldung und Zeitbuchungen wird zusätzlich ein Fin3000-System mit
aktivierter Browser-Zeiterfassung benötigt.

## Bedienung

Nach der Installation heftest du Fin3000 an die Browser-Symbolleiste an.
Öffne das Popup, verbinde dein Konto und bestätige den Zugriff auf deine
Zeiterfassung.

Über das Kontextmenü einer Webseite kannst du einen Timer mit dem Text des
angeklickten Elements starten. Im Popup lassen sich Beschreibung, Projekt und
Abrechenbarkeit ergänzen. Speichere Änderungen ausdrücklich: Beim Stoppen wird
der zuletzt gespeicherte Stand gebucht. Ungespeicherte Änderungen bleiben als
Entwurf erhalten.

Für Zeitbuchungen ist eine Internetverbindung erforderlich. Das Trennen der
Erweiterung von deinem Konto stoppt keinen bereits laufenden Timer.

## Selbst bauen

Voraussetzungen: Node.js 22 oder neuer und `zip`.

```bash
git clone https://github.com/Fin3000/fin3000-browser-timetracker.git
cd fin3000-browser-timetracker
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
npm run build:edge
```

Die lokalen Builds und Tests benötigen keine Fin3000-Serverinstallation.

### Firefox

Öffne `about:debugging#/runtime/this-firefox`, wähle **Temporäres Add-on laden**
und anschließend `dist/timer-extension/production/unpacked/manifest.json`.
Ein temporär geladenes Add-on wird beim Beenden von Firefox entfernt.

Die erzeugte XPI-Datei ist unsigniert. Für eine reguläre, dauerhafte Installation
in Firefox ist eine Signierung durch Mozilla erforderlich.

### Microsoft Edge

Öffne `edge://extensions`, schalte den Entwicklermodus ein und wähle
**Entpackte Erweiterung laden**. Wähle den Ordner
`dist/timer-extension/edge/production/unpacked` aus.
Lade bereits geöffnete Webseiten anschließend neu, damit das Kontextmenü
verfügbar ist. Die ZIP-Datei ist ein Entwicklerpaket, keine Store-Installation.

## Datenschutz

Die Anmeldung erfolgt über Fin3000. Du musst keinen API-Schlüssel in die
Erweiterung kopieren. Die Erweiterung erhält Zugriff auf deine eigene
Zeiterfassung, nicht auf die Timer anderer Personen.

Webseitentext wird erst nach deiner Fin3000-Kontextmenüaktion gelesen, begrenzt
auf 500 Zeichen. HTML, Seiten-URLs und Formularwerte werden dabei nicht
übertragen. Weitere Informationen findest du in [PRIVACY.md](PRIVACY.md).

## Entwicklung

- `src/`: gemeinsamer Erweiterungscode für Firefox und Edge.
- `config/`: Browser-Identitäten und Build-Profile.
- `_locales/`: Übersetzungen.
- `assets/`: Icons und Schriftarten.
- `scripts/`: Build-, Test- und Diagnosewerkzeuge.

`npm run repro` und `npm run repro:edge` prüfen die Reproduzierbarkeit der
Pakete. DOM-Tests verwenden Playwright-Chromium; mit `FIN3000_CHROMIUM` kannst
du ein bereits installiertes Chromium auswählen.

Die nativen Verbindungstests in `scripts/` benötigen zusätzlich einen
isolierten Fin3000-Testserver mit passender API, Anmeldeseite und Testkonten.
Diese Serverkomponenten werden nicht mitgeliefert und sind keine Voraussetzung
für die oben beschriebenen Builds und lokalen Tests.

Fehler und Verbesserungsvorschläge kannst du als
[GitHub-Issue](https://github.com/Fin3000/fin3000-browser-timetracker/issues) melden.
Bitte veröffentliche dabei keine Kundendaten, Zugangsdaten oder vertraulichen
Tätigkeitsbeschreibungen.

## Lizenz

[Apache-2.0](LICENSE). Die Schriftart Inter steht unter der
[SIL Open Font License](assets/Inter-OFL.txt). Weitere Hinweise findest du in
[NOTICE](NOTICE). Die Marke Fin3000 ist nicht Teil der Lizenz.
