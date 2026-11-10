
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits
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
// 2. STARTUP LOGS
// ==========================================

console.log("");
console.log("======================================");
console.log("DISCORD BANGLA REMINDER BOT STARTING");
console.log("======================================");

console.log("NODE VERSION:", process.version);
console.log("TOKEN EXISTS:", Boolean(TOKEN));
console.log("CLIENT ID EXISTS:", Boolean(CLIENT_ID));
console.log("GUILD ID EXISTS:", Boolean(GUILD_ID));
console.log("VOICE CHANNEL ID EXISTS:", Boolean(VOICE_CHANNEL_ID));
console.log("FFMPEG AVAILABLE:", Boolean(ffmpegPath));
console.log("REMINDER INTERVAL:", REMINDER_INTERVAL_MINUTES);

const missing = [];

if (!TOKEN) missing.push("DISCORD_TOKEN");
if (!CLIENT_ID) missing.push("CLIENT_ID");
if (!GUILD_ID) missing.push("GUILD_ID");
if (!VOICE_CHANNEL_ID) missing.push("VOICE_CHANNEL_ID");

if (missing.length) {
  console.error("MISSING VARIABLES:", missing.join(", "));
  process.exit(1);
}

if (!ffmpegPath) {
  console.error("FFMPEG BINARY NOT FOUND!");
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
let loginStartedAt = Date.now();

// ==========================================
// 4. HTTP HEALTH SERVER
// ==========================================

const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.url === "/health") {
    res.writeHead(200);

    res.end(JSON.stringify({
      status: "online",
      bot: client.user?.tag || "starting",
      botId: client.user?.id || null,
      ready: client.isReady(),
      gatewayStatus: client.ws.status,
      voice: connection?.state?.status || "not-connected",
      reminder: reminderTimer ? "running" : "stopped",
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
  console.log("HEALTH SERVER LISTENING:", PORT);
  console.log("HEALTH PATH: /health");
});

// ==========================================
// 5. DISCORD GATEWAY DIAGNOSTIC LOGS
// ==========================================

client.on("debug", (message) => {
  console.log("[DISCORD DEBUG]", message);
});

client.on("warn", (message) => {
  console.warn("[DISCORD WARNING]", message);
});

client.on("error", (error) => {
  lastError = error.message;
  console.error("[DISCORD CLIENT ERROR]", error);
});

client.on("shardReady", (shardId) => {
  console.log("[SHARD READY]", shardId);
});

client.on("shardError", (error, shardId) => {
  lastError = error.message;
  console.error("[SHARD ERROR]", shardId, error);
});

client.on("shardDisconnect", (event, shardId) => {
  console.error("[SHARD DISCONNECTED]", shardId);
  console.error("CLOSE CODE:", event?.code);
  console.error("CLOSE REASON:", event?.reason?.toString?.() || "none");
});

client.on("shardReconnecting", (shardId) => {
  console.log("[SHARD RECONNECTING]", shardId);
});

client.on("invalidated", () => {
  console.error("[DISCORD SESSION INVALIDATED]");
});

// ==========================================
// 6. LOGIN DIAGNOSTIC TIMER
// ==========================================

setTimeout(() => {
  console.log("");
  console.log("========== 30 SECOND LOGIN CHECK ==========");
  console.log("BOT READY:", client.isReady());
  console.log("BOT USER:", client.user?.tag || "NOT READY");
  console.log("GATEWAY STATUS:", client.ws.status);
  console.log("LOGIN ELAPSED:", Math.round((Date.now() - loginStartedAt) / 1000), "seconds");
  console.log("LAST ERROR:", lastError || "NONE");
  console.log("===========================================");
}, 30000);

// ==========================================
// 7. AUDIO PLAYER EVENTS
// ==========================================

player.on(AudioPlayerStatus.Playing, () => {
  console.log("[AUDIO] PLAYING");
});

player.on(AudioPlayerStatus.Idle, () => {
  console.log("[AUDIO] PLAYBACK FINISHED");
});

player.on("error", (error) => {
  lastError = error.message;
  console.error("[AUDIO PLAYER ERROR]", error);
});

// ==========================================
// 8. REMINDER TIMER
// ==========================================

function stopReminderLoop() {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }

  console.log("[REMINDER] TIMER STOPPED");
}

function startReminderLoop() {
  if (reminderTimer) {
    console.log("[REMINDER] TIMER ALREADY RUNNING");
    return;
  }

  console.log(
    "[REMINDER] TIMER STARTED:",
    REMINDER_INTERVAL_MINUTES,
    "MINUTES"
  );

  // প্রথম Reminder সঙ্গে সঙ্গে
  runReminder("initial").catch((error) => {
    console.error("[INITIAL REMINDER ERROR]", error);
  });

  reminderTimer = setInterval(() => {
    runReminder("scheduled").catch((error) => {
      console.error("[SCHEDULED REMINDER ERROR]", error);
    });
  }, REMINDER_INTERVAL_MINUTES * 60 * 1000);
}

// ==========================================
// 9. BANGLA GOOGLE TTS
// ==========================================

async function playTTSOnce() {
  console.log("[TTS] GENERATING BANGLA AUDIO");

  const audioUrl = await getAudioUrl(REMINDER_TEXT, {
    lang: "bn",
    slow: false
  });

  console.log("[TTS] AUDIO URL GENERATED");

  const response = await fetch(audioUrl);

  if (!response.ok) {
    throw new Error("TTS DOWNLOAD FAILED: HTTP " + response.status);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  if (!audioBuffer.length) {
    throw new Error("TTS AUDIO IS EMPTY");
  }

  console.log("[TTS] DOWNLOADED:", audioBuffer.length, "bytes");

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
    console.error("[FFMPEG]", data.toString());
  });

  ffmpeg.on("error", (error) => {
    console.error("[FFMPEG PROCESS ERROR]", error);
  });

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw
  });

  const playbackPromise = new Promise((resolve, reject) => {
    let finished = false;

    const timeout = setTimeout(() => {
      finish(new Error("AUDIO PLAYBACK TIMEOUT"));
    }, 90000);

    function finish(error) {
      if (finished) return;
      finished = true;

      clearTimeout(timeout);

      player.removeListener(AudioPlayerStatus.Idle, onIdle);
      player.removeListener("error", onError);

      if (error) reject(error);
      else resolve();
    }

    function onIdle() {
      finish();
    }

    function onError(error) {
      finish(error);
    }

    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onError);

    console.log("[TTS] STARTING DISCORD PLAYBACK");
    player.play(resource);
  });

  ffmpeg.stdin.on("error", (error) => {
    console.error("[FFMPEG INPUT ERROR]", error.message);
  });

  ffmpeg.stdin.end(audioBuffer);

  await playbackPromise;

  console.log("[TTS] PLAYBACK COMPLETED");
}

