import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  type DiscordGuildEntryResolved,
} from "../monitor/allow-list.js";

export function hasDiscordGuildEntries(
  channels: DiscordGuildEntryResolved["channels"] | undefined,
): channels is NonNullable<DiscordGuildEntryResolved["channels"]> {
  return Boolean(channels && Object.keys(channels).length > 0);
}

export function hasExplicitlyDisabledDiscordChannels(
  channels: DiscordGuildEntryResolved["channels"] | undefined,
): boolean {
  return Object.values(channels ?? {}).some((channel) => channel.enabled === false);
}

function allowsAllDiscordGuildChannels(
  channels: DiscordGuildEntryResolved["channels"] | undefined,
): boolean {
  const wildcard = channels?.["*"];
  if (!wildcard || wildcard.enabled === false) {
    return false;
  }
  return Object.values(channels ?? {}).every((entry) => entry?.enabled !== false);
}

export function resolveDiscordActionGuildEntry(params: {
  guilds?: Record<string, DiscordGuildEntryResolved | undefined>;
  guildId?: string;
  guildName?: string;
  includeWildcard?: boolean;
}): DiscordGuildEntryResolved | null {
  const guildId = params.guildId?.trim();
  if (!params.guilds) {
    return null;
  }
  if (guildId && params.guilds[guildId]) {
    return { ...params.guilds[guildId], id: guildId };
  }
  if (guildId) {
    const byConfiguredId = Object.values(params.guilds).find((guild) => guild?.id === guildId);
    if (byConfiguredId) {
      return { ...byConfiguredId, id: guildId };
    }
  }
  const guildSlug = params.guildName ? normalizeDiscordSlug(params.guildName) : "";
  if (guildSlug) {
    const bySlug =
      params.guilds[guildSlug] ??
      Object.values(params.guilds).find((guild) => guild?.slug === guildSlug);
    if (bySlug) {
      return { ...bySlug, id: guildId, slug: guildSlug || bySlug.slug };
    }
  }
  if (params.includeWildcard === false) {
    return null;
  }
  const wildcard = params.guilds["*"];
  return wildcard ? { ...wildcard, id: guildId } : null;
}

export function resolveDiscordGuildReadDenial(params: {
  directOperator: boolean;
  groupPolicy: "open" | "disabled" | "allowlist";
  guildInfo: DiscordGuildEntryResolved | null;
  filteredChannels: boolean;
}): "guild" | "channel" | undefined {
  const { directOperator, groupPolicy, guildInfo, filteredChannels } = params;
  if (
    directOperator &&
    groupPolicy !== "disabled" &&
    (filteredChannels || !hasExplicitlyDisabledDiscordChannels(guildInfo?.channels))
  ) {
    return undefined;
  }
  if (
    !isDiscordGroupAllowedByPolicy({
      groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured: false,
      channelAllowed: true,
    })
  ) {
    return "guild";
  }
  return !filteredChannels &&
    hasDiscordGuildEntries(guildInfo?.channels) &&
    !allowsAllDiscordGuildChannels(guildInfo.channels)
    ? "channel"
    : undefined;
}
