# Datenschutz der Fin3000-Zeiterfassung

Die Erweiterung erfasst ausschließlich Zeiten für die bei Fin3000 angemeldete
Person. Eine bewusste Aktion im Kontextmenü liest sichtbaren Text des angeklickten
Elements und übermittelt höchstens 500 Unicode-Zeichen als Beschreibung an die
konfigurierte Fin3000-API. HTML, Seiten-URLs, Cookies, Formularwerte und Inhalte
anderer Tabs werden nicht übertragen. Auf geschützten Seiten erfolgt keine
automatische Zeiterfassung; die Beschreibung kann manuell eingegeben werden.

Fin3000 liefert den eigenen laufenden Timer sowie die gemäß den aktuellen
Benutzerrechten zugänglichen Kunden und Projekte. Kunden sind ein Projektfilter;
die Zuordnung ergibt sich aus dem gewählten Projekt. Starten, Bearbeiten, Stoppen
und Verwerfen verändern die bestehenden Fin3000-Zeiterfassungsdaten.

OAuth-Token, bestätigter Timerzustand, eine angenommene Aktion und begrenzte
Entwürfe liegen lokal in der IndexedDB dieser Erweiterung. Diese Daten sind für
Webseiten und andere Erweiterungen nicht zugänglich. Ein Text vor der Anmeldung
verfällt nach zehn Minuten und startet nach dem Verbinden keinen Timer. Es gibt
höchstens einen aktiven und einen wiederherstellbaren Entwurf für jeweils
24 Stunden. Abgelaufene Entwürfe sind nicht mehr verwendbar und werden beim
nächsten Hintergrundlauf entfernt, auch ohne Verbindung zum Server. Trennen
löscht den lokalen Zustand sofort und versucht zusätzlich,
die OAuth-Token bei Fin3000 zu widerrufen. Ein laufender Timer läuft dabei weiter.

Der Server hält Belege über Timeraktionen 24 Stunden vor; ein regelmäßig
ausgeführter Cleanup entfernt anschließend die abgelaufenen Belege. Diese
Belege enthalten Aktions- und Ergebnis-IDs, keine Beschreibungen oder Kundennamen.
Die normalen gespeicherten Zeiteinträge verbleiben in Fin3000 und unterliegen
dessen Berechtigungs- und Löschregeln. Benachrichtigungen enthalten nur einen
allgemeinen Bestätigungstext. Die Erweiterung enthält keine Analyse- oder
Trackingdienste und lädt keinen ausführbaren Code nach.

Das QA-Paket verwendet ausschließlich lokale Testserver und eine getrennte
Erweiterungsidentität. Es ist für isolierte Testdaten vorgesehen. Das
Produktionspaket verbindet ausschließlich api.fin3000.com und app.fin3000.com.
