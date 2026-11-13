# Datenschutzerklärung – j-indies radio (Discord-Bot)

Stand: 13.11.2026

Der Bot spielt das j-indies radio in einem Discord-Voice-Channel und lässt Nutzer Songs als Favoriten speichern. Er wird privat von den Betreibern dieses Repositories betrieben.

## Welche Daten gespeichert werden

- **Favoriten (`/fav`):** deine Discord-User-ID und die Songs, die du gespeichert hast (Künstler, Titel, Album, Cover-Link, Zeitpunkt).
- **YouTube-Verknüpfung (`/youtube verbinden`, freiwillig):** ein Google-Zugriffstoken (Refresh-Token) und die ID der Playlist, die der Bot in deinem YouTube-Account anlegt.

Andere Daten (Nachrichten, Sprache, E-Mail-Adresse o. Ä.) werden nicht gespeichert. Der Bot hört im Voice-Channel nicht zu.

## Wofür die Daten genutzt werden

Ausschließlich, um dir deine Favoriten anzuzeigen und – wenn du YouTube verbunden hast – passende Videos zu deiner eigenen, privaten Playlist hinzuzufügen bzw. daraus zu entfernen. Der Bot liest keine anderen Inhalte deines YouTube-Accounts und verändert nur diese eine Playlist.

Die Nutzung von Daten aus Google-APIs hält sich an die [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), einschließlich der Anforderungen zur eingeschränkten Nutzung (Limited Use).

## Speicherung und Weitergabe

Die Daten liegen in einer Datei auf dem Server, auf dem der Bot läuft. Sie werden an niemanden weitergegeben, nicht verkauft und nicht für Werbung oder Analyse genutzt. Zugriff hat nur, wer den Server betreibt.

## Löschen

- `/unfav <nummer>` löscht einzelne Favoriten.
- `/youtube trennen` widerruft den Google-Zugriff und löscht das Token sofort. Zusätzlich kannst du den Zugriff jederzeit unter https://myaccount.google.com/permissions entziehen.
- Für das Löschen aller deiner Daten wende dich an die Betreiber (siehe unten).

## Kontakt

Über die [Issues dieses Repositories](https://github.com/Gurkenwasser156/discord-voice-sitter/issues) oder direkt im Discord-Server an die Betreiber des Bots.
