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

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  TOKEN: 'YOUR_BOT_TOKEN',
  LOG_CHANNEL_ID: 'YOUR_LOG_CHANNEL_ID',
  OWNER_IDS: ['YOUR_USER_ID'],          // Immune to all protections
  TRUSTED_ROLE_ID: 'TRUSTED_ROLE_ID',  // Admins you trust

  // Anti-Raid
  JOIN_THRESHOLD: 10,       // Max joins within joinWindow ms
  JOIN_WINDOW: 10000,       // 10 seconds
  MIN_ACCOUNT_AGE: 7,       // Days old account must be

  // Anti-Spam
  MSG_THRESHOLD: 7,         // Max messages within msgWindow ms
  MSG_WINDOW: 5000,         // 5 seconds
  MENTION_LIMIT: 5,         // Max mentions per message

  // Anti-Link-Spam
  LINK_MSG_THRESHOLD: 3,    // Max messages containing links within LINK_WINDOW
  LINK_WINDOW: 8000,        // 8 seconds
  BLOCK_DISCORD_INVITES: true,   // Auto-delete discord.gg invites from non-trusted users
  ALLOWED_LINK_CHANNELS: [],     // channel IDs where links are always allowed

  // Anti-Emoji/Sticker Spam
  EMOJI_PER_MSG_LIMIT: 10,    // Max emojis allowed in a single message
  EMOJI_MSG_THRESHOLD: 5,     // Max "heavy emoji" messages within EMOJI_WINDOW
  EMOJI_WINDOW: 6000,         // 6 seconds

  // Smarter Raid Detection (bot-raid pattern matching)
  RAID_PATTERN_WINDOW: 15000,         // Window to compare new joiners against each other
  RAID_PATTERN_MIN_MATCHES: 4,        // How many similar-looking joins triggers suspicion
  DEFAULT_AVATAR_RAID_THRESHOLD: 5,   // X default-avatar joins within window = suspicious

  // Raid taunt messages (randomly picked)
  RAID_TAUNTS: [
    "Nice try. 🛡️ This server doesn't go down that easy.",
    "Lol, raid attempt detected. Better luck next time. 😏",
    "That's cute. Lockdown activated, you're not getting in. 🔒",
    "Skill issue. This server's protection said no. 🚫",
    "Imagine raiding a protected server in 2026. 💀",
  ],

  // Anti-NSFW
  NSFW_MUTE_DURATION: 10 * 60 * 1000,  // 10 minutes timeout
  NSFW_KEYWORDS: [
    'nsfw', 'porn', 'hentai', 'nude', 'naked', 'xxx', 'sex', 'lewd',
    'r34', 'rule34', 'onlyfans', 'adult', 'explicit',
  ],
  // Tenor/Giphy NSFW GIF domains to block if flagged
  ALLOWED_GIF_CHANNELS: [], // channel IDs where GIFs are allowed (leave empty to block everywhere)

  // Anti-Nuke (per-user action limits in 10s)
  BAN_LIMIT: 3,
  KICK_LIMIT: 5,
  CHANNEL_DELETE_LIMIT: 2,
  CHANNEL_CREATE_LIMIT: 4,
  ROLE_DELETE_LIMIT: 2,
  WEBHOOK_CREATE_LIMIT: 2,
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const joinTracker    = [];          // timestamps of recent joins
const msgTracker     = new Map();   // userId → [timestamps]
const actionTracker  = new Map();   // userId → { action: [timestamps] }
const punished       = new Set();   // userIds already actioned this raid
const lockedDown     = new Set();   // guild IDs under lockdown
const nsfwStrikes    = new Map();   // userId → strike count
const linkTracker    = new Map();   // userId → [timestamps of link messages]
const emojiTracker   = new Map();   // userId → [timestamps of heavy-emoji messages]
const recentJoiners  = [];          // recent join "fingerprints" for bot-raid pattern matching

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function log(guild, embed) {
  const ch = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
  if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}

function makeEmbed(title, desc, color = 0xff0000) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp();
}