// ==========================================
// 10. REMINDER TWICE
// ==========================================

async function runReminder(source = "manual") {
  if (reminderBusy) {
    console.log("[REMINDER] ALREADY PLAYING, SKIPPED");
    return false;
  }

  if (
    !connection ||
    connection.state.status !== VoiceConnectionStatus.Ready
  ) {
    console.log("[REMINDER] VOICE CONNECTION NOT READY");
    return false;
  }

  reminderBusy = true;

  console.log("[REMINDER] STARTED:", source);

  try {
    await playTTSOnce();

    console.log("[REMINDER] WAITING 5 SECONDS");

    await new Promise((resolve) => setTimeout(resolve, 5000));

    await playTTSOnce();

    lastReminderAt = new Date().toISOString();

    console.log("[REMINDER] BOTH MESSAGES COMPLETED");

    return true;

  } catch (error) {
    lastError = error.message;
    console.error("[REMINDER ERROR]", error);

    return false;

  } finally {
    reminderBusy = false;
  }
}

// ==========================================
// 11. VOICE CHANNEL JOIN
// ==========================================

async function joinVoice() {
  console.log("[VOICE] JOIN REQUEST STARTED");
  console.log("[VOICE] GUILD ID:", GUILD_ID);
  console.log("[VOICE] CHANNEL ID:", VOICE_CHANNEL_ID);

  const guild = await client.guilds.fetch(GUILD_ID);

  console.log("[VOICE] GUILD FOUND:", guild.name);

  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel) {
    throw new Error("VOICE CHANNEL NOT FOUND. CHECK CHANNEL ID.");
  }

  console.log("[VOICE] CHANNEL FOUND:", channel.name);

  if (channel.type !== ChannelType.GuildVoice) {
    throw new Error("SELECTED CHANNEL IS NOT A NORMAL VOICE CHANNEL.");
  }

  const botMember = await guild.members.fetchMe();

  const permissions = channel.permissionsFor(botMember);

  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error("BOT NEEDS VIEW CHANNEL PERMISSION.");
  }

  if (!permissions?.has(PermissionFlagsBits.Connect)) {
    throw new Error("BOT NEEDS CONNECT PERMISSION.");
  }

  if (!permissions?.has(PermissionFlagsBits.Speak)) {
    throw new Error("BOT NEEDS SPEAK PERMISSION.");
  }

  if (
    connection &&
    connection.state.status === VoiceConnectionStatus.Ready
  ) {
    console.log("[VOICE] ALREADY CONNECTED");
    startReminderLoop();
    return true;
  }

  if (connection) {
    try {
      connection.removeAllListeners();
      connection.destroy();
    } catch (error) {
      console.error("[VOICE] OLD CONNECTION CLEANUP:", error.message);
    }

    connection = null;
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

  connection.on("stateChange", (oldState, newState) => {
    console.log(
      "[VOICE STATE]",
      oldState.status,
      "=>",
      newState.status
    );
  });

  connection.on(VoiceConnectionStatus.Ready, () => {
    console.log("======================================");
    console.log("SUCCESS: BOT JOINED VOICE CHANNEL!");
    console.log("CHANNEL:", channel.name);
    console.log("======================================");

    startReminderLoop();
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    console.error("[VOICE] DISCONNECTED");

    if (!manualLeaving) {
      scheduleReconnect();
    }
  });

  connection.on("error", (error) => {
    lastError = error.message;
    console.error("[VOICE CONNECTION ERROR]", error);
  });

  await entersState(
    connection,
    VoiceConnectionStatus.Ready,
    30000
  );

  console.log("[VOICE] READY CONFIRMED");

  startReminderLoop();

  return true;
}

