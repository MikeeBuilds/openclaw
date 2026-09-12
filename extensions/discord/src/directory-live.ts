import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
// Discord plugin module implements directory live behavior.
import type {
  ChannelDirectoryEntry,
  DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS, fetchDiscord } from "./api.js";
import { discordConversationReadAuthority } from "./conversation-read-authority.js";
import { rememberDiscordDirectoryUser } from "./directory-cache.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import { normalizeDiscordToken } from "./token.js";

type DiscordGuild = { id: string; name: string };
type DiscordUser = { id: string; username: string; global_name?: string; bot?: boolean };
type DiscordMember = { user: DiscordUser; nick?: string | null };
type DiscordChannel = { id: string; name?: string | null };
type DiscordDirectoryAccess = { token: string; query: string; accountId: string };

function normalizeQuery(value?: string | null): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

function buildUserRank(user: DiscordUser): number {
  return user.bot ? 0 : 1;
}

function resolveDiscordDirectoryAccess(
  params: DirectoryConfigParams,
): DiscordDirectoryAccess | null {
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = normalizeDiscordToken(account.token, "channels.discord.token");
  if (!token) {
    return null;
  }
  return { token, query: normalizeQuery(params.query), accountId: account.accountId };
}

async function resolveDirectoryReadPolicy(params: DirectoryConfigParams, accountId: string) {
  const context = discordConversationReadAuthority.getStore()?.readContext;
  if (!context) {
    return undefined;
  }
  if (
    context.requesterAccountId &&
    normalizeAccountId(context.requesterAccountId) !== normalizeAccountId(accountId)
  ) {
    throw new Error("Discord read target account is not allowed.");
  }
  const { createDiscordMessagingActionContext } =
    await import("./actions/runtime.messaging.shared.js");
  return createDiscordMessagingActionContext({
    action: "read",
    input: { accountId },
    cfg: params.cfg,
    isActionEnabled: () => true,
    options: {
      conversationReadOrigin: context.conversationReadOrigin,
      readContext: {
        requesterAccountId: context.requesterAccountId,
        currentChannelProvider: context.toolContext?.currentChannelProvider,
        currentChannelId: context.toolContext?.currentChannelId,
      },
    },
  });
}

async function listDiscordGuilds(token: string): Promise<DiscordGuild[]> {
  const rawGuilds = await fetchDiscord<DiscordGuild[]>("/users/@me/guilds", token, fetch, {
    timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS,
  });
  return rawGuilds.filter((guild) => guild.id && guild.name);
}

export async function listDiscordDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const access = resolveDiscordDirectoryAccess(params);
  if (!access) {
    return [];
  }
  const { token, query, accountId } = access;
  const policy = await resolveDirectoryReadPolicy(params, accountId);
  const allGuilds = await listDiscordGuilds(token);
  const guilds =
    policy?.filterDirectoryGuilds({ guilds: allGuilds, filteredChannels: true }) ?? allGuilds;
  const rows: ChannelDirectoryEntry[] = [];
  const seenChannelIds = new Set<string>();
  const appendChannel = (channel: DiscordChannel): boolean => {
    const name = channel.name?.trim();
    if (
      seenChannelIds.has(channel.id) ||
      !name ||
      (query && !normalizeDiscordSlug(name).includes(normalizeDiscordSlug(query)))
    ) {
      return false;
    }
    seenChannelIds.add(channel.id);
    rows.push({
      kind: "group",
      id: `channel:${channel.id}`,
      name,
      handle: `#${name}`,
      raw: channel,
    });
    return typeof params.limit === "number" && params.limit > 0 && rows.length >= params.limit;
  };
  const currentChannel = await policy?.resolveDirectoryCurrentChannel({
    guilds: allGuilds,
  });
  if (currentChannel && appendChannel(currentChannel)) {
    return rows;
  }

  for (const guild of guilds) {
    const channels = await fetchDiscord<DiscordChannel[]>(
      `/guilds/${guild.id}/channels`,
      token,
      fetch,
      { timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS },
    );
    const visibleChannels = policy
      ? await policy.filterGuildChannelList({ guildId: guild.id, channels, enforcePolicy: true })
      : channels;
    for (const channel of visibleChannels) {
      if (appendChannel(channel)) {
        return rows;
      }
    }
  }

  return rows;
}

export async function listDiscordDirectoryPeersLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const access = resolveDiscordDirectoryAccess(params);
  if (!access) {
    return [];
  }
  const { token, query, accountId } = access;
  if (!query) {
    return [];
  }

  const policy = await resolveDirectoryReadPolicy(params, accountId);
  const allGuilds = await listDiscordGuilds(token);
  const guilds =
    policy?.filterDirectoryGuilds({ guilds: allGuilds, filteredChannels: false }) ?? allGuilds;
  const rows: ChannelDirectoryEntry[] = [];
  const seenUserIds = new Set<string>();
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 25;

  for (const guild of guilds) {
    const paramsObj = new URLSearchParams({
      query,
      limit: String(Math.min(limit, 100)),
    });
    const members = await fetchDiscord<DiscordMember[]>(
      `/guilds/${guild.id}/members/search?${paramsObj.toString()}`,
      token,
      fetch,
      { timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS },
    );
    for (const member of members) {
      const user = member.user;
      if (!user?.id) {
        continue;
      }
      rememberDiscordDirectoryUser({
        accountId,
        userId: user.id,
        handles: [
          user.username,
          user.global_name,
          member.nick,
          user.username ? `@${user.username}` : null,
        ],
      });
      if (seenUserIds.has(user.id)) {
        continue;
      }
      seenUserIds.add(user.id);
      const name = member.nick?.trim() || user.global_name?.trim() || user.username?.trim();
      rows.push({
        kind: "user",
        id: `user:${user.id}`,
        name: name || undefined,
        handle: user.username ? `@${user.username}` : undefined,
        rank: buildUserRank(user),
        raw: member,
      });
      if (rows.length >= limit) {
        return rows;
      }
    }
  }

  return rows;
}
