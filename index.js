
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

// ==================================================
// 1. ENVIRONMENT VARIABLES
// ==================================================

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

// ==================================================
// 2. SAFE LOGGING
// ==================================================

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function logError(label, error) {
  console.error(new Date().toISOString(), label);
  console.error("ERROR NAME:", error?.name || "Unknown");
  console.error("ERROR CODE:", error?.code || "None");
  console.error("ERROR MESSAGE:", error?.message || String(error));

  if (error?.status) {
    console.error("HTTP STATUS:", error.status);
  }

  const retryAfter =
    error?.retryAfter ??
    error?.rawError?.retry_after ??
    error?.data?.retry_after;

  if (retryAfter !== undefined) {
    console.error("RETRY AFTER:", retryAfter);
  }
}

// ==================================================
// 3. STARTUP VALIDATION
// ==================================================

log("==========================================");
log("DISCORD BANGLA REMINDER BOT STARTING");
log("NODE VERSION:", process.version);
log("TOKEN EXISTS:", Boolean(TOKEN));
log("CLIENT ID EXISTS:", Boolean(CLIENT_ID));
log("GUILD ID EXISTS:", Boolean(GUILD_ID));
log("VOICE CHANNEL ID EXISTS:", Boolean(VOICE_CHANNEL_ID));
log("FFMPEG AVAILABLE:", Boolean(ffmpegPath));
log("REMINDER INTERVAL:", REMINDER_INTERVAL_MINUTES, "minutes");
log("==========================================");

const missingVariables = [];

if (!TOKEN) missingVariables.push("DISCORD_TOKEN");
if (!CLIENT_ID) missingVariables.push("CLIENT_ID");
if (!GUILD_ID) missingVariables.push("GUILD_ID");
if (!VOICE_CHANNEL_ID) missingVariables.push("VOICE_CHANNEL_ID");

if (missingVariables.length > 0) {
  log("FATAL: MISSING ENVIRONMENT VARIABLES:", missingVariables.join(", "));
  process.exit(1);
}

if (!ffmpegPath) {
  log("FATAL: FFMPEG BINARY NOT FOUND");
  process.exit(1);
}

// ==================================================
// 4. DISCORD CLIENT
// ==================================================

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
let reconnectDelay = 10000;

let lastError = null;
let lastReminderAt = null;
let loginStartedAt = Date.now();
let loginCheckTimer = null;

// ==================================================
// 5. HEALTH SERVER
// ==================================================

