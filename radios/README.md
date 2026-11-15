# Sender

Der Radio-Bot kann mehrere Sender spielen. Umschalten im Discord mit
`/radio wechseln sender:<name>` (wer im Voice-Channel des Bots sitzt oder „Server verwalten“ hat),
`/radio liste` zeigt alle, `/radio jetzt` den aktuellen Song mit Fortschritt. Der zuletzt gewählte Sender
wird gemerkt (`DATA_DIR/radio-state.json`).

Steuerung (gleiche Berechtigung wie Umschalten):

- `/skip` – nächster Song bzw. Beitrag (nur GTA-Sender, Live-Radios kann man nicht skippen)
- `/pause` – pausieren, nochmal `/pause` setzt fort (Live-Radios verbinden dabei neu, damit sie wieder live sind)
- `/radio werbung status:an|aus [was:beides|nur Werbung|nur Nachrichten]` – Werbung/Nachrichten der
  GTA-Sender an- oder abschalten; läuft gerade Werbung, wird sie beim Abschalten übersprungen. Wird gemerkt.

Der Bot-Status zeigt den aktuellen Song mit Fortschrittsbalken (`━━━●────── 1:23 / 3:45`).

Jede `*.json` hier ist ein Sender. Dazu kommt das Internet-Radio aus `RADIO_URL` (falls gesetzt).

## GTA-V-Sender (`"type": "gta"`)

Songs, DJ-Moderation und Jingles werden live gemischt wie im Spiel:

- zwischen den Songs Station-IDs, DJ-Solos und (wenn vorhanden) Werbung/Nachrichten mit Überleitung
- über dem Song-Intro eine Ansage zum Song, eine allgemeine Ansage oder eine Morgen-/Abend-Ansage
  (Ortszeit, `TZ` setzen); die Musik wird dabei leicht geduckt
- der Sender läuft im Hintergrund weiter: zurückschalten = da weiter, wo er inzwischen wäre
- kürzlich gespielte Songs/Ansagen werden nicht gleich wiederholt

Die Audio-Dateien gehören **nicht** ins Repo/Image. Sie liegen in `AUDIO_DIR`
(Standard `./audio`, im Docker `/app/audio` → in `docker-compose.yml` ist `./audio` gemountet):

```
audio/
  non-stop-pop/        <- "folder" aus der JSON
    kids/KIDS.opus
    intro/KIDS_01.opus
    general/GENERAL_01.opus
    time/MORNING_01.opus
    to/TO_AD_01.opus
    id_01/ID_01.opus
    mono_solo_01/MONO_SOLO_01.opus
  adverts/             <- Werbung, gilt für alle GTA-Sender (RADIO_ADVERTS.rpf)
    mono_ad001_life_invader/MONO_AD001_LIFE_INVADER.opus
  news/                <- Nachrichten, gilt für alle GTA-Sender (RADIO_NEWS.rpf)
    mono_news_01/MONO_NEWS_01.opus
```

Werbung und Nachrichten liegen im Spiel unter `x64\audio\sfx\RADIO_ADVERTS.rpf` und
`RADIO_NEWS.rpf` und werden von allen Sendern geteilt. Die Ordner dürfen auch
`Radio Adverts` / `Radio News` heißen (so, wie OpenIV sie exportiert). TV-Spots und
-Sendungen (`mono_tv_…`) und alles über 3 Minuten wird nicht als Werbung gespielt.
Ein Sender kann eigene `ad/`/`news/` im Sender-Ordner haben oder sie per
`"ads": false` / `"news": false` in seiner JSON abschalten.

Das ist genau die Struktur der üblichen GTA-V-Dumps (OpenIV). WAV geht direkt, kleiner wird es mit:

```
node scripts/convert-audio.mjs "<dump-ordner>" audio/non-stop-pop
node scripts/convert-audio.mjs "<Radio Adverts>" audio/adverts
node scripts/convert-audio.mjs "<Radio News>" audio/news
```

(Non-Stop-Pop 1,8 GB WAV → ca. 200 MB, Werbung + Nachrichten 1,3 GB → ca. 170 MB.) Fehlt der Ordner, wird der Sender beim Start einfach übersprungen.

### Neuen GTA-Sender hinzufügen

1. Dump nach `audio/<ordner>/` legen (oder konvertieren).
2. `radios/<sender>.json` anlegen:

```json
{
  "id": "mirrorpark",
  "name": "Radio Mirror Park",
  "type": "gta",
  "folder": "mirror-park",
  "dj": "Twin Shadow",
  "emoji": "🌴",
  "aliases": { "INTRO_NAME_OHNE_NUMMER": "SONG_ORDNERNAME" },
  "songs": { "SONG_ORDNERNAME": { "artist": "…", "title": "…" } }
}
```

`songs` ist optional (sonst wird der Titel aus dem Ordnernamen gebaut), `aliases` nur nötig,
wenn ein Intro anders heißt als der Song (z.B. `TELL_IT_TO_MY_HEART` → `TELL_TO_MY_HEART`).

## Internet-Radio

```json
{ "id": "j-indies", "name": "J-Indies", "type": "azuracast", "url": "https://radio.j-indies.net/public/j-indies" }
{ "id": "xyz", "name": "XYZ", "type": "stream", "url": "https://example.com/stream.mp3" }
```

Eigene Sender-Dateien außerhalb des Repos: `RADIOS_DIR=/pfad` setzen.
