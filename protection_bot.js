const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder, AuditLogEvent } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
  ],
});

const CONFIG = {
  TOKEN: process.env.TOKEN,
  LOG_CHANNEL_ID: 'YOUR_LOG_CHANNEL_ID',
  OWNER_IDS: ['YOUR_USER_ID'],
  TRUSTED_ROLE_ID: 'TRUSTED_ROLE_ID',
  JOIN_THRESHOLD: 10,
  JOIN_WINDOW: 10000,
  MIN_ACCOUNT_AGE: 7,
  MSG_THRESHOLD: 7,
  MSG_WINDOW: 5000,
  MENTION_LIMIT: 5,
  NSFW_MUTE_DURATION: 10 * 60 * 1000,
  NSFW_KEYWORDS: [
    'nsfw', 'porn', 'hentai', 'nude', 'naked', 'xxx', 'sex', 'lewd',
    'r34', 'rule34', 'onlyfans', 'adult', 'explicit',
  ],
  ALLOWED_GIF_CHANNELS: [],
  BAN_LIMIT: 3,
  KICK_LIMIT: 5,
  CHANNEL_DELETE_LIMIT: 2,
  CHANNEL_CREATE_LIMIT: 4,
  ROLE_DELETE_LIMIT: 2,
  WEBHOOK_CREATE_LIMIT: 2,
};

const joinTracker   = [];
const msgTracker    = new Map();
const actionTracker = new Map();
const punished      = new Set();
const lockedDown    = new Set();
const nsfwStrikes   = new Map();

function log(guild, embed) {
  const ch = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
  if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

function makeEmbed(title, desc, color = 0xff0000) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp();
}

function isOwner(userId) { return CONFIG.OWNER_IDS.includes(userId); }

function isTrusted(member) {
  if (!member) return false;
  if (isOwner(member.id)) return true;
  return member.roles.cache.has(CONFIG.TRUSTED_ROLE_ID);
}

function trackAction(userId, action) {
  const now = Date.now();
  if (!actionTracker.has(userId)) actionTracker.set(userId, {});
  const user = actionTracker.get(userId);
  if (!user[action]) user[action] = [];
  user[action] = user[action].filter(t => now - t < 10000);
  user[action].push(now);
  return user[action].length;
}

async function punishNuker(guild, userId, reason) {
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || isTrusted(member)) return;
    await member.ban({ reason: `[AutoMod - Anti-Nuke] ${reason}` });
    log(guild, makeEmbed('🔨 Nuker Banned', `<@${userId}> was banned.\n**Reason:** ${reason}`));
  } catch {}
}