const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.url === "/health") {
    res.writeHead(200);

    res.end(JSON.stringify({
      service: "online",
      bot: client.user?.tag || "not-ready",
      botId: client.user?.id || null,
      ready: client.isReady(),
      gatewayStatus: client.ws.status,
      voice: connection?.state?.status || "not-connected",
      reminder: reminderTimer ? "running" : "stopped",
      reminderBusy,
      reminderIntervalMinutes: REMINDER_INTERVAL_MINUTES,
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

server.on("error", (error) => {
  logError("[HEALTH SERVER ERROR]", error);
});

server.listen(PORT, "0.0.0.0", () => {
  log("[HEALTH] SERVER LISTENING ON PORT:", PORT);
  log("[HEALTH] PATH: /health");
});

// ==================================================
// 6. DISCORD GATEWAY EVENTS
// Never print raw Discord debug messages because
// some debug messages may contain token information.
// ==================================================

client.on(Events.Warn, (warning) => {
  log("[DISCORD WARNING]", warning);
});

client.on(Events.Error, (error) => {
  lastError = error.message;
  logError("[DISCORD CLIENT ERROR]", error);
});

client.on("shardReady", (shardId) => {
  log("[GATEWAY] SHARD READY:", shardId);
});

client.on("shardError", (error, shardId) => {
  lastError = error.message;
  logError("[GATEWAY] SHARD ERROR " + shardId, error);
});

client.on("shardDisconnect", (event, shardId) => {
  log("[GATEWAY] SHARD DISCONNECTED:", shardId);
  log("[GATEWAY] CLOSE CODE:", event?.code);
  log("[GATEWAY] CLOSE REASON:", event?.reason?.toString?.() || "none");
});

client.on("shardReconnecting", (shardId) => {
  log("[GATEWAY] SHARD RECONNECTING:", shardId);
});

client.on("invalidated", () => {
  lastError = "Discord session invalidated";
  log("[GATEWAY] SESSION INVALIDATED");
});

// ==================================================
// 7. LOGIN DIAGNOSTIC
// ==================================================

function startLoginDiagnostic() {
  loginCheckTimer = setTimeout(() => {
    log("==========================================");
    log("[LOGIN CHECK] 60 SECOND DIAGNOSTIC");
    log("BOT READY:", client.isReady());
    log("BOT USER:", client.user?.tag || "NOT READY");
    log("GATEWAY STATUS:", client.ws.status);
    log("LOGIN ELAPSED:", Math.round((Date.now() - loginStartedAt) / 1000), "seconds");
    log("LAST ERROR:", lastError || "NONE");
    log("==========================================");

    if (!client.isReady()) {
      log("[LOGIN WARNING] ClientReady has not fired yet.");
      log("[LOGIN WARNING] Check Gateway/Network/Token errors above.");
    }
  }, 60000);
}

// ==================================================
// 8. AUDIO PLAYER EVENTS
// ==================================================

player.on(AudioPlayerStatus.Playing, () => {
  log("[AUDIO] PLAYING");
});

player.on(AudioPlayerStatus.Idle, () => {
  log("[AUDIO] PLAYBACK FINISHED");
});

player.on("error", (error) => {
  lastError = error.message;
  logError("[AUDIO PLAYER ERROR]", error);
});

// ==================================================
// 9. REMINDER TIMER
// ==================================================

function stopReminderLoop() {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }

  log("[REMINDER] TIMER STOPPED");
}

function startReminderLoop() {
  if (reminderTimer) {
    log("[REMINDER] TIMER ALREADY RUNNING");
    return;
  }

  log(
    "[REMINDER] TIMER STARTED:",
    REMINDER_INTERVAL_MINUTES,
    "MINUTES"
  );

  runReminder("initial").catch((error) => {
    logError("[INITIAL REMINDER ERROR]", error);
  });

  reminderTimer = setInterval(() => {
    runReminder("scheduled").catch((error) => {
      logError("[SCHEDULED REMINDER ERROR]", error);
    });
  }, REMINDER_INTERVAL_MINUTES * 60 * 1000);
}

// ==================================================
// 10. BANGLA TTS AND FFMPEG
// ==================================================

async function playTTSOnce() {
  log("[TTS] GENERATING BANGLA AUDIO");

  const audioUrl = await getAudioUrl(REMINDER_TEXT, {
    lang: "bn",
    slow: false
  });

  log("[TTS] AUDIO URL GENERATED");

  const response = await fetch(audioUrl, {
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error("TTS DOWNLOAD FAILED: HTTP " + response.status);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  if (audioBuffer.length === 0) {
    throw new Error("TTS RETURNED EMPTY AUDIO");
  }

  log("[TTS] AUDIO DOWNLOADED:", audioBuffer.length, "bytes");
  log("[FFMPEG] STARTING CONVERSION");

  const ffmpeg = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1"
  ]);

  let ffmpegError = "";

  ffmpeg.stderr.on("data", (data) => {
    ffmpegError += data.toString();
    console.error("[FFMPEG]", data.toString());
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
      player.removeListener("error", onPlayerError);

      if (error) reject(error);
      else resolve();
    }

    function onIdle() {
      finish();
    }

    function onPlayerError(error) {
      finish(error);
    }

    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onPlayerError);

    log("[TTS] STARTING DISCORD AUDIO PLAYBACK");

    player.play(resource);
  });

  ffmpeg.on("error", (error) => {
    logError("[FFMPEG PROCESS ERROR]", error);
  });

  ffmpeg.on("close", (code) => {
    log("[FFMPEG] PROCESS CLOSED. EXIT CODE:", code);

    if (code !== 0 && code !== null) {
      log("[FFMPEG] CONVERSION MAY HAVE FAILED:", ffmpegError);
    }
  });

  ffmpeg.stdin.on("error", (error) => {
    logError("[FFMPEG INPUT ERROR]", error);
  });

  ffmpeg.stdin.end(audioBuffer);

  await playbackPromise;

  log("[TTS] PLAYBACK COMPLETED");
}

// ==================================================
// 11. PLAY REMINDER TWICE
// ==================================================

async function runReminder(source = "manual") {
  if (reminderBusy) {
    log("[REMINDER] SKIPPED: ALREADY PLAYING");
    return false;
  }

  if (
    !connection ||
    connection.state.status !== VoiceConnectionStatus.Ready
  ) {
    log("[REMINDER] FAILED: VOICE CONNECTION NOT READY");
    return false;
  }

  reminderBusy = true;

  log("[REMINDER] STARTED:", source);

  try {
    await playTTSOnce();

    log("[REMINDER] WAITING 5 SECONDS");

    await new Promise((resolve) => setTimeout(resolve, 5000));

    await playTTSOnce();

    lastReminderAt = new Date().toISOString();

    log("[REMINDER] BOTH MESSAGES COMPLETED");

    return true;

  } catch (error) {
    lastError = error.message;
    logError("[REMINDER PLAYBACK FAILED]", error);
    return false;

  } finally {
    reminderBusy = false;
  }
}

// ==================================================
// 12. VOICE CHANNEL JOIN
// ==================================================

async function joinVoice() {
  log("[VOICE] JOIN REQUEST STARTED");
  log("[VOICE] GUILD ID:", GUILD_ID);
  log("[VOICE] CHANNEL ID:", VOICE_CHANNEL_ID);

  const guild = await client.guilds.fetch(GUILD_ID);

  log("[VOICE] GUILD FOUND:", guild.name);

  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel) {
    throw new Error("VOICE CHANNEL NOT FOUND. CHECK VOICE_CHANNEL_ID.");
  }

  if (channel.type !== ChannelType.GuildVoice) {
    throw new Error("CHANNEL IS NOT A STANDARD VOICE CHANNEL.");
  }

  log("[VOICE] CHANNEL FOUND:", channel.name);

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
    log("[VOICE] ALREADY CONNECTED");
    startReminderLoop();
    return true;
  }

  if (connection) {
    try {
      connection.removeAllListeners();
      connection.destroy();
    } catch (error) {
      logError("[VOICE] OLD CONNECTION CLEANUP ERROR", error);
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
    log(
      "[VOICE STATE]",
      oldState.status,
      "=>",
      newState.status
    );
  });

  connection.on(VoiceConnectionStatus.Ready, () => {
    log("==========================================");
    log("[VOICE] SUCCESS: BOT JOINED VOICE CHANNEL");
    log("[VOICE] CHANNEL:", channel.name);
    log("==========================================");

    reconnectDelay = 10000;
    startReminderLoop();
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    log("[VOICE] DISCONNECTED");

    if (!manualLeaving) {
      scheduleReconnect();
    }
  });

  connection.on("error", (error) => {
    lastError = error.message;
    logError("[VOICE CONNECTION ERROR]", error);
  });

  await entersState(
    connection,
    VoiceConnectionStatus.Ready,
    30000
  );

  log("[VOICE] READY CONFIRMED");

  reconnectDelay = 10000;
  startReminderLoop();

  return true;
}