// ==========================================
// 12. AUTOMATIC RECONNECT
// ==========================================

function scheduleReconnect() {
  if (manualLeaving || reconnectTimer) return;

  console.log("[VOICE] RECONNECT IN 10 SECONDS");

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;

    if (manualLeaving) return;

    try {
      console.log("[VOICE] RECONNECTING...");
      await joinVoice();

    } catch (error) {
      lastError = error.message;

      console.error("[VOICE RECONNECT FAILED]", error);

      scheduleReconnect();
    }
  }, 10000);
}

// ==========================================
// 13. LEAVE VOICE
// ==========================================

function leaveVoice() {
  console.log("[VOICE] LEAVE REQUESTED");

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
      console.error("[VOICE LEAVE ERROR]", error);
    }

    connection = null;
  }

  console.log("[VOICE] DISCONNECTED");

  return true;
}

// ==========================================
// 14. SLASH COMMANDS
// ==========================================

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join the reminder voice channel"),

  new SlashCommandBuilder()
    .setName("start")
    .setDescription("Start the voice reminder bot"),

  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop reminders and leave voice"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Check bot status"),

  new SlashCommandBuilder()
    .setName("test")
    .setDescription("Test Bangla voice reminder")
].map((command) => command.toJSON());

// ==========================================
// 15. REGISTER SLASH COMMANDS
// ==========================================

