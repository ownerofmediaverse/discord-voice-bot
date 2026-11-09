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

// ==========================================
// ১. Render-এর জন্য ছোট ওয়েব সার্ভার (যাতে ঘুমিয়ে না পড়ে)
// ==========================================
const app = express();
app.get('/', (req, res) => res.send('Bot is alive'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// ==========================================
// ২. Discord Bot সেটআপ
// ==========================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// ==========================================
// ৩. Environment Variables থেকে তথ্য নেওয়া
// (Render-এ এই তথ্যগুলো সেট করবেন, কোডে বসাবেন না)
// ==========================================
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID; // আপনার চ্যানেল আইডি
const GUILD_ID = process.env.GUILD_ID;                 // আপনার সার্ভার আইডি

// ==========================================
// ৪. বট কী বলবে তা এখানে লেখা আছে (চাইলে পরিবর্তন করুন)
// ==========================================
const MESSAGE_TEXT = '১ ঘণ্টা হয়ে গেছে, গেম শেষ করে নতুন ম্যাচে ঢুকো';

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  startVoiceCycle(); // বট অনলাইনে আসলে টাইমার শুরু হবে
});

// Render-এ সেট করা টোকেন দিয়ে লগইন করবে
client.login(process.env.DISCORD_TOKEN);

// ==========================================
// ৫. মূল ভয়েস সাইকেল (জয়েন -> ১ ঘণ্টা অপেক্ষা -> ২ বার বলা -> ডিসকানেক্ট)
// ==========================================
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
    // ভয়েস চ্যানেলে জয়েন করা
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log('Voice channel-এ কানেক্টেড।');

    // ১ ঘণ্টা (৬০ মিনিট) অপেক্ষা করা
    console.log('১ ঘণ্টার টাইমার শুরু হচ্ছে...');
    await new Promise((resolve) => setTimeout(resolve, 10 * 1000));
    console.log('১ ঘণ্টা শেষ। এখন কথা বলবে।');

    const player = createAudioPlayer();
    connection.subscribe(player);

    // ২ বার মেসেজ বলা
    for (let i = 1; i <= 2; i++) {
      console.log(`TTS মেসেজ ${i}/2 বলা হচ্ছে...`);

      // TTS তৈরি করা (lang: 'bn' মানে বাংলা ভয়েস)
      const stream = discordTTS.getVoiceStream(MESSAGE_TEXT, {
        lang: 'bn', 
      });
      const resource = createAudioResource(stream);

      player.play(resource);

      // অডিও বলা শেষ হওয়া পর্যন্ত অপেক্ষা করা
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

    // কথা বলা শেষ -> চ্যানেল থেকে ডিসকানেক্ট
    console.log('কথা বলা শেষ। ডিসকানেক্ট করছে...');
    connection.destroy();

    // ডিসকানেক্ট করার ১০ সেকেন্ড পর আবার শুরু হবে (লুপ)
    console.log('পরের সাইকেল শুরু হবে ১০ সেকেন্ড পরে...');
    setTimeout(() => startVoiceCycle(), 10_000);
  } catch (error) {
    console.error('ভয়েস সাইকেলে এরর:', error);
    // কোনো সমস্যা হলে ৩০ সেকেন্ড পর আবার চেষ্টা করবে
    setTimeout(() => startVoiceCycle(), 30_000);
  }
}
