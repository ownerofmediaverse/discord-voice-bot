
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Events
} from "discord.js";

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState
} from "@discordjs/voice";

import { getAudioUrl } from "google-tts-api";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";

// ===============================
// ENVIRONMENT SETTINGS
// ===============================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

const PORT = Number(process.env.PORT || 3000);
const INTERVAL_MINUTES = Number(
  process.env.REMINDER_INTERVAL_MINUTES || 60
);

const REMINDER_TEXT =
  process.env.REMINDER_TEXT ||
  "এক ঘণ্টা হয়ে গেছে। গেম শেষ করে পরের ম্যাচে নতুন করে ঢুকুন।";

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error("Missing required Environment Variables.");
  process.exit(1);
}

if (!ffmpegPath) {
  console.error("FFmpeg executable was not found.");
  process.exit(1);
}

// ===============================
// HTTP HEALTH CHECK SERVER
// ===============================

const server = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      status: "online",
      bot: client?.user?.tag || "starting",
      voice: connection?.state?.status || "not-connected"
    }));

    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Health server listening on port ${PORT}`);
});

// ===============================
// DISCORD CLIENT
// ===============================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

const player = createAudioPlayer();

let connection = null;
let manualLeave = false;
let reconnectTimer = null;
let reminderTimer = null;
let reminderStarted = false;
let reminderRunning = false;

// ===============================
// SLASH COMMANDS
// ===============================

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Bot voice channel-এ join করবে")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    ),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Bot voice channel থেকে বের হবে")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    ),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Bot-এর বর্তমান অবস্থা দেখাবে")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    ),

  new SlashCommandBuilder()
    .setName("test")
    .setDescription("একটি পরীক্ষামূলক Reminder পাঠাবে")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    )
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Slash commands registered.");
}

// ===============================
// VOICE CONNECTION
// ===============================

async function joinVoice() {
  manualLeave = false;

  if (connection) {
    try {
      connection.destroy();
    } catch {}
    connection = null;
  }

  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel || !channel.isVoiceBased()) {
    throw new Error("Voice channel not found.");
  }

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false
  });

  connection.subscribe(player);

  connection.on("error", error => {
    console.error("Voice connection error:", error);
  });

  connection.on(
    VoiceConnectionStatus.Disconnected,
    () => {
      console.log("Voice disconnected.");

      if (!manualLeave) {
        scheduleReconnect();
      }
    }
  );

  await entersState(
    connection,
    VoiceConnectionStatus.Ready,
    30000
  );

  console.log("Bot connected to voice channel.");

  startReminderLoop();
}

// ===============================
// RECONNECT SYSTEM
// ===============================

function scheduleReconnect() {
  if (manualLeave || reconnectTimer) return;

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;

    try {
      console.log("Trying to reconnect...");
      await joinVoice();
    } catch (error) {
      console.error("Reconnect failed:", error);
      scheduleReconnect();
    }
  }, 10000);
}

// ===============================
// BANGLA TTS PLAYBACK
// ===============================

async function playTTSOnce() {
  if (
    !connection ||
    connection.state.status !== VoiceConnectionStatus.Ready
  ) {
    throw new Error("Voice connection is not ready.");
  }

  const audioUrl = getAudioUrl(REMINDER_TEXT, {
    lang: "bn",
    slow: false,
    host: "https://translate.google.com"
  });

  const response = await fetch(audioUrl);

  if (!response.ok || !response.body) {
    throw new Error("TTS audio download failed.");
  }

  const ffmpeg = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1"
  ]);

  ffmpeg.on("error", error => {
    console.error("FFmpeg error:", error);
  });

  Readable.fromWeb(response.body).pipe(ffmpeg.stdin);

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      ffmpeg.kill();
      reject(new Error("Audio playback timed out."));
    }, 90000);

    function cleanup() {
      clearTimeout(timeout);
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off("error", onError);
    }

    function onIdle() {
      cleanup();
      resolve();
    }

    function onError(error) {
      cleanup();
      ffmpeg.kill();
      reject(error);
    }

    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onError);

    player.play(resource);
  });
}

// ===============================
// REMINDER SYSTEM
// ===============================

const wait = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

async function sendReminder() {
  if (reminderRunning) return;

  reminderRunning = true;

  try {
    console.log("Playing reminder...");

    await playTTSOnce();

    await wait(5000);

    await playTTSOnce();

    console.log("Reminder completed.");
  } catch (error) {
    console.error("Reminder failed:", error);
  } finally {
    reminderRunning = false;
  }
}

function startReminderLoop() {
  if (reminderStarted) return;

  reminderStarted = true;

  // First reminder immediately after connection
  sendReminder();

  // Repeat at the configured interval
  reminderTimer = setInterval(() => {
    sendReminder();
  }, INTERVAL_MINUTES * 60 * 1000);

  console.log(
    `Reminder interval: ${INTERVAL_MINUTES} minutes`
  );
}

// ===============================
// LEAVE VOICE
// ===============================

function leaveVoice() {
  manualLeave = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }

  reminderStarted = false;

  if (connection) {
    connection.destroy();
    connection = null;
  }
}

// ===============================
// COMMAND INTERACTIONS
// ===============================

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "join") {
      await interaction.deferReply();

      await joinVoice();

      await interaction.editReply(
        "✅ Bot voice channel-এ যুক্ত হয়েছে!"
      );
    }

    else if (interaction.commandName === "leave") {
      leaveVoice();

      await interaction.reply(
        "👋 Bot voice channel থেকে বের হয়েছে।"
      );
    }

    else if (interaction.commandName === "status") {
      await interaction.reply({
        content:
          `Bot: Online\nVoice: ${connection?.state?.status || "Disconnected"}\nReminder: প্রতি ${INTERVAL_MINUTES} মিনিটে`,
        ephemeral: true
      });
    }

    else if (interaction.commandName === "test") {
      await interaction.deferReply({
        ephemeral: true
      });

      await sendReminder();

      await interaction.editReply(
        "✅ Test reminder সম্পন্ন হয়েছে।"
      );
    }
  } catch (error) {
    console.error("Command error:", error);

    const message = "❌ Command চালাতে সমস্যা হয়েছে।";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({
        content: message,
        ephemeral: true
      }).catch(() => {});
    }
  }
});

// ===============================
// BOT START
// ===============================

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    await registerCommands();
    await joinVoice();
  } catch (error) {
    console.error("Startup error:", error);
    scheduleReconnect();
  }
});

// ===============================
// ERROR HANDLING
// ===============================

player.on("error", error => {
  console.error("Audio player error:", error);
});

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});

client.on(Events.Error, error => {
  console.error("Discord client error:", error);
});

client.login(TOKEN);
