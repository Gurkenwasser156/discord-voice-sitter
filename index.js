import { Client, GatewayIntentBits, Events } from 'discord.js';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { createRadio } from './radio.js';
import { createStore } from './store.js';
import { createYoutube } from './youtube.js';
import { setupCommands } from './commands.js';

try { process.loadEnvFile(); } catch { /* keine .env -> Umgebungsvariablen nutzen */ }

const { DISCORD_TOKEN, GUILD_ID, CHANNEL_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID || !CHANNEL_ID) {
  console.error('DISCORD_TOKEN, GUILD_ID und CHANNEL_ID müssen gesetzt sein (.env).');
  process.exit(1);
}

const WATCHDOG_MS = 5_000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let radio;
try {
  radio = await createRadio(client, process.env);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Private Favoriten (/fav, /favs, /unfav) + optionale YouTube-Playlist (/youtube)
const youtube = createYoutube({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
});
setupCommands({
  client,
  guildId: GUILD_ID,
  radio,
  store: createStore(process.env.DATA_DIR || './data'),
  youtube,
});
log(youtube ? 'YouTube-Playlists aktiv' : 'YouTube-Playlists aus (GOOGLE_CLIENT_ID/SECRET nicht gesetzt)');

let connection = null;
let joining = false;
let retryTimer = null;
// Aktueller Ziel-Channel: startet bei CHANNEL_ID, folgt aber, wenn jemand den Bot verschiebt
let targetChannelId = CHANNEL_ID;

// Grundregel: Der Bot zerstört seine Voice-Verbindung NIE selbst.
// Statt destroy() wird immer rejoin() genutzt -> kein unnötiger Leave.

function inTargetChannel() {
  return client.guilds.cache.get(GUILD_ID)?.members.me?.voice.channelId === targetChannelId;
}

function isHealthy() {
  if (!connection) return false;
  const s = connection.state.status;
  return s !== VoiceConnectionStatus.Destroyed
    && s !== VoiceConnectionStatus.Disconnected
    && inTargetChannel();
}

function scheduleJoin(delay) {
  if (retryTimer) return; // nur ein ausstehender Versuch gleichzeitig
  retryTimer = setTimeout(() => { retryTimer = null; ensureJoined(); }, delay);
}

function attachHandlers(conn) {
  conn.on('stateChange', (oldS, newS) => {
    if (oldS.status !== newS.status) log(`Voice: ${oldS.status} -> ${newS.status}`);
  });

  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    // Discord reconnectet oft selbst (Move, Voice-Server-Wechsel)
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 3_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 3_000),
      ]);
    } catch {
      if (conn === connection && conn.state.status === VoiceConnectionStatus.Disconnected) {
        log('Getrennt -> rejoin');
        conn.rejoin({ channelId: targetChannelId, selfDeaf: true, selfMute: false });
      }
    }
  });

  conn.on(VoiceConnectionStatus.Destroyed, () => {
    if (conn === connection) connection = null;
    log('Verbindung zerstört -> neu verbinden');
    scheduleJoin(500);
  });

  conn.on('error', (err) => log('Voice-Fehler:', err.message));
}

async function ensureJoined() {
  if (joining || !client.isReady() || isHealthy()) return;
  joining = true;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
    if (!channel?.isVoiceBased()) {
      if (targetChannelId !== CHANNEL_ID) {
        // Channel, in den der Bot verschoben wurde, gibt's nicht mehr -> zurück zum Standard
        log(`Channel ${targetChannelId} nicht mehr verfügbar -> zurück zu CHANNEL_ID`);
        targetChannelId = CHANNEL_ID;
      }
      throw new Error('Ziel ist kein (erreichbarer) Voice-Channel');
    }

    // joinVoiceChannel nutzt eine bestehende Verbindung weiter (rejoin statt leave)
    const conn = joinVoiceChannel({
      guildId: GUILD_ID,
      channelId: targetChannelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    if (conn !== connection) {
      connection = conn;
      attachHandlers(conn);
    }
    // Player an die (ggf. neue) Verbindung hängen; rejoin() behält die Subscription
    conn.subscribe(radio.player);

    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    log(`Im Channel "${channel.name}"`);
  } catch (err) {
    log('Join fehlgeschlagen:', err.message, '-> neuer Versuch in 3s');
    scheduleJoin(3_000);
  } finally {
    joining = false;
  }
}

// Verschoben -> im neuen Channel bleiben. Rausgekickt -> zurück in den letzten Channel.
client.on(Events.VoiceStateUpdate, (_old, newState) => {
  if (newState.id !== client.user.id || newState.guild.id !== GUILD_ID) return;

  if (newState.channelId) {
    if (newState.channelId !== targetChannelId) {
      targetChannelId = newState.channelId;
      log(`Verschoben nach "${newState.channel?.name ?? newState.channelId}" -> bleibe hier`);
    }
    return;
  }

  log('Aus dem Channel entfernt -> zurück');
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    connection.rejoin({ channelId: targetChannelId, selfDeaf: true, selfMute: false });
  } else {
    scheduleJoin(0);
  }
});

client.once(Events.ClientReady, (c) => {
  log(`Eingeloggt als ${c.user.tag}`);
  radio.start();
  ensureJoined();
  // Watchdog: greift nur ein, wenn der Bot wirklich nicht im Channel ist
  setInterval(() => { if (!isHealthy()) ensureJoined(); }, WATCHDOG_MS);
});

// Nach Gateway-Reconnect nur prüfen, nicht blind neu joinen
client.on(Events.ShardResume, () => { if (!isHealthy()) scheduleJoin(1_000); });
client.on(Events.ShardReady, () => { if (!isHealthy()) scheduleJoin(1_000); });
client.on(Events.Error, (err) => log('Client-Fehler:', err.message));

// Niemals wegen eines Fehlers abstürzen
process.on('unhandledRejection', (err) => log('unhandledRejection:', err));
process.on('uncaughtException', (err) => log('uncaughtException:', err));

function login() {
  client.login(DISCORD_TOKEN).catch((err) => {
    if (err.code === 'TokenInvalid') {
      console.error('Token ungültig – bitte DISCORD_TOKEN prüfen.');
      process.exit(1);
    }
    log('Login fehlgeschlagen:', err.message, '-> neuer Versuch in 5s');
    setTimeout(login, 5_000);
  });
}
login();
