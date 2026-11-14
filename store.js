import fs from 'node:fs';
import path from 'node:path';

// Einfacher JSON-Speicher für Favoriten + YouTube-Verknüpfungen pro Discord-User.
// Ein Prozess, wenige Schreibzugriffe -> synchron schreiben (tmp + rename = atomar).
//
// {
//   users: {
//     "<discordUserId>": {
//       favs: [{ id, artist, title, album, text, art, savedAt, yt?: { videoId, itemId } }],
//       youtube?: { refreshToken, playlistId }
//     }
//   }
// }

export function createStore(dataDir) {
  const file = path.join(dataDir, 'favorites.json');
  fs.mkdirSync(dataDir, { recursive: true });

  let data = { users: {} };
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.users ??= {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Kaputte Datei nicht überschreiben, sondern beiseitelegen
      const backup = `${file}.broken-${Date.now()}`;
      fs.renameSync(file, backup);
      console.error(`favorites.json war kaputt -> gesichert als ${backup}`);
    }
  }

  console.log(new Date().toISOString(), '[favs]',
    `${Object.keys(data.users).length} User mit Favoriten geladen aus ${path.resolve(file)}`);

  function save() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function user(id) {
    data.users[id] ??= { favs: [] };
    data.users[id].favs ??= [];
    return data.users[id];
  }

  return {
    favs: (userId) => user(userId).favs,

    /** Fügt hinzu; gibt { fav, added } zurück (added=false, wenn schon vorhanden). */
    addFav(userId, song) {
      const u = user(userId);
      const existing = u.favs.find((f) => f.id === song.id);
      if (existing) return { fav: existing, added: false };
      const fav = { ...song, savedAt: new Date().toISOString() };
      u.favs.push(fav);
      save();
      return { fav, added: true };
    },

    /** Entfernt den n-ten Favoriten (1-basiert, Reihenfolge wie in /favs). */
    removeFav(userId, n) {
      const u = user(userId);
      const idx = u.favs.length - n; // /favs zeigt neueste zuerst
      if (n < 1 || idx < 0) return null;
      const [removed] = u.favs.splice(idx, 1);
      save();
      return removed;
    },

    updateFav(userId, favId, patch) {
      const fav = user(userId).favs.find((f) => f.id === favId);
      if (!fav) return;
      Object.assign(fav, patch);
      save();
    },

    youtube: (userId) => data.users[userId]?.youtube ?? null,

    setYoutube(userId, yt) {
      const u = user(userId);
      if (yt) u.youtube = yt;
      else delete u.youtube;
      save();
    },
  };
}
