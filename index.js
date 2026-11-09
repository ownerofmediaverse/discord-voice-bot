const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const discordTTS = require('discord-tts');
const express = require('express');

// ---------- Render-এর জন্য ছোট ওয়েব সার্ভার ----------
const app = express();
app.get('/', (req, res) => res.send('Bot is alive'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// ---------- Discord Bot সেটআপ ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;

const MESSAGE_TEXT = '১ ঘণ্টা হয়ে গেছে, গেম শেষ করে নতুন ম্যাচে ঢুকো';

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  startVoiceCycle();
});

client.login(process.env.DISCORD_TOKEN);

// ---------- মূল ভয়েস সাইকেল ----------
async function startVoiceCycle() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error('Guild পাওয়া যায়নি। GUILD_ID চেক করুন।');
    return;
  }

  const voiceChannel = guild.channels.cache.get(VOICE_CHANNEL_ID);
  if (!voiceChannel) {
    console.error('Voice channel পাওয়া যায়নি। VOICE_CHANNEL_ID চেক করুন।');
    return;
  }

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log('Voice channel-এ কানেক্টেড।');

    console.log('১ ঘণ্টার টাইমার শুরু হচ্ছে...');
    await new Promise((resolve) => setTimeout(resolve, 60 * 60 * 1000));
    console.log('১ ঘণ্টা শেষ। এখন কথা বলবে।');

    const player = createAudioPlayer();
    connection.subscribe(player);

    for (let i = 1; i <= 2; i++) {
      console.log(`TTS মেসেজ ${i}/2 বলা হচ্ছে...`);

      const stream = discordTTS.getVoiceStream(MESSAGE_TEXT, {
        lang: 'bn', // বাংলা ভয়েসের জন্য; ইংরেজি চাইলে 'en' দিন
      });
      const resource = createAudioResource(stream);

      player.play(resource);

      await new Promise((resolve, reject) => {
        const onIdle = (oldState, newState) => {
          if (newState.status === AudioPlayerStatus.Idle) {
            player.off('stateChange', onIdle);
            resolve();
          }
        };
        player.on('stateChange', onIdle);
        player.once('error', reject);
      });
    }

    console.log('কথা বলা শেষ। ডিসকানেক্ট করছে...');
    connection.destroy();

    console.log('পরের সাইকেল শুরু হবে ১০ সেকেন্ড পরে...');
    setTimeout(() => startVoiceCycle(), 10_000);
  } catch (error) {
    console.error('ভয়েস সাইকেলে এরর:', error);
    setTimeout(() => startVoiceCycle(), 30_000);
  }
}