// ==================================================
// 13. AUTOMATIC VOICE RECONNECT
// ==================================================

function scheduleReconnect() {
  if (manualLeaving || reconnectTimer) return;

  const delay = reconnectDelay;

  log("[VOICE] RECONNECT SCHEDULED IN", delay / 1000, "SECONDS");

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;

    if (manualLeaving) return;

    try {
      log("[VOICE] RECONNECT ATTEMPT STARTED");
      await joinVoice();

    } catch (error) {
      lastError = error.message;
      logError("[VOICE RECONNECT FAILED]", error);

      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
      scheduleReconnect();
    }
  }, delay);
}

// ==================================================
// 14. LEAVE VOICE
// ==================================================

function leaveVoice() {
  log("[VOICE] LEAVE REQUESTED");

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
      logError("[VOICE LEAVE ERROR]", error);
    }

    connection = null;
  }

  log("[VOICE] DISCONNECTED");

  return true;
}

// ==================================================
// 15. SLASH COMMAND DEFINITIONS
// ==================================================

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
    .setDescription("Check bot and voice status"),

  new SlashCommandBuilder()
    .setName("test")
    .setDescription("Test the Bangla voice reminder")
].map((command) => command.toJSON());

// ==================================================
// 16. SLASH COMMAND REGISTRATION
// ==================================================