client.on('guildMemberAdd', async (member) => {
  const { guild } = member;
  const now = Date.now();
  while (joinTracker.length && now - joinTracker[0] > CONFIG.JOIN_WINDOW) joinTracker.shift();
  joinTracker.push(now);

  const accountAge = (now - member.user.createdTimestamp) / 86400000;
  if (accountAge < CONFIG.MIN_ACCOUNT_AGE) {
    await member.kick('Account too new (anti-raid)').catch(() => {});
    log(guild, makeEmbed('👢 New Account Kicked', `<@${member.id}> — account age: ${accountAge.toFixed(1)} days`));
    return;
  }

  if (joinTracker.length >= CONFIG.JOIN_THRESHOLD && !lockedDown.has(guild.id)) {
    lockedDown.add(guild.id);
    log(guild, makeEmbed('🚨 RAID DETECTED — Lockdown Active', `${joinTracker.length} joins in ${CONFIG.JOIN_WINDOW / 1000}s.`, 0xff4500));
    for (const [, channel] of guild.channels.cache) {
      if (channel.isTextBased() && channel.id !== CONFIG.LOG_CHANNEL_ID) {
        channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {});
      }
    }
    setTimeout(async () => {
      lockedDown.delete(guild.id);
      for (const [, channel] of guild.channels.cache) {
        if (channel.isTextBased()) {
          channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(() => {});
        }
      }
      log(guild, makeEmbed('✅ Lockdown Lifted', 'Server is back to normal.', 0x00ff00));
    }, 5 * 60 * 1000);
  }

  if (lockedDown.has(guild.id) && !punished.has(member.id)) {
    punished.add(member.id);
    await member.kick('Server is under raid lockdown').catch(() => {});
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  const member = message.member;
  if (isTrusted(member)) return;

  const now = Date.now();
  const userId = message.author.id;

  if (!msgTracker.has(userId)) msgTracker.set(userId, []);
  const times = msgTracker.get(userId).filter(t => now - t < CONFIG.MSG_WINDOW);
  times.push(now);
  msgTracker.set(userId, times);

  if (times.length >= CONFIG.MSG_THRESHOLD) {
    await message.member.timeout(5 * 60 * 1000, 'Spamming').catch(() => {});
    log(message.guild, makeEmbed('🔇 Spammer Timed Out', `<@${userId}> sent ${times.length} messages in ${CONFIG.MSG_WINDOW / 1000}s.`));
    msgTracker.set(userId, []);
    return;
  }

  if (message.mentions.users.size + message.mentions.roles.size >= CONFIG.MENTION_LIMIT) {
    await message.delete().catch(() => {});
    await message.member.timeout(10 * 60 * 1000, 'Mass mention').catch(() => {});
    log(message.guild, makeEmbed('📢 Mass Mention Blocked', `<@${userId}> tried to mention ${message.mentions.users.size + message.mentions.roles.size} targets.`));
  }

  if (CONFIG.ALLOWED_GIF_CHANNELS.length && CONFIG.ALLOWED_GIF_CHANNELS.includes(message.channel.id)) return;

  let nsfwDetected = false;
  let nsfwReason = '';

  const lowerContent = message.content.toLowerCase();
  for (const keyword of CONFIG.NSFW_KEYWORDS) {
    if (lowerContent.includes(keyword)) {
      nsfwDetected = true;
      nsfwReason = `NSFW keyword: \`${keyword}\``;
      break;
    }
  }

  if (!nsfwDetected) {
    for (const [, att] of message.attachments) {
      const name = att.name?.toLowerCase() || '';
      const url  = att.url?.toLowerCase() || '';
      if (att.contentType?.includes('gif') || name.endsWith('.gif')) {
        for (const keyword of CONFIG.NSFW_KEYWORDS) {
          if (name.includes(keyword) || url.includes(keyword)) {
            nsfwDetected = true;
            nsfwReason = `NSFW GIF: \`${att.name}\``;
            break;
          }
        }
      }
    }
  }

  if (!nsfwDetected) {
    for (const embed of message.embeds) {
      const fields = [embed.url, embed.title, embed.description, embed.image?.url].filter(Boolean).map(s => s.toLowerCase());
      for (const field of fields) {
        for (const keyword of CONFIG.NSFW_KEYWORDS) {
          if (field.includes(keyword)) {
            nsfwDetected = true;
            nsfwReason = `NSFW embed (keyword: \`${keyword}\`)`;
            break;
          }
        }
        if (nsfwDetected) break;
      }
    }
  }

  if (nsfwDetected) {
    await message.delete().catch(() => {});
    const strikes = (nsfwStrikes.get(userId) || 0) + 1;
    nsfwStrikes.set(userId, strikes);
    let punishment = '';
    if (strikes >= 3) {
      await message.member.kick('Repeated NSFW content (3 strikes)').catch(() => {});
      nsfwStrikes.delete(userId);
      punishment = '👢 Kicked (3rd strike)';
    } else {
      const muteDuration = CONFIG.NSFW_MUTE_DURATION * strikes;
      await message.member.timeout(muteDuration, `NSFW content (strike ${strikes})`).catch(() => {});
      punishment = `🔇 Timed out ${(muteDuration / 60000).toFixed(0)} mins (strike ${strikes}/3)`;
    }
    message.author.send(`🚫 Your message in **${message.guild.name}** was deleted for NSFW content.\n${punishment}`).catch(() => {});
    log(message.guild, makeEmbed('🔞 NSFW Removed', `**User:** <@${userId}>\n**Reason:** ${nsfwReason}\n**Action:** ${punishment}`, 0xff6b00));
  }
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!isTrusted(message.member)) return;
  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  if (cmd === '!lockdown') {
    lockedDown.add(message.guild.id);
    for (const [, ch] of message.guild.channels.cache) {
      if (ch.isTextBased()) ch.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false }).catch(() => {});
    }
    message.reply('🔒 Server locked down.').catch(() => {});
  }

  if (cmd === '!unlock') {
    lockedDown.delete(message.guild.id);
    for (const [, ch] of message.guild.channels.cache) {
      if (ch.isTextBased()) ch.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null }).catch(() => {});
    }
    message.reply('🔓 Lockdown lifted.').catch(() => {});
  }

  if (cmd === '!status') {
    const em = makeEmbed(
      '🛡️ Protection Status',
      `**Lockdown:** ${lockedDown.has(message.guild.id) ? '🔴 Active' : '🟢 Off'}\n` +
      `**Anti-Spam:** ✅\n**Anti-Nuke:** ✅\n**Anti-Raid:** ✅\n**Anti-NSFW:** ✅\n` +
      `**NSFW Strikes:** ${nsfwStrikes.size} user(s)`,
      0x5865f2
    );
    message.channel.send({ embeds: [em] }).catch(() => {});
  }

  if (cmd === '!clearstrikes') {
    const target = message.mentions.users.first();
    if (!target) return message.reply('Usage: `!clearstrikes @user`');
    nsfwStrikes.delete(target.id);
    message.reply(`✅ Cleared NSFW strikes for <@${target.id}>.`);
  }
});

