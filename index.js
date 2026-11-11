import { Client, GatewayIntentBits, Events } from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';

try { process.loadEnvFile(); } catch { /* keine .env -> Umgebungsvariablen nutzen */ }

const { DISCORD_TOKEN, GUILD_ID, CHANNEL_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID || !CHANNEL_ID) {
  console.error('DISCORD_TOKEN, GUILD_ID und CHANNEL_ID müssen gesetzt sein (.env).');
  process.exit(1);
}

const WATCHDOG_MS = 15_000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let joining = false;

async function join() {
  if (joining || !client.isReady()) return;
  joining = true;
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(CHANNEL_ID);
    if (!channel?.isVoiceBased()) throw new Error('CHANNEL_ID ist kein Voice-Channel');

    getVoiceConnection(GUILD_ID)?.destroy();

    const connection = joinVoiceChannel({
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Kurz abwarten, ob Discord selbst reconnected (z.B. Region-Wechsel / Move)
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        log('Verbindung verloren -> rejoin');
        connection.destroy();
        setTimeout(join, 1_000);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      log('Verbindung zerstört -> rejoin');
      setTimeout(join, 2_000);
    });

    connection.on('error', (err) => log('Voice-Fehler:', err.message));

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    log(`Im Channel "${channel.name}"`);
  } catch (err) {
    log('Join fehlgeschlagen:', err.message, '-> neuer Versuch in 10s');
    setTimeout(join, 10_000);
  } finally {
    joining = false;
  }
}

// Wird der Bot gekickt oder verschoben -> sofort zurück
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.id !== client.user.id || newState.guild.id !== GUILD_ID) return;
  if (newState.channelId !== CHANNEL_ID) {
    log(`Aus dem Channel entfernt/verschoben (${newState.channelId ?? 'keiner'}) -> rejoin`);
    setTimeout(join, 1_000);
  }
});

client.once(Events.ClientReady, (c) => {
  log(`Eingeloggt als ${c.user.tag}`);
  join();

  // Watchdog: prüft regelmäßig, ob der Bot wirklich im Channel ist
  setInterval(() => {
    const conn = getVoiceConnection(GUILD_ID);
    const me = client.guilds.cache.get(GUILD_ID)?.members.me;
    const ok =
      conn &&
      conn.state.status !== VoiceConnectionStatus.Destroyed &&
      conn.state.status !== VoiceConnectionStatus.Disconnected &&
      me?.voice.channelId === CHANNEL_ID;
    if (!ok) {
      log('Watchdog: nicht im Channel -> rejoin');
      join();
    }
  }, WATCHDOG_MS);
});

// Nach Gateway-Reconnect sicherheitshalber neu joinen
client.on(Events.ShardResume, () => setTimeout(join, 2_000));
client.on(Events.Error, (err) => log('Client-Fehler:', err.message));

// Niemals wegen eines Fehlers abstürzen
process.on('unhandledRejection', (err) => log('unhandledRejection:', err));
process.on('uncaughtException', (err) => log('uncaughtException:', err));

client.login(DISCORD_TOKEN);