function isOwner(userId) {
  return CONFIG.OWNER_IDS.includes(userId);
}

function randomTaunt() {
  return CONFIG.RAID_TAUNTS[Math.floor(Math.random() * CONFIG.RAID_TAUNTS.length)];
}

const URL_REGEX = /(https?:\/\/[^\s]+)/gi;
const INVITE_REGEX = /(discord\.gg\/|discord\.com\/invite\/|discordapp\.com\/invite\/)/i;

function containsLink(content) {
  URL_REGEX.lastIndex = 0;
  return URL_REGEX.test(content);
}

function containsInvite(content) {
  return INVITE_REGEX.test(content);
}

// Counts both custom Discord emojis (<:name:id> / <a:name:id>) and unicode emojis
const CUSTOM_EMOJI_REGEX = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

function countEmojis(content) {
  const custom = content.match(CUSTOM_EMOJI_REGEX) || [];
  const unicode = content.match(UNICODE_EMOJI_REGEX) || [];
  return custom.length + unicode.length;
}

// Builds a simple "fingerprint" of a joining member to detect bot-raid patterns
// (e.g. many accounts with default avatars and similar auto-generated usernames joining together)
function joinFingerprint(member) {
  const hasDefaultAvatar = !member.user.avatar; // null avatar = using Discord default
  const usernamePattern = member.user.username.replace(/[0-9]/g, '#'); // normalize digits, e.g. "user1234" -> "user####"
  return { hasDefaultAvatar, usernamePattern, createdAt: member.user.createdTimestamp };
}

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

    const announceChannel = guild.systemChannel ||
      guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages));
    if (announceChannel) {
      announceChannel.send(`🛡️ ${randomTaunt()} (Nuke attempt blocked)`).catch(() => {});
    }
  } catch {}
}

// ─── ANTI-RAID: Member Join ────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const { guild } = member;
  const now = Date.now();

  // Remove old joins outside the window
  while (joinTracker.length && now - joinTracker[0] > CONFIG.JOIN_WINDOW) joinTracker.shift();
  joinTracker.push(now);

  // Account age check
  const accountAge = (now - member.user.createdTimestamp) / 86400000;
  if (accountAge < CONFIG.MIN_ACCOUNT_AGE) {
    await member.kick('Account too new (anti-raid)').catch(() => {});
    log(guild, makeEmbed('👢 New Account Kicked', `<@${member.id}> (${member.user.tag}) — account age: ${accountAge.toFixed(1)} days`));
    return;
  }

  // ─── Smart Raid Pattern Detection (bot-raid fingerprinting) ─────────────────
  while (recentJoiners.length && now - recentJoiners[0].time > CONFIG.RAID_PATTERN_WINDOW) recentJoiners.shift();
  const fingerprint = joinFingerprint(member);
  recentJoiners.push({ time: now, ...fingerprint });

  const sameDefaultAvatar = recentJoiners.filter(j => j.hasDefaultAvatar).length;
  const samePattern = recentJoiners.filter(j => j.usernamePattern === fingerprint.usernamePattern).length;
  const patternRaidSuspected =
    sameDefaultAvatar >= CONFIG.DEFAULT_AVATAR_RAID_THRESHOLD ||
    samePattern >= CONFIG.RAID_PATTERN_MIN_MATCHES;

  // Raid detection (volume-based OR pattern-based)
  if ((joinTracker.length >= CONFIG.JOIN_THRESHOLD || patternRaidSuspected) && !lockedDown.has(guild.id)) {
    lockedDown.add(guild.id);
    const reason = patternRaidSuspected
      ? `Pattern match: ${samePattern} similar usernames / ${sameDefaultAvatar} default avatars joined recently.`
      : `${joinTracker.length} joins in ${CONFIG.JOIN_WINDOW / 1000}s.`;
    log(guild, makeEmbed('🚨 RAID DETECTED — Lockdown Active', `${reason} Enabling lockdown.`, 0xff4500));

    // Taunt the raiders in the system/general channel if possible
    const announceChannel = guild.systemChannel ||
      guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages));
    if (announceChannel) {
      announceChannel.send(`🛡️ ${randomTaunt()}`).catch(() => {});
    }

    // Lock all text channels for everyone
    for (const [, channel] of guild.channels.cache) {
      if (channel.isTextBased() && channel.id !== CONFIG.LOG_CHANNEL_ID) {
        channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {});
      }
    }

    // Auto-unlock after 5 minutes
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

  // Kick new joins during lockdown
  if (lockedDown.has(guild.id) && !punished.has(member.id)) {
    punished.add(member.id);
    await member.kick('Server is under raid lockdown').catch(() => {});
  }
});