async function registerCommands() {
  log("[COMMANDS] REGISTRATION STARTED");

  const rest = new REST({
    version: "10"
  }).setToken(TOKEN);

  try {
    const result = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    log("==========================================");
    log("[COMMANDS] SUCCESS: REGISTERED");
    log("[COMMANDS] COUNT:", result.length);
    log("[COMMANDS] NAMES:", commands.map((item) => item.name).join(", "));
    log("==========================================");

    return true;

  } catch (error) {
    lastError = error.message;

    logError("[COMMANDS] REGISTRATION FAILED", error);

    return false;
  }
}

// ==================================================
// 17. SLASH COMMAND HANDLER
// ==================================================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  log("[COMMAND] RECEIVED:", interaction.commandName);
  log("[COMMAND] USER:", interaction.user.tag);

  try {
    const command = interaction.commandName;

    if (command === "start" || command === "join") {
      await interaction.deferReply({ ephemeral: true });

      await joinVoice();

      await interaction.editReply(
        "Bot Voice Channel-এ Join করেছে।"
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
      await interaction.reply({
        content:
          `**Bot:** ${client.user?.tag || "Offline"}\n` +
          `**Gateway:** ${client.ws.status}\n` +
          `**Voice:** ${connection?.state?.status || "not-connected"}\n` +
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
          : "Reminder বাজানো যায়নি। Voice Connection ও Logs পরীক্ষা করুন।"
      );

      return;
    }

  } catch (error) {
    lastError = error.message;
    logError("[COMMAND] EXECUTION FAILED", error);

    try {
      const reply = "Command চালাতে সমস্যা হয়েছে। Render Logs পরীক্ষা করুন।";

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply({
          content: reply,
          ephemeral: true
        });
      }
    } catch (replyError) {
      logError("[COMMAND] REPLY FAILED", replyError);
    }
  }
});

// ==================================================
// 18. CLIENT READY
// ==================================================

client.once(Events.ClientReady, async (readyClient) => {
  if (loginCheckTimer) {
    clearTimeout(loginCheckTimer);
    loginCheckTimer = null;
  }

  log("==========================================");
  log("SUCCESS: DISCORD BOT LOGGED IN");
  log("BOT USER:", readyClient.user.tag);
  log("BOT ID:", readyClient.user.id);
  log("GATEWAY READY:", client.isReady());
  log("==========================================");

  const registered = await registerCommands();

  if (!registered) {
    log("[STARTUP] BOT LOGIN SUCCESSFUL, BUT COMMAND REGISTRATION FAILED.");
  }

  try {
    log("[STARTUP] AUTOMATIC VOICE JOIN STARTED");

    await joinVoice();

  } catch (error) {
    lastError = error.message;
    logError("[STARTUP] AUTOMATIC VOICE JOIN FAILED", error);

    scheduleReconnect();
  }
});

// ==================================================
// 19. PROCESS ERROR HANDLERS
// ==================================================

process.on("unhandledRejection", (error) => {
  lastError = error?.message || String(error);
  logError("[PROCESS] UNHANDLED PROMISE REJECTION", error);
});

process.on("uncaughtException", (error) => {
  lastError = error.message;
  logError("[PROCESS] UNCAUGHT EXCEPTION", error);

  process.exit(1);
});

// ==================================================
// 20. DIRECT DISCORD LOGIN
// ==================================================

async function startDiscordLogin() {
  log("==========================================");
  log("[DISCORD LOGIN] STARTING");
  log("[DISCORD LOGIN] TOKEN PRESENT:", Boolean(TOKEN));
  log("[DISCORD LOGIN] GATEWAY CONNECTION REQUESTED");
  log("==========================================");

  loginStartedAt = Date.now();

  startLoginDiagnostic();

  try {
    await client.login(TOKEN);

    log("[DISCORD LOGIN] LOGIN PROMISE RESOLVED");
    log("[DISCORD LOGIN] WAITING FOR CLIENT READY EVENT");

  } catch (error) {
    lastError = error.message;

    if (loginCheckTimer) {
      clearTimeout(loginCheckTimer);
      loginCheckTimer = null;
    }

    logError("[DISCORD LOGIN] FAILED", error);
  }
}

startDiscordLogin();
