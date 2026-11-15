import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  Events,
  PermissionFlagsBits,
} from 'discord.js';

// Sender:
//   /radio liste             alle Sender anzeigen
//   /radio wechseln <sender> umschalten (nur wer im Channel des Bots ist oder "Server verwalten" hat)
//   /radio jetzt             was läuft gerade (mit Fortschritt)
//   /radio werbung <an|aus>  Werbung/Nachrichten der GTA-Sender an- oder abschalten
//   /skip                    nächster Song (GTA-Sender)
//   /pause                   pausieren / fortsetzen
//   (Umschalten, Werbung, Skip, Pause: nur wer im Channel des Bots ist oder "Server verwalten" hat)
//
// Private Favoriten (alle Antworten nur für den User sichtbar):
//   /fav                 aktuellen Song speichern (+ in die eigene YouTube-Playlist)
//   /favs [seite]        eigene Favoriten anzeigen
//   /unfav <nummer>      Favorit löschen
//   /youtube verbinden | trennen | status | nachtragen

const PAGE_SIZE = 10;
const SYNC_LIMIT = 20; // max. Songs pro /youtube nachtragen (Quota!)
const COLOR = 0xe2557a;

const log = (...a) => console.log(new Date().toISOString(), '[favs]', ...a);
const ephemeral = { flags: MessageFlags.Ephemeral };

function radioCommand(stations) {
  return new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Radiosender anzeigen und wechseln')
    .addSubcommand((s) => s.setName('liste').setDescription('Alle Sender anzeigen'))
    .addSubcommand((s) => s.setName('jetzt').setDescription('Was gerade läuft'))
    .addSubcommand((s) => s.setName('wechseln').setDescription('Auf einen anderen Sender umschalten')
      .addStringOption((o) => o.setName('sender').setDescription('Sender').setRequired(true)
        .addChoices(...stations.slice(0, 25).map((st) => ({ name: st.name.slice(0, 100), value: st.id })))))
    .addSubcommand((s) => s.setName('werbung').setDescription('Werbung und Nachrichten an- oder abschalten')
      .addStringOption((o) => o.setName('status').setDescription('an oder aus').setRequired(true)
        .addChoices({ name: 'an', value: 'an' }, { name: 'aus', value: 'aus' }))
      .addStringOption((o) => o.setName('was').setDescription('Standard: beides')
        .addChoices(
          { name: 'Werbung und Nachrichten', value: 'beides' },
          { name: 'nur Werbung', value: 'ads' },
          { name: 'nur Nachrichten', value: 'news' },
        )));
}

const controlCommandData = [
  new SlashCommandBuilder().setName('skip').setDescription('Zum nächsten Song springen'),
  new SlashCommandBuilder().setName('pause').setDescription('Radio pausieren oder fortsetzen'),
].map((c) => c.toJSON());

