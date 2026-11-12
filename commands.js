import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  Events,
} from 'discord.js';

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

const commandData = [
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
    .addSubcommand((s) => s.setName('nachtragen').setDescription(`Favoriten ohne YouTube-Eintrag nachtragen (max. ${SYNC_LIMIT})`)),
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
      await guild.commands.set(commandData);
      log('Slash-Commands registriert');
    } catch (err) {
      log('Slash-Commands konnten nicht registriert werden:', err.message,
        '-> Bot mit Scope "applications.commands" neu einladen?');
    }
  });

  /** Fügt einen Favoriten zur YouTube-Playlist hinzu. Gibt eine Textzeile fürs Ergebnis zurück. */
  async function syncToYoutube(userId, fav) {
    const yt = store.youtube(userId);
    if (!yt) return null;
    try {
      const r = await youtube.addSong(yt, fav);
      store.updateFav(userId, fav.id, { yt: { videoId: r.videoId, itemId: r.itemId } });
      if (r.playlistId !== yt.playlistId) store.setYoutube(userId, { ...yt, playlistId: r.playlistId });
      return { ok: true, line: `▶️ In deiner [YouTube-Playlist](${youtube.playlistUrl(r.playlistId)}) · [Video](${youtube.videoUrl(r.videoId)})` };
    } catch (err) {
      log(`YouTube für ${userId}:`, err.message);
      if (err.code === 'quota') return { ok: false, stop: true, line: '⚠️ YouTube-Tageslimit erreicht – morgen mit `/youtube nachtragen` hinzufügen.' };
      if (err.code === 'revoked') return { ok: false, stop: true, line: `⚠️ ${err.message}` };
      if (err.code === 'novideo') return { ok: false, line: '⚠️ Kein passendes Video auf YouTube gefunden.' };
      return { ok: false, stop: true, line: `⚠️ YouTube: ${err.message}` };
    }
  }

  async function handleFav(i) {
    await i.deferReply(ephemeral);
    const song = await radio.nowPlaying();
    if (!song) return i.editReply('Gerade läuft nichts, was ich speichern könnte.');

    const { fav, added } = store.addFav(i.user.id, song);
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

    const lines = favs.slice(start, start + PAGE_SIZE).map((f, k) => {
      const yt = f.yt ? youtube?.videoUrl(f.yt.videoId) ?? ytSearch(f) : ytSearch(f);
      return `**${start + k + 1}.** ${esc(f.text)} · [YouTube](${yt}) · [Spotify](${spotifySearch(f)})`;
    });

    const yt = store.youtube(i.user.id);
    if (yt && youtube) lines.unshift(`▶️ [Deine YouTube-Playlist](${youtube.playlistUrl(yt.playlistId)})\n`);

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
    const yt = store.youtube(i.user.id);

    if (sub === 'status') {
      if (!yt) return i.reply({ ...ephemeral, content: 'Nicht verbunden. Mit `/youtube verbinden` legst du eine private Playlist an.' });
      const missing = store.favs(i.user.id).filter((f) => !f.yt).length;
      return i.reply({
        ...ephemeral,
        content: `✅ Verbunden · [Deine Playlist](${youtube.playlistUrl(yt.playlistId)})`
          + (missing ? `\n${missing} Favoriten sind noch nicht drin → \`/youtube nachtragen\`` : ''),
      });
    }

    if (sub === 'trennen') {
      if (!yt) return i.reply({ ...ephemeral, content: 'Du bist gar nicht verbunden.' });
      await youtube.revoke(yt.refreshToken);
      store.setYoutube(i.user.id, null);
      return i.reply({ ...ephemeral, content: '👋 Google-Account getrennt. Deine Favoriten bleiben hier gespeichert, die Playlist bleibt in deinem YouTube-Account.' });
    }

    if (sub === 'nachtragen') {
      if (!yt) return i.reply({ ...ephemeral, content: 'Erst `/youtube verbinden`.' });
      const todo = store.favs(i.user.id).filter((f) => !f.yt);
      if (!todo.length) return i.reply({ ...ephemeral, content: '✅ Alle Favoriten sind schon in der Playlist.' });

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
      const rest = store.favs(i.user.id).filter((f) => !f.yt).length;
      const ytNow = store.youtube(i.user.id);
      return i.editReply(
        `▶️ ${songs(done)} zur [Playlist](${youtube.playlistUrl(ytNow.playlistId)}) hinzugefügt.`
        + (problems.length ? `\n${problems.slice(0, 5).map((p) => `• ${p}`).join('\n')}` : '')
        + (rest ? `\nNoch ${rest} offen.` : ''),
      );
    }

    // verbinden
    if (yt) {
      return i.reply({ ...ephemeral, content: `Schon verbunden · [Deine Playlist](${youtube.playlistUrl(yt.playlistId)}). Zum Wechseln erst \`/youtube trennen\`.` });
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
          '**3.** Mit dem Google-Account einloggen, in dem die Playlist landen soll, und Zugriff erlauben.',
          '',
          'Falls Google „App nicht verifiziert“ anzeigt: *Erweitert → Weiter zu …*',
          `Der Code läuft <t:${Math.floor(login.expiresAt / 1000)}:R> ab. Ich melde mich hier, sobald es geklappt hat.`,
        ].join('\n'))],
    });

    try {
      const refreshToken = await login.done;
      const playlistId = await youtube.createPlaylist(refreshToken);
      store.setYoutube(i.user.id, { refreshToken, playlistId });
      log(`YouTube verbunden für ${i.user.id}`);
      const missing = store.favs(i.user.id).length;
      await i.editReply({
        embeds: [new EmbedBuilder()
          .setColor(COLOR)
          .setTitle('✅ YouTube verbunden')
          .setDescription([
            `Private Playlist angelegt: [öffnen](${youtube.playlistUrl(playlistId)})`,
            'Ab jetzt landet jeder `/fav` automatisch darin.',
            missing ? `Deine ${missing} bisherigen Favoriten kannst du mit \`/youtube nachtragen\` übernehmen.` : '',
          ].filter(Boolean).join('\n'))],
      });
    } catch (err) {
      log(`YouTube-Login für ${i.user.id} fehlgeschlagen:`, err.message);
      await i.editReply({ content: `⚠️ ${err.message}`, embeds: [] }).catch(() => {});
    } finally {
      pendingLogins.delete(i.user.id);
    }
  }

  const handlers = { fav: handleFav, favs: handleFavs, unfav: handleUnfav, youtube: handleYoutube };

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