// ─── ANTI-SPAM: Messages ──────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const member = message.member;
  if (isTrusted(member)) return;

  const now = Date.now();
  const userId = message.author.id;

  // Spam check
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

  // Mass mention check
  if (message.mentions.users.size + message.mentions.roles.size >= CONFIG.MENTION_LIMIT) {
    await message.delete().catch(() => {});
    await message.member.timeout(10 * 60 * 1000, 'Mass mention').catch(() => {});
    log(message.guild, makeEmbed('📢 Mass Mention Blocked', `<@${userId}> tried to mention ${message.mentions.users.size + message.mentions.roles.size} targets.`));
  }

  // ─── Anti-Link-Spam / Anti-Invite ───────────────────────────────────────────
  if (!(CONFIG.ALLOWED_LINK_CHANNELS.length && CONFIG.ALLOWED_LINK_CHANNELS.includes(message.channel.id))) {
    const hasLink = containsLink(message.content);
    const hasInvite = containsInvite(message.content);

    // Block Discord invite links outright (classic raid/advertising tactic)
    if (CONFIG.BLOCK_DISCORD_INVITES && hasInvite) {
      await message.delete().catch(() => {});
      await message.member.timeout(10 * 60 * 1000, 'Posted a Discord invite link').catch(() => {});
      message.author.send(`🚫 Your message in **${message.guild.name}** was removed for posting a Discord invite link.`).catch(() => {});
      log(message.guild, makeEmbed('🔗 Invite Link Blocked', `<@${userId}> tried to post a Discord invite link.\n**Action:** 🔇 10 min timeout`, 0xff8800));
    } else if (hasLink) {
      // Track repeated link spam (e.g. phishing/scam link flooding)
      if (!linkTracker.has(userId)) linkTracker.set(userId, []);
      const linkTimes = linkTracker.get(userId).filter(t => now - t < CONFIG.LINK_WINDOW);
      linkTimes.push(now);
      linkTracker.set(userId, linkTimes);

      if (linkTimes.length >= CONFIG.LINK_MSG_THRESHOLD) {
        await message.delete().catch(() => {});
        await message.member.timeout(15 * 60 * 1000, 'Link spam').catch(() => {});
        linkTracker.set(userId, []);
        message.author.send(`🚫 Your message in **${message.guild.name}** was removed for spamming links.`).catch(() => {});
        log(message.guild, makeEmbed('🔗 Link Spam Blocked', `<@${userId}> posted ${linkTimes.length} links in ${CONFIG.LINK_WINDOW / 1000}s.\n**Action:** 🔇 15 min timeout`, 0xff8800));
      }
    }
  }

  // ─── Anti-Emoji/Sticker Spam ────────────────────────────────────────────────
  const emojiCount = countEmojis(message.content);
  const hasSticker = message.stickers && message.stickers.size > 0;

  if (emojiCount >= CONFIG.EMOJI_PER_MSG_LIMIT) {
    // Single message flooded with emojis
    await message.delete().catch(() => {});
    await message.member.timeout(5 * 60 * 1000, 'Emoji flood in single message').catch(() => {});
    log(message.guild, makeEmbed('🎭 Emoji Flood Blocked', `<@${userId}> sent a message with ${emojiCount} emojis.\n**Action:** 🔇 5 min timeout`, 0xffaa00));
  } else if (emojiCount > 0 || hasSticker) {
    // Track repeated heavy-emoji/sticker messages over time
    if (!emojiTracker.has(userId)) emojiTracker.set(userId, []);
    const emojiTimes = emojiTracker.get(userId).filter(t => now - t < CONFIG.EMOJI_WINDOW);
    emojiTimes.push(now);
    emojiTracker.set(userId, emojiTimes);

    if (emojiTimes.length >= CONFIG.EMOJI_MSG_THRESHOLD) {
      await message.member.timeout(5 * 60 * 1000, 'Repeated emoji/sticker spam').catch(() => {});
      emojiTracker.set(userId, []);
      log(message.guild, makeEmbed('🎭 Emoji Spam Blocked', `<@${userId}> sent ${emojiTimes.length} emoji/sticker-heavy messages in ${CONFIG.EMOJI_WINDOW / 1000}s.\n**Action:** 🔇 5 min timeout`, 0xffaa00));
    }
  }

  // ─── NSFW GIF / Content Detection ───────────────────────────────────────────
  if (CONFIG.ALLOWED_GIF_CHANNELS.length && CONFIG.ALLOWED_GIF_CHANNELS.includes(message.channel.id)) return;

  let nsfwDetected = false;
  let nsfwReason = '';

  // 1. Check message text for NSFW keywords
  const lowerContent = message.content.toLowerCase();
  for (const keyword of CONFIG.NSFW_KEYWORDS) {
    if (lowerContent.includes(keyword)) {
      nsfwDetected = true;
      nsfwReason = `NSFW keyword: \`${keyword}\``;
      break;
    }
  }

  // 2. Check attachments (GIFs, images)
  if (!nsfwDetected) {
    for (const [, att] of message.attachments) {
      const name = att.name?.toLowerCase() || '';
      const url  = att.url?.toLowerCase() || '';
      // Flag .gif attachments with suspicious names
      if ((att.contentType?.includes('gif') || name.endsWith('.gif'))) {
        for (const keyword of CONFIG.NSFW_KEYWORDS) {
          if (name.includes(keyword) || url.includes(keyword)) {
            nsfwDetected = true;
            nsfwReason = `NSFW GIF attachment: \`${att.name}\``;
            break;
          }
        }
      }
      // Flag NSFW in any image name
      if (!nsfwDetected) {
        for (const keyword of CONFIG.NSFW_KEYWORDS) {
          if (name.includes(keyword)) {
            nsfwDetected = true;
            nsfwReason = `NSFW file: \`${att.name}\``;
            break;
          }
        }
      }
    }
  }

  // 3. Check embeds (Tenor / Giphy GIFs sent as links)
  if (!nsfwDetected) {
    for (const embed of message.embeds) {
      const fields = [
        embed.url, embed.title, embed.description,
        embed.image?.url, embed.thumbnail?.url, embed.footer?.text,
      ].filter(Boolean).map(s => s.toLowerCase());

      for (const field of fields) {
        for (const keyword of CONFIG.NSFW_KEYWORDS) {
          if (field.includes(keyword)) {
            nsfwDetected = true;
            nsfwReason = `NSFW embed content (keyword: \`${keyword}\`)`;
            break;
          }
        }
        if (nsfwDetected) break;
      }
    }
  }

  // 4. Act on detection
  if (nsfwDetected) {
    // Delete the message
    await message.delete().catch(() => {});

    // Track strikes
    const strikes = (nsfwStrikes.get(userId) || 0) + 1;
    nsfwStrikes.set(userId, strikes);

    // Escalating punishment
    let punishment = '';
    if (strikes >= 3) {
      // 3rd strike → kick
      await message.member.kick('Repeated NSFW content (3 strikes)').catch(() => {});
      nsfwStrikes.delete(userId);
      punishment = '👢 **Kicked** (3rd strike)';
    } else {
      // Mute (timeout)
      const muteDuration = CONFIG.NSFW_MUTE_DURATION * strikes; // longer each time
      await message.member.timeout(muteDuration, `NSFW content (strike ${strikes})`).catch(() => {});
      punishment = `🔇 **Timed out** for ${(muteDuration / 60000).toFixed(0)} minutes (strike ${strikes}/3)`;
    }

    // DM the user
    message.author.send(
      `🚫 Your message in **${message.guild.name}** was deleted for containing NSFW content.\n${punishment}`
    ).catch(() => {});

    // Log it
    log(message.guild, makeEmbed(
      '🔞 NSFW Content Removed',
      `**User:** <@${userId}> (${message.author.tag})\n**Channel:** <#${message.channel.id}>\n**Reason:** ${nsfwReason}\n**Action:** ${punishment}`,
      0xff6b00
    ));
  }
});