async function registerCommands() {
  console.log("[COMMANDS] REGISTRATION STARTED");

  const rest = new REST({
    version: "10"
  }).setToken(TOKEN);

  try {
    const result = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log("======================================");
    console.log("SUCCESS: SLASH COMMANDS REGISTERED");
    console.log("COMMAND COUNT:", result.length);
    console.log(
      "COMMAND NAMES:",
      commands.map((command) => command.name).join(", ")
    );
    console.log("======================================");

  } catch (error) {
    lastError = error.message;

    console.error("[COMMAND REGISTRATION FAILED]");
    console.error("ERROR NAME:", error.name);
    console.error("ERROR CODE:", error.code);
    console.error("ERROR MESSAGE:", error.message);

    throw error;
  }
}

// ==========================================
// 16. COMMAND HANDLER
// ==========================================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  console.log("[COMMAND RECEIVED]", interaction.commandName);
  console.log("[COMMAND USER]", interaction.user.tag);

  try {
    const command = interaction.commandName;

    if (command === "start" || command === "join") {
      await interaction.deferReply({ ephemeral: true });

      await joinVoice();

      await interaction.editReply(
        "Bot সফলভাবে Voice Channel-এ Join করেছে।"
      );

      return;
    }

    if (command === "stop" || command === "leave") {
      leaveVoice();

      await interaction.reply({
        content: "Bot Voice Channel থেকে বের হয়েছে।",
        ephemeral: true
      });

      return;
    }

    if (command === "status") {
      const voiceStatus =
        connection?.state?.status || "not-connected";

      await interaction.reply({
        content:
          `**Bot:** ${client.user?.tag || "Offline"}\n` +
          `**Gateway:** ${client.ws.status}\n` +
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
          ? "বাংলা Reminder সফলভাবে বাজানো হয়েছে।"
          : "Reminder বাজানো যায়নি। Render Logs পরীক্ষা করুন।"
      );

      return;
    }

  } catch (error) {
    lastError = error.message;

    console.error("[COMMAND EXECUTION ERROR]", error);

    const message =
      "Command চালাতে সমস্যা হয়েছে। Render Logs পরীক্ষা করুন।";

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
      console.error("[COMMAND REPLY ERROR]", replyError);
    }
  }
});

// ==========================================
// 17. BOT READY EVENT
// ==========================================

client.once(Events.ClientReady, async (readyClient) => {
  console.log("");
  console.log("======================================");
  console.log("SUCCESS: DISCORD BOT LOGGED IN!");
  console.log("BOT USER:", readyClient.user.tag);
  console.log("BOT ID:", readyClient.user.id);
  console.log("======================================");

  try {
    await registerCommands();
  } catch (error) {
    console.error("[STARTUP] COMMAND REGISTRATION FAILED");
  }

  try {
    console.log("[STARTUP] AUTOMATIC VOICE JOIN STARTING");

    await joinVoice();

  } catch (error) {
    lastError = error.message;

    console.error("[STARTUP] AUTOMATIC VOICE JOIN FAILED", error);

    scheduleReconnect();
  }
});

// ==========================================
// 18. PROCESS ERROR LOGS
// ==========================================

process.on("unhandledRejection", (error) => {
  lastError = error?.message || String(error);
  console.error("[UNHANDLED PROMISE REJECTION]", error);
});

process.on("uncaughtException", (error) => {
  lastError = error.message;

  console.error("[UNCAUGHT EXCEPTION]", error);

  process.exit(1);
});

// ==========================================
// 19. DISCORD LOGIN
// ==========================================

console.log("");
console.log("[DISCORD] STARTING GATEWAY LOGIN...");
console.log("[DISCORD] TOKEN IS PRESENT:", Boolean(TOKEN));

loginStartedAt = Date.now();

client.login(TOKEN)
  .then(() => {
    console.log("[DISCORD] LOGIN PROMISE RESOLVED");
    console.log("[DISCORD] WAITING FOR CLIENT READY EVENT");
  })
  .catch((error) => {
    lastError = error.message;

    console.error("======================================");
    console.error("DISCORD LOGIN FAILED!");
    console.error("ERROR NAME:", error.name);
    console.error("ERROR CODE:", error.code || "unknown");
    console.error("ERROR MESSAGE:", error.message);
    console.error("======================================");
  });