async function checkAuditLog(guild, auditEvent, action, limit) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditEvent, limit: 1 });
    const entry = logs.entries.first();
    if (!entry) return;
    const { executor } = entry;
    if (!executor || isOwner(executor.id)) return;
    const member = await guild.members.fetch(executor.id).catch(() => null);
    if (isTrusted(member)) return;
    const count = trackAction(executor.id, action);
    if (count >= limit) {
      await punishNuker(guild, executor.id, `${action} limit exceeded (${count} in 10s)`);
    }
  } catch {}
}

client.on('channelDelete', (channel) => { if (channel.guild) checkAuditLog(channel.guild, AuditLogEvent.ChannelDelete, 'channelDelete', CONFIG.CHANNEL_DELETE_LIMIT); });
client.on('channelCreate', (channel) => { if (channel.guild) checkAuditLog(channel.guild, AuditLogEvent.ChannelCreate, 'channelCreate', CONFIG.CHANNEL_CREATE_LIMIT); });
client.on('roleDelete', (role) => { checkAuditLog(role.guild, AuditLogEvent.RoleDelete, 'roleDelete', CONFIG.ROLE_DELETE_LIMIT); });
client.on('guildMemberRemove', (member) => { checkAuditLog(member.guild, AuditLogEvent.MemberKick, 'kick', CONFIG.KICK_LIMIT); });
client.on('guildBanAdd', (ban) => { checkAuditLog(ban.guild, AuditLogEvent.MemberBanAdd, 'ban', CONFIG.BAN_LIMIT); });
client.on('webhooksUpdate', (channel) => { checkAuditLog(channel.guild, AuditLogEvent.WebhookCreate, 'webhookCreate', CONFIG.WEBHOOK_CREATE_LIMIT); });

client.once('ready', () => {
  console.log(`✅ Protection Bot online as ${client.user.tag}`);
  client.user.setActivity('Protecting the server 🛡️', { type: 3 });
});

client.login(CONFIG.TOKEN);
