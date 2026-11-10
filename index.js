
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType
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
import ffmpegPath from "ffmpeg-static";

// ==========================================
// 1. ENVIRONMENT VARIABLES
// ==========================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

const PORT = Number(process.env.PORT || 10000);

const REMINDER_INTERVAL_MINUTES = Math.max(
  1,
  Number(process.env.REMINDER_INTERVAL_MINUTES || 60)
);

const REMINDER_TEXT =
  process.env.REMINDER_TEXT ||
  "এক ঘণ্টা হয়ে গেছে। গেম শেষ করে পরের ম্যাচে নতুন করে ঢুকুন।";

// ==========================================
// 2. STARTUP DIAGNOSTIC LOGS
// ==========================================

console.log("======================================");
console.log("DISCORD BANGLA REMINDER BOT STARTING");
console.log("======================================");

console.log("Node Version:", process.version);
console.log("Token Exists:", Boolean(TOKEN));
console.log("Client ID Exists:", Boolean(CLIENT_ID));
console.log("Guild ID Exists:", Boolean(GUILD_ID));
console.log("Voice Channel ID Exists:", Boolean(VOICE_CHANNEL_ID));
console.log("FFmpeg Available:", Boolean(ffmpegPath));
console.log("Reminder Interval:", REMINDER_INTERVAL_MINUTES);
console.log("Reminder Text:", REMINDER_TEXT);

const missingVariables = [];

if (!TOKEN) missingVariables.push("DISCORD_TOKEN");
if (!CLIENT_ID) missingVariables.push("CLIENT_ID");
if (!GUILD_ID) missingVariables.push("GUILD_ID");
if (!VOICE_CHANNEL_ID) missingVariables.push("VOICE_CHANNEL_ID");

if (missingVariables.length > 0) {
  console.error("MISSING ENVIRONMENT VARIABLES:", missingVariables.join(", "));
  process.exit(1);
}

if (!ffmpegPath) {
  console.error("FFMPEG ERROR: ffmpeg-static binary not found.");
  process.exit(1);
}

// ==========================================
// 3. DISCORD CLIENT
// ==========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const player = createAudioPlayer();

let connection = null;
let reminderTimer = null;
let reconnectTimer = null;
let reminderBusy = false;
let manualLeaving = false;
let lastError = null;
let lastReminderAt = null;

// ==========================================
// 4. HTTP HEALTH SERVER
// ==========================================

const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/health") {
    const voiceState = connection?.state?.status || "not-connected";

    res.writeHead(200);

    res.end(JSON.stringify({
      status: "online",
      bot: client.user?.tag || "starting",
      botId: client.user?.id || null,
      voice: voiceState,
      guildId: GUILD_ID,
      voiceChannelId: VOICE_CHANNEL_ID,
      reminderIntervalMinutes: REMINDER_INTERVAL_MINUTES,
      reminderBusy,
      lastReminderAt,
      lastError
    }, null, 2));

    return;
  }

  res.writeHead(200);

  res.end(JSON.stringify({
    message: "Discord Bangla Reminder Bot is running."
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("HEALTH SERVER LISTENING ON PORT:", PORT);
  console.log("HEALTH URL: /health");
});

// ==========================================
// 5. AUDIO PLAYER LOGS
// ==========================================

player.on(AudioPlayerStatus.Playing, () => {
  console.log("AUDIO PLAYER: Playing.");
});

player.on(AudioPlayerStatus.Idle, () => {
  console.log("AUDIO PLAYER: Idle.");
});

player.on("error", (error) => {
  lastError = error.message;
  console.error("AUDIO PLAYER ERROR:", error);
});

// ==========================================
// 6. REMINDER TIMER
// ==========================================

function stopReminderLoop() {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
    console.log("REMINDER TIMER STOPPED.");
  }
}