const favCommandData = [
  new SlashCommandBuilder()
    .setName('fav')
    .setDescription('Aktuellen Radio-Song in deine privaten Favoriten speichern'),
  new SlashCommandBuilder()
    .setName('favs')
    .setDescription('Deine Radio-Favoriten anzeigen')
    .addIntegerOption((o) => o.setName('seite').setDescription('Seite').setMinValue(1)),
  new SlashCommandBuilder()
    .setName('unfav')
    .setDescription('Einen Favoriten löschen')
    .addIntegerOption((o) => o.setName('nummer').setDescription('Nummer aus /favs').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder()
    .setName('youtube')
    .setDescription('Deine Favoriten in eine private YouTube-Playlist übernehmen')
    .addSubcommand((s) => s.setName('verbinden').setDescription('Google-Account verknüpfen und Playlist anlegen'))
    .addSubcommand((s) => s.setName('trennen').setDescription('Google-Account wieder trennen'))
    .addSubcommand((s) => s.setName('status').setDescription('Verknüpfung und Playlist anzeigen'))
    .addSubcommand((s) => s.setName('nachtragen').setDescription(`Favoriten ohne YouTube-Eintrag nachtragen (max. ${SYNC_LIMIT})`))
    .addSubcommand((s) => s.setName('setzen').setDescription('Das richtige YouTube-Video für einen Favoriten selbst festlegen')
      .addIntegerOption((o) => o.setName('nummer').setDescription('Nummer aus /favs').setMinValue(1).setRequired(true))
      .addStringOption((o) => o.setName('link').setDescription('YouTube-Link zum Video').setRequired(true))),
].map((c) => c.toJSON());

const songs = (n) => `${n} ${n === 1 ? 'Song' : 'Songs'}`;
const esc = (s) => String(s ?? '').replace(/([\\*_`~|>\[\]()])/g, '\\$1');
const ytSearch = (f) => `https://www.youtube.com/results?search_query=${encodeURIComponent(f.text)}`;
const spotifySearch = (f) => `https://open.spotify.com/search/${encodeURIComponent(f.text)}`;

export function setupCommands({ client, guildId, radio, store, youtube }) {
  const pendingLogins = new Set();

  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set([radioCommand(radio.stations()).toJSON(), ...controlCommandData, ...favCommandData]);
      log('Slash-Commands registriert');
    } catch (err) {
      log('Slash-Commands konnten nicht registriert werden:', err.message,
        '-> Bot mit Scope "applications.commands" neu einladen?');
    }
  });

  // ---------- Eine YouTube-Playlist pro Sender ----------
  // Vor /radio gab es nur das Internet-Radio (erster Sender): alte Favoriten und
  // die alte Einzel-Playlist gehören zu ihm.
  const legacyStation = () => radio.stations()[0]?.id;
  const stationOf = (fav) => fav.station ?? legacyStation();
  const stationInfo = (id) => radio.stations().find((st) => st.id === id) ?? { id, name: id, emoji: '📻' };

  /** YouTube-Daten des Users ({ refreshToken, playlists: { senderId: playlistId } }). */
  function ytOf(userId) {
    const yt = store.youtube(userId);
    if (!yt || yt.playlists) return yt;
    const { playlistId, ...rest } = yt; // altes Format migrieren
    store.setYoutube(userId, { ...rest, playlists: playlistId ? { [legacyStation()]: playlistId } : {} });
    return store.youtube(userId);
  }

  const targetFor = (yt, stationId) => ({
    refreshToken: yt.refreshToken,
    playlistId: yt.playlists[stationId] ?? null,
    title: youtube.playlistTitle(stationInfo(stationId).name),
  });

  function rememberPlaylist(userId, stationId, playlistId) {
    const yt = ytOf(userId);
    if (yt.playlists[stationId] === playlistId) return;
    store.setYoutube(userId, { ...yt, playlists: { ...yt.playlists, [stationId]: playlistId } });
  }

  const playlistLink = (stationId, playlistId) =>
    `${stationInfo(stationId).emoji ?? '📻'} [${esc(stationInfo(stationId).name)}](${youtube.playlistUrl(playlistId)})`;
  const playlistLinks = (yt) => Object.entries(yt.playlists).map(([id, pl]) => playlistLink(id, pl));

  /** Fügt einen Favoriten zur Playlist seines Senders hinzu. Gibt eine Textzeile fürs Ergebnis zurück. */
  async function syncToYoutube(userId, fav) {
    const yt = ytOf(userId);
    if (!yt) return null;
    const stationId = stationOf(fav);
    try {
      const r = await youtube.addSong(targetFor(yt, stationId), fav);
      store.updateFav(userId, fav.id, { yt: { videoId: r.videoId, itemId: r.itemId }, ytMiss: undefined });
      rememberPlaylist(userId, stationId, r.playlistId);
      return { ok: true, line: `▶️ In deiner Playlist ${playlistLink(stationId, r.playlistId)} · [Video](${youtube.videoUrl(r.videoId)})` };
    } catch (err) {
      log(`YouTube für ${userId}:`, err.message);
      if (err.code === 'quota') return { ok: false, stop: true, line: '⚠️ YouTube-Tageslimit erreicht – morgen mit `/youtube nachtragen` hinzufügen.' };
      if (err.code === 'revoked') return { ok: false, stop: true, line: `⚠️ ${err.message}` };
      if (err.code === 'novideo') {
        // Merken, damit /youtube nachtragen nicht jedes Mal erneut sucht (kostet Quota)
        store.updateFav(userId, fav.id, { ytMiss: new Date().toISOString() });
        const n = store.favNumber(userId, fav.id);
        return {
          ok: false,
          line: `⚠️ Kein sicherer YouTube-Treffer, darum nichts hinzugefügt. [Selbst suchen](${ytSearch(fav)}) und dann \`/youtube setzen nummer:${n} link:…\``,
        };
      }
      return { ok: false, stop: true, line: `⚠️ YouTube: ${err.message}` };
    }
  }

  async function handleFav(i) {
    await i.deferReply(ephemeral);
    const song = await radio.nowPlaying();
    if (!song) return i.editReply('Gerade läuft nichts, was ich speichern könnte.');

    const { fav, added } = store.addFav(i.user.id, { ...song, station: radio.current().id });
    const lines = [added ? '❤️ Zu deinen Favoriten hinzugefügt' : '💾 Ist schon in deinen Favoriten'];

    if (store.youtube(i.user.id)) {
      if (!fav.yt) lines.push((await syncToYoutube(i.user.id, fav)).line);
      else lines.push(`▶️ [Auf YouTube](${youtube.videoUrl(fav.yt.videoId)})`);
    } else if (youtube && added) {
      lines.push('Tipp: Mit `/youtube verbinden` landen deine Favoriten auch in einer privaten YouTube-Playlist.');
    }

    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle(song.title ?? song.text)
      .setDescription([song.artist && `von **${esc(song.artist)}**`, song.album && `aus *${esc(song.album)}*`, '', ...lines].filter((l) => typeof l === 'string').join('\n'))
      .setFooter({ text: `${songs(store.favs(i.user.id).length)} in deinen Favoriten · /favs` });
    if (song.art) embed.setThumbnail(song.art);
    return i.editReply({ embeds: [embed] });
  }

  async function handleFavs(i) {
    const favs = [...store.favs(i.user.id)].reverse(); // neueste zuerst
    if (!favs.length) return i.reply({ ...ephemeral, content: 'Noch keine Favoriten – hör rein und speicher Songs mit `/fav`.' });

    const pages = Math.ceil(favs.length / PAGE_SIZE);
    const page = Math.min(i.options.getInteger('seite') ?? 1, pages);
    const start = (page - 1) * PAGE_SIZE;

    const multi = new Set(favs.map(stationOf)).size > 1; // Sender-Emoji nur, wenn gemischt
    const lines = favs.slice(start, start + PAGE_SIZE).map((f, k) => {
      const yt = f.yt ? youtube?.videoUrl(f.yt.videoId) ?? ytSearch(f) : ytSearch(f);
      const tag = multi ? `${stationInfo(stationOf(f)).emoji ?? '📻'} ` : '';
      return `**${start + k + 1}.** ${tag}${esc(f.text)} · [YouTube](${yt}) · [Spotify](${spotifySearch(f)})`;
    });

    const yt = youtube && ytOf(i.user.id);
    if (yt && Object.keys(yt.playlists).length) lines.unshift(`▶️ Deine Playlists: ${playlistLinks(yt).join(' · ')}\n`);

    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('❤️ Deine Radio-Favoriten')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Seite ${page}/${pages} · ${songs(favs.length)}${pages > 1 ? ' · /favs seite:<n>' : ''}` });
    return i.reply({ ...ephemeral, embeds: [embed] });
  }

  async function handleUnfav(i) {
    const n = i.options.getInteger('nummer', true);
    const removed = store.removeFav(i.user.id, n);
    if (!removed) return i.reply({ ...ephemeral, content: `Favorit #${n} gibt's nicht – schau in \`/favs\`.` });

    let extra = '';
    const yt = store.youtube(i.user.id);
    if (yt && removed.yt?.itemId) {
      try {
        await youtube.removeItem(yt, removed.yt.itemId);
        extra = ' (auch aus der YouTube-Playlist)';
      } catch (err) {
        extra = ` – aus der YouTube-Playlist konnte ich ihn nicht löschen: ${err.message}`;
      }
    }
    return i.reply({ ...ephemeral, content: `🗑️ **${esc(removed.text)}** entfernt${extra}.` });
  }

  async function handleYoutube(i) {
    if (!youtube) {
      return i.reply({ ...ephemeral, content: 'YouTube ist für diesen Bot nicht eingerichtet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET fehlen).' });
    }
    const sub = i.options.getSubcommand();
    const yt = ytOf(i.user.id);

    if (sub === 'status') {
      if (!yt) return i.reply({ ...ephemeral, content: 'Nicht verbunden. Mit `/youtube verbinden` legst du eine private Playlist an.' });
      const favs = store.favs(i.user.id);
      const missing = favs.filter((f) => !f.yt && !f.ytMiss).length;
      const misses = favs.filter((f) => !f.yt && f.ytMiss).map((f) => `#${store.favNumber(i.user.id, f.id)} ${esc(f.text)}`);
      return i.reply({
        ...ephemeral,
        content: `✅ Verbunden`
          + (Object.keys(yt.playlists).length ? `\nDeine Playlists: ${playlistLinks(yt).join(' · ')}` : '\nNoch keine Playlist – die erste entsteht beim nächsten `/fav`.')
          + (missing ? `\n${missing} Favoriten sind noch nicht drin → \`/youtube nachtragen\`` : '')
          + (misses.length ? `\nOhne Treffer (→ \`/youtube setzen\`):\n${misses.slice(0, 10).map((m) => `• ${m}`).join('\n')}` : ''),
      });
    }

    if (sub === 'trennen') {
      if (!yt) return i.reply({ ...ephemeral, content: 'Du bist gar nicht verbunden.' });
      await youtube.revoke(yt.refreshToken);
      store.setYoutube(i.user.id, null);
      return i.reply({ ...ephemeral, content: '👋 Google-Account getrennt. Deine Favoriten bleiben hier gespeichert, die Playlists bleiben in deinem YouTube-Account.' });
    }

    if (sub === 'nachtragen') {
      if (!yt) return i.reply({ ...ephemeral, content: 'Erst `/youtube verbinden`.' });
      const todo = store.favs(i.user.id).filter((f) => !f.yt && !f.ytMiss);
      if (!todo.length) {
        return i.reply({ ...ephemeral, content: '✅ Alles nachgetragen. Songs ohne Treffer siehst du in `/youtube status` und kannst sie mit `/youtube setzen` festlegen.' });
      }

      await i.deferReply(ephemeral);
      let done = 0;
      const problems = [];
      for (const fav of todo.slice(0, SYNC_LIMIT)) {
        const r = await syncToYoutube(i.user.id, fav);
        if (r.ok) done++;
        else {
          problems.push(`${esc(fav.text)}: ${r.line.replace(/^⚠️ /, '')}`);
          if (r.stop) break;
        }
      }
      const rest = store.favs(i.user.id).filter((f) => !f.yt && !f.ytMiss).length;
      return i.editReply(
        `▶️ ${songs(done)} nachgetragen · ${playlistLinks(ytOf(i.user.id)).join(' · ')}`
        + (problems.length ? `\n${problems.slice(0, 5).map((p) => `• ${p}`).join('\n')}` : '')
        + (rest ? `\nNoch ${rest} offen.` : ''),
      );
    }

    if (sub === 'setzen') {
      if (!yt) return i.reply({ ...ephemeral, content: 'Erst `/youtube verbinden`.' });
      const n = i.options.getInteger('nummer', true);
      const fav = store.favAt(i.user.id, n);
      if (!fav) return i.reply({ ...ephemeral, content: `Favorit #${n} gibt's nicht – schau in \`/favs\`.` });
      const videoId = youtube.parseVideoId(i.options.getString('link', true));
      if (!videoId) return i.reply({ ...ephemeral, content: 'Das sieht nicht nach einem YouTube-Link aus. Beispiel: `https://youtu.be/dQw4w9WgXcQ`' });
      if (fav.yt?.videoId === videoId) {
        return i.reply({ ...ephemeral, content: `Genau dieses Video ist für **${esc(fav.text)}** schon drin.` });
      }

      await i.deferReply(ephemeral);
      const oldItemId = fav.yt?.itemId; // vor updateFav merken (fav wird dabei verändert)
      try {
        const stationId = stationOf(fav);
        const r = await youtube.addVideo(targetFor(yt, stationId), videoId);
        // Altes (falsches) Video erst entfernen, wenn das neue drin ist
        if (oldItemId) await youtube.removeItem(yt, oldItemId).catch((err) => log('Altes Video nicht entfernt:', err.message));
        store.updateFav(i.user.id, fav.id, { yt: { videoId: r.videoId, itemId: r.itemId }, ytMiss: undefined });
        rememberPlaylist(i.user.id, stationId, r.playlistId);
        return i.editReply(`✅ **${esc(fav.text)}** → [Video](${youtube.videoUrl(videoId)}) ist jetzt in deiner Playlist ${playlistLink(stationId, r.playlistId)}`
          + (oldItemId ? ' (das alte Video ist raus).' : '.'));
      } catch (err) {
        log(`YouTube setzen für ${i.user.id}:`, err.message);
        if (err.reason === 'videoNotFound') return i.editReply('⚠️ Das Video gibt\'s nicht oder es ist privat.');
        if (err.code === 'quota') return i.editReply('⚠️ YouTube-Tageslimit erreicht – morgen nochmal probieren.');
        return i.editReply(`⚠️ ${err.message}`);
      }
    }

    // verbinden
    if (yt) {
      return i.reply({ ...ephemeral, content: `Schon verbunden${Object.keys(yt.playlists).length ? ` · ${playlistLinks(yt).join(' · ')}` : ''}. Zum Wechseln erst \`/youtube trennen\`.` });
    }
    if (pendingLogins.has(i.user.id)) {
      return i.reply({ ...ephemeral, content: 'Du hast schon einen offenen Login – nimm den Code aus der letzten Nachricht.' });
    }

    await i.deferReply(ephemeral);
    let login;
    try {
      login = await youtube.startLogin();
    } catch (err) {
      return i.editReply(`⚠️ ${err.message}`);
    }

    pendingLogins.add(i.user.id);
    await i.editReply({
      embeds: [new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('YouTube verbinden')
        .setDescription([
          `**1.** Öffne ${login.url}`,
          `**2.** Gib diesen Code ein: \`${login.userCode}\``,
          '**3.** Mit dem Google-Account einloggen, in dem die Playlists landen sollen, und Zugriff erlauben.',
          '',
          'Falls Google „App nicht verifiziert“ anzeigt: *Erweitert → Weiter zu …*',
          `Der Code läuft <t:${Math.floor(login.expiresAt / 1000)}:R> ab. Ich melde mich hier, sobald es geklappt hat.`,
        ].join('\n'))],
    });

    try {
      const refreshToken = await login.done;
      // Schon vorhandene Bot-Playlists (z.B. nach erneutem Verbinden) wiederverwenden
      const stations = radio.stations();
      const found = await youtube.findPlaylists(refreshToken, stations.map((st) => youtube.playlistTitle(st.name)));
      const playlists = Object.fromEntries(stations
        .map((st) => [st.id, found[youtube.playlistTitle(st.name)]])
        .filter(([, id]) => id));
      store.setYoutube(i.user.id, { refreshToken, playlists });
      log(`YouTube verbunden für ${i.user.id}`);
      const missing = store.favs(i.user.id).filter((f) => !f.yt && !f.ytMiss).length;
      const links = playlistLinks(store.youtube(i.user.id));
      await i.editReply({
        embeds: [new EmbedBuilder()
          .setColor(COLOR)
          .setTitle('✅ YouTube verbunden')
          .setDescription([
            'Jeder Sender bekommt seine eigene private Playlist – angelegt beim ersten `/fav` auf dem Sender.',
            links.length ? `Wiedergefunden: ${links.join(' · ')}` : '',
            missing ? `${songs(missing)} aus deinen Favoriten fehlen noch → \`/youtube nachtragen\`` : '',
          ].filter(Boolean).join('\n'))],
      });
    } catch (err) {
      log(`YouTube-Login für ${i.user.id} fehlgeschlagen:`, err.message);
      await i.editReply({ content: `⚠️ ${err.message}`, embeds: [] }).catch(() => {});
    } finally {
      pendingLogins.delete(i.user.id);
    }
  }

  /** Steuern darf, wer im Voice-Channel des Bots sitzt oder "Server verwalten" hat. */
  async function canControl(i) {
    const botChannel = i.guild?.members.me?.voice.channelId;
    const member = await i.guild?.members.fetch(i.user.id).catch(() => null);
    return Boolean(member?.permissions.has(PermissionFlagsBits.ManageGuild)
      || (botChannel && member?.voice.channelId === botChannel));
  }
  const notAllowed = (i) => i.reply({ ...ephemeral, content: 'Das kann nur, wer im Voice-Channel des Radios sitzt.' });

  async function handleSkip(i) {
    if (!radio.canSkip()) return i.reply({ ...ephemeral, content: '📡 Bei einem Live-Radio kann man nicht skippen.' });
    if (!(await canControl(i))) return notAllowed(i);
    await i.deferReply();
    const skipped = await radio.skip();
    log(`${i.user.tag} skippt${skipped ? ` ${skipped.text}` : ''}`);
    const now = await radio.nowPlaying();
    const what = skipped ? `**${esc(skipped.text)}**` : 'den Beitrag';
    return i.editReply(`⏭ ${i.user} hat ${what} übersprungen`
      // nowPlaying() liefert während Jingles den letzten Song -> nicht den gerade übersprungenen anzeigen
      + (now && now.id !== skipped?.id ? ` · jetzt: **${esc(now.text)}**` : '.'));
  }

  async function handlePause(i) {
    if (!(await canControl(i))) return notAllowed(i);
    await i.deferReply();
    const paused = await radio.togglePause();
    log(`${i.user.tag} ${paused ? 'pausiert' : 'setzt fort'}`);
    return i.editReply(paused
      ? `⏸ ${i.user} hat das Radio pausiert. Mit \`/pause\` geht's weiter.`
      : `▶️ ${i.user} hat das Radio fortgesetzt.`);
  }

  async function handleRadio(i) {
    const sub = i.options.getSubcommand();
    const cur = radio.current();
    const line = (st) => `${st.emoji} **${esc(st.name)}**${st.id === cur.id ? ' · *läuft*' : ''}\n${esc(st.description)}`;

    if (sub === 'liste') {
      return i.reply({
        ...ephemeral,
        embeds: [new EmbedBuilder()
          .setColor(COLOR)
          .setTitle('📻 Sender')
          .setDescription(radio.stations().map(line).join('\n\n'))
          .setFooter({ text: 'Umschalten: /radio wechseln' })],
      });
    }

    if (sub === 'werbung') {
      if (!(await canControl(i))) return notAllowed(i);
      const on = i.options.getString('status', true) === 'an';
      const was = i.options.getString('was') ?? 'beides';
      const kinds = was === 'beides' ? ['ads', 'news'] : [was];
      await i.deferReply();
      for (const k of kinds) await radio.setBreaks(k, on);
      const b = radio.breaks();
      const label = { beides: 'Werbung und Nachrichten', ads: 'Werbung', news: 'Nachrichten' }[was];
      log(`${i.user.tag}: ${label} ${on ? 'an' : 'aus'}`);
      return i.editReply(`${on ? '📢' : '🔇'} ${i.user} hat ${label} **${on ? 'angeschaltet' : 'abgeschaltet'}**.`
        + `\nWerbung: ${b.ads ? 'an' : 'aus'} · Nachrichten: ${b.news ? 'an' : 'aus'}`
        + (cur.type === 'gta' ? '' : '\n*(gilt für die GTA-Sender – Live-Radios senden ihr eigenes Programm)*'));
    }

    if (sub === 'jetzt') {
      const song = await radio.nowPlaying();
      const p = radio.progress();
      const status = radio.isPaused() ? '⏸ Pausiert' : (p ? radio.progressBar(p) : null);
      return i.reply({
        ...ephemeral,
        embeds: [new EmbedBuilder()
          .setColor(COLOR)
          .setTitle(`${cur.emoji} ${cur.name}`)
          .setDescription([
            song ? `🎵 ${esc(song.text)}` : (cur.dj ? `🎙️ ${esc(cur.dj)} ist dran` : 'Gerade kein Song'),
            status && `\`${status}\``,
          ].filter(Boolean).join('\n'))
          .setFooter({ text: 'Song merken: /fav' })],
      });
    }

    // wechseln
    const id = i.options.getString('sender', true);
    const target = radio.stations().find((st) => st.id === id);
    if (!target) return i.reply({ ...ephemeral, content: 'Den Sender gibt\'s nicht – schau in `/radio liste`.' });
    if (target.id === cur.id) return i.reply({ ...ephemeral, content: `${target.emoji} **${esc(target.name)}** läuft schon.` });

    if (!(await canControl(i))) {
      return i.reply({ ...ephemeral, content: 'Umschalten kann nur, wer im Voice-Channel des Radios sitzt.' });
    }

    await i.deferReply();
    const st = await radio.switchTo(target.id);
    log(`${i.user.tag} schaltet auf ${st.name}`);
    return i.editReply(`${st.emoji} ${i.user} hat auf **${esc(st.name)}** umgeschaltet.`);
  }

  const handlers = { radio: handleRadio, skip: handleSkip, pause: handlePause, fav: handleFav, favs: handleFavs, unfav: handleUnfav, youtube: handleYoutube };

  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand()) return;
    const handler = handlers[i.commandName];
    if (!handler) return;
    try {
      await handler(i);
    } catch (err) {
      log(`/${i.commandName} fehlgeschlagen:`, err);
      const msg = { content: '⚠️ Da ist was schiefgelaufen.', embeds: [] };
      if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
      else await i.reply({ ...ephemeral, ...msg }).catch(() => {});
    }
  });
}