// ─── ANTI-NUKE: Audit Log Watcher ────────────────────────────────────────────
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

client.on('channelDelete', (channel) => {
  if (!channel.guild) return;
  checkAuditLog(channel.guild, AuditLogEvent.ChannelDelete, 'channelDelete', CONFIG.CHANNEL_DELETE_LIMIT);
});

client.on('channelCreate', (channel) => {
  if (!channel.guild) return;
  checkAuditLog(channel.guild, AuditLogEvent.ChannelCreate, 'channelCreate', CONFIG.CHANNEL_CREATE_LIMIT);
});

client.on('roleDelete', (role) => {
  checkAuditLog(role.guild, AuditLogEvent.RoleDelete, 'roleDelete', CONFIG.ROLE_DELETE_LIMIT);
});

client.on('guildMemberRemove', (member) => {
  checkAuditLog(member.guild, AuditLogEvent.MemberKick, 'kick', CONFIG.KICK_LIMIT);
});

client.on('guildBanAdd', (ban) => {
  checkAuditLog(ban.guild, AuditLogEvent.MemberBanAdd, 'ban', CONFIG.BAN_LIMIT);
});

// Webhook nuke protection
client.on('webhooksUpdate', (channel) => {
  checkAuditLog(channel.guild, AuditLogEvent.WebhookCreate, 'webhookCreate', CONFIG.WEBHOOK_CREATE_LIMIT);
});

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!isTrusted(message.member)) return;

  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  // !lockdown — manual lockdown
  if (cmd === '!lockdown') {
    lockedDown.add(message.guild.id);
    for (const [, ch] of message.guild.channels.cache) {
      if (ch.isTextBased()) ch.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false }).catch(() => {});
    }
    message.reply('🔒 Server locked down.').catch(() => {});
  }

  // !unlock — lift lockdown
  if (cmd === '!unlock') {
    lockedDown.delete(message.guild.id);
    for (const [, ch] of message.guild.channels.cache) {
      if (ch.isTextBased()) ch.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null }).catch(() => {});
    }
    message.reply('🔓 Lockdown lifted.').catch(() => {});
  }

  // !status — show protection status
  if (cmd === '!status') {
    const em = makeEmbed(
      '🛡️ Protection Status',
      `**Lockdown:** ${lockedDown.has(message.guild.id) ? '🔴 Active' : '🟢 Off'}\n` +
      `**Recent Joins (10s):** ${joinTracker.filter(t => Date.now() - t < 10000).length}\n` +
      `**Anti-Spam:** ✅\n**Anti-Nuke:** ✅\n**Anti-Raid (volume + pattern):** ✅\n**Anti-NSFW:** ✅\n**Anti-Link/Invite:** ✅\n**Anti-Emoji/Sticker Spam:** ✅\n` +
      `**NSFW Strikes tracked:** ${nsfwStrikes.size} user(s)`,
      0x5865f2
    );
    message.channel.send({ embeds: [em] }).catch(() => {});
  }

  // !clearstrikes @user — reset NSFW strikes for a user
  if (cmd === '!clearstrikes') {
    const target = message.mentions.users.first();
    if (!target) return message.reply('Usage: `!clearstrikes @user`');
    nsfwStrikes.delete(target.id);
    message.reply(`✅ Cleared NSFW strikes for <@${target.id}>.`);
  }
});

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ Protection Bot online as ${client.user.tag}`);
  client.user.setActivity('Protecting the server 🛡️', { type: 3 });
});

client.login(CONFIG.TOKEN);