function startReminderLoop() {
  if (reminderTimer) {
    console.log("REMINDER TIMER ALREADY RUNNING.");
    return;
  }

  const intervalMs = REMINDER_INTERVAL_MINUTES * 60 * 1000;

  console.log(
    `REMINDER TIMER STARTED: Every ${REMINDER_INTERVAL_MINUTES} minutes.`
  );

  // প্রথম Reminder সঙ্গে সঙ্গে পাঠাবে
  runReminder("initial").catch((error) => {
    console.error("INITIAL REMINDER ERROR:", error);
  });

  reminderTimer = setInterval(() => {
    runReminder("scheduled").catch((error) => {
      console.error("SCHEDULED REMINDER ERROR:", error);
    });
  }, intervalMs);
}

// ==========================================
// 7. GOOGLE BANGLA TTS + FFMPEG
// ==========================================

async function playTTSOnce() {
  console.log("TTS: Preparing Bangla voice...");

  const audioUrl = await getAudioUrl(REMINDER_TEXT, {
    lang: "bn",
    slow: false,
    host: "https://translate.google.com"
  });

  console.log("TTS: Audio URL generated.");

  const response = await fetch(audioUrl);

  if (!response.ok) {
    throw new Error(`TTS DOWNLOAD FAILED: HTTP ${response.status}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  if (audioBuffer.length === 0) {
    throw new Error("TTS returned an empty audio file.");
  }

  console.log("TTS: Audio downloaded:", audioBuffer.length, "bytes");
  console.log("FFMPEG: Starting audio conversion...");

  const ffmpeg = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1"
  ]);

  ffmpeg.stderr.on("data", (data) => {
    console.error("FFMPEG STDERR:", data.toString());
  });

  ffmpeg.on("error", (error) => {
    console.error("FFMPEG PROCESS ERROR:", error);
  });

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw
  });

  const playbackPromise = new Promise((resolve, reject) => {
    let finished = false;

    const timeout = setTimeout(() => {
      finish(new Error("Audio playback timed out."));
    }, 90000);

    function finish(error) {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);

      player.removeListener(AudioPlayerStatus.Idle, onIdle);
      player.removeListener("error", onPlayerError);

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    function onIdle() {
      finish();
    }

    function onPlayerError(error) {
      finish(error);
    }

    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onPlayerError);

    console.log("TTS: Sending audio to Discord voice player.");

    player.play(resource);
  });

  ffmpeg.stdin.on("error", (error) => {
    console.error("FFMPEG INPUT ERROR:", error.message);
  });

  ffmpeg.stdin.end(audioBuffer);

  await playbackPromise;

  console.log("TTS: Playback completed successfully.");
}

// ==========================================
// 8. SEND REMINDER TWICE
// ==========================================

async function runReminder(source = "manual") {
  if (reminderBusy) {
    console.log("REMINDER SKIPPED: Another reminder is running.");
    return false;
  }

  if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
    console.log("REMINDER SKIPPED: Voice connection is not ready.");
    return false;
  }

  reminderBusy = true;

  console.log("======================================");
  console.log("REMINDER STARTED:", source);
  console.log("======================================");

  try {
    await playTTSOnce();

    console.log("REMINDER: Waiting 5 seconds.");

    await new Promise((resolve) => setTimeout(resolve, 5000));

    await playTTSOnce();

    lastReminderAt = new Date().toISOString();

    console.log("REMINDER COMPLETED: Both messages played.");
    return true;

  } catch (error) {
    lastError = error.message;
    console.error("REMINDER PLAYBACK FAILED:", error);
    return false;

  } finally {
    reminderBusy = false;
  }
}

// ==========================================
// 9. VOICE CHANNEL JOIN
// ==========================================

async function joinVoice() {
  console.log("VOICE: Trying to join channel:", VOICE_CHANNEL_ID);

  const guild = await client.guilds.fetch(GUILD_ID);

  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel) {
    throw new Error("VOICE CHANNEL NOT FOUND. Check VOICE_CHANNEL_ID.");
  }

  if (
    channel.type !== ChannelType.GuildVoice &&
    channel.type !== ChannelType.GuildStageVoice
  ) {
    throw new Error("Selected channel is not a voice or stage channel.");
  }

  const botMember = await guild.members.fetchMe();

  const permissions = channel.permissionsFor(botMember);

  if (!permissions?.has("Connect")) {
    throw new Error("BOT IS MISSING CONNECT PERMISSION.");
  }

  if (!permissions?.has("Speak") && channel.type === ChannelType.GuildVoice) {
    throw new Error("BOT IS MISSING SPEAK PERMISSION.");
  }

  if (
    connection &&
    connection.state.status === VoiceConnectionStatus.Ready
  ) {
    console.log("VOICE: Already connected.");
    return true;
  }

  if (connection) {
    try {
      connection.removeAllListeners();
      connection.destroy();
    } catch (error) {
      console.error("OLD VOICE CONNECTION CLEANUP:", error.message);
    }
  }

  manualLeaving = false;

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  connection.subscribe(player);

  connection.on(VoiceConnectionStatus.Ready, () => {
    console.log("======================================");
    console.log("SUCCESS: BOT JOINED VOICE CHANNEL!");
    console.log("VOICE CHANNEL:", channel.name);
    console.log("======================================");

    startReminderLoop();
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    console.error("VOICE: Connection disconnected.");

    if (!manualLeaving) {
      scheduleReconnect();
    }
  });

  connection.on("error", (error) => {
    lastError = error.message;
    console.error("VOICE CONNECTION ERROR:", error);
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    console.log("VOICE: Connection destroyed.");
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30000);

  console.log("VOICE: Ready confirmation received.");

  return true;
}

// ==========================================
// 10. AUTOMATIC RECONNECT
// ==========================================

function scheduleReconnect() {
  if (manualLeaving || reconnectTimer) return;

  console.log("VOICE: Reconnect scheduled in 5 seconds.");

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;

    try {
      console.log("VOICE: Attempting reconnect...");
      await joinVoice();

    } catch (error) {
      lastError = error.message;
      console.error("VOICE RECONNECT FAILED:", error);

      scheduleReconnect();
    }
  }, 5000);
}

// ==========================================
// 11. VOICE CHANNEL LEAVE
// ==========================================

function leaveVoice() {
  console.log("VOICE: Leaving channel...");

  manualLeaving = true;

  stopReminderLoop();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  player.stop(true);

  if (connection) {
    try {
      connection.removeAllListeners();
      connection.destroy();
    } catch (error) {
      console.error("VOICE LEAVE ERROR:", error);
    }

    connection = null;
  }

  console.log("VOICE: Successfully disconnected.");

  return true;
}

// ==========================================
// 12. SLASH COMMANDS
// ==========================================

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join the configured reminder voice channel"),

  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Start the voice reminder bot"),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop voice reminders and leave"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Check bot and voice connection status"),

  new SlashCommandBuilder()
    .setName("test")
    .setDescription("Play the Bangla reminder immediately")
].map((command) => command.toJSON());

// ==========================================
// 13. REGISTER SLASH COMMANDS
// ==========================================

async function registerCommands() {
  console.log("COMMANDS: Starting slash command registration...");

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    const result = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log("======================================");
    console.log("SUCCESS: SLASH COMMANDS REGISTERED!");
    console.log("COMMAND COUNT:", result.length);
    console.log("COMMAND NAMES:", commands.map((c) => c.name).join(", "));
    console.log("======================================");

  } catch (error) {
    lastError = error.message;

    console.error("SLASH COMMAND REGISTRATION FAILED:", error);
    throw error;
  }
}

// ==========================================
// 14. INTERACTION HANDLER
// ==========================================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  console.log("COMMAND RECEIVED:", interaction.commandName);
  console.log("COMMAND USER:", interaction.user.tag);

  try {
    const command = interaction.commandName;

    if (command === "join" || command === "start") {
      await interaction.deferReply({ ephemeral: true });

      await joinVoice();

      await interaction.editReply(
        "সফলভাবে Voice Channel-এ Join করার চেষ্টা সম্পন্ন হয়েছে।"
      );

      return;
    }

    if (command === "leave" || command === "stop") {
      leaveVoice();

      await interaction.reply({
        content: "Bot Voice Channel থেকে বের হয়েছে এবং Reminder বন্ধ হয়েছে।",
        ephemeral: true
      });

      return;
    }

    if (command === "status") {
      const voiceStatus = connection?.state?.status || "not-connected";

      await interaction.reply({
        content:
          `**Bot:** ${client.user?.tag || "Offline"}\n` +
          `**Voice:** ${voiceStatus}\n` +
          `**Reminder:** ${reminderTimer ? "Running" : "Stopped"}\n` +
          `**Interval:** ${REMINDER_INTERVAL_MINUTES} minutes`,
        ephemeral: true
      });

      return;
    }

    if (command === "test") {
      await interaction.deferReply({ ephemeral: true });

      const success = await runReminder("test-command");

      await interaction.editReply(
        success
          ? "বাংলা Reminder সফলভাবে Voice Channel-এ বাজানো হয়েছে।"
          : "Reminder বাজানো যায়নি। Render Logs পরীক্ষা করুন।"
      );

      return;
    }

  } catch (error) {
    lastError = error.message;

    console.error("COMMAND EXECUTION ERROR:", error);

    const message = "Command চালাতে সমস্যা হয়েছে। Render Logs পরীক্ষা করুন।";

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message);
      } else {
        await interaction.reply({
          content: message,
          ephemeral: true
        });
      }
    } catch (replyError) {
      console.error("COMMAND REPLY ERROR:", replyError);
    }
  }
});

// ==========================================
// 15. DISCORD CLIENT EVENTS
// ==========================================

client.once(Events.ClientReady, async (readyClient) => {
  console.log("======================================");
  console.log("SUCCESS: DISCORD BOT LOGGED IN!");
  console.log("BOT USER:", readyClient.user.tag);
  console.log("BOT ID:", readyClient.user.id);
  console.log("======================================");

  try {
    await registerCommands();
  } catch (error) {
    console.error("COMMAND REGISTRATION ERROR:", error);
  }

  try {
    console.log("STARTUP: Automatic voice join beginning...");
    await joinVoice();

  } catch (error) {
    lastError = error.message;

    console.error("AUTOMATIC VOICE JOIN FAILED:", error);

    scheduleReconnect();
  }
});

client.on("error", (error) => {
  lastError = error.message;
  console.error("DISCORD CLIENT ERROR:", error);
});

client.on("warn", (warning) => {
  console.warn("DISCORD CLIENT WARNING:", warning);
});

client.on("shardError", (error) => {
  lastError = error.message;
  console.error("DISCORD GATEWAY ERROR:", error);
});

client.on("shardDisconnect", (event, shardId) => {
  console.error("DISCORD SHARD DISCONNECTED:", shardId, event);
});

client.on("shardReconnecting", (shardId) => {
  console.log("DISCORD SHARD RECONNECTING:", shardId);
});

// ==========================================
// 16. PROCESS ERROR LOGS
// ==========================================

process.on("unhandledRejection", (error) => {
  console.error("UNHANDLED PROMISE REJECTION:", error);
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
  process.exit(1);
});

// ==========================================
// 17. LOGIN
// ==========================================

console.log("DISCORD: Sending login request...");

client.login(TOKEN)
  .then(() => {
    console.log("DISCORD: Login request accepted.");
  })
  .catch((error) => {
    lastError = error.message;

    console.error("======================================");
    console.error("DISCORD LOGIN FAILED!");
    console.error("ERROR MESSAGE:", error.message);
    console.error("ERROR CODE:", error.code || "unknown");
    console.error("======================================");
  });
