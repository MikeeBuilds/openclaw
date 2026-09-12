import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { DiscordConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordMessageActions } from "./channel-actions.js";
import { resolveDiscordDirectoryUserId } from "./directory-cache.js";
import { clearDiscordDirectoryCacheForTest } from "./directory-cache.test-support.js";
import { listDiscordDirectoryGroupsLive, listDiscordDirectoryPeersLive } from "./directory-live.js";
import { urlToString } from "./test-http-helpers.js";

const allowedGuildId = "100000000000000001";
const excludedGuildId = "100000000000000002";
const allowedChannelId = "200000000000000001";
const deniedChannelId = "200000000000000002";
const deniedCategoryId = "200000000000000003";
const nestedChannelId = "200000000000000004";
const unlistedChannelId = "200000000000000005";
const allowedUserId = "300000000000000001";
const excludedUserId = "300000000000000002";
const allowedChannel = {
  id: allowedChannelId,
  name: "shared-name",
  guild_id: allowedGuildId,
  type: 0,
};
const channels = [
  { id: deniedChannelId, name: "shared-name", type: 0 },
  { id: deniedCategoryId, name: "secret-category", type: 4 },
  { id: nestedChannelId, name: "secret-child", type: 0, parent_id: deniedCategoryId },
  allowedChannel,
  { id: unlistedChannelId, name: "unlisted", type: 0 },
];

function config(channelScoped = true): OpenClawConfig {
  return {
    channels: {
      discord: {
        token: "synthetic-directory-token",
        groupPolicy: "allowlist",
        guilds: {
          "allowed-guild": channelScoped
            ? {
                channels: {
                  [allowedChannelId]: { enabled: true },
                  [deniedChannelId]: { enabled: false },
                  [deniedCategoryId]: { enabled: false },
                },
              }
            : {},
        },
      },
    },
  };
}

const paths: string[] = [];

function fixtureFetch(input: Parameters<typeof fetch>[0]): Response {
  const url = new URL(urlToString(input));
  const path = url.pathname.replace(/^\/api\/v10/, "");
  paths.push(path);
  switch (path) {
    case "/users/@me/guilds":
      return Response.json([
        { id: excludedGuildId, name: "Excluded Guild" },
        { id: allowedGuildId, name: "Allowed Guild" },
      ]);
    case `/guilds/${allowedGuildId}/channels`:
      return Response.json(channels);
    case `/guilds/${excludedGuildId}/channels`:
      return Response.json([{ id: "200000000000000099", name: "excluded-only", type: 0 }]);
    case `/guilds/${allowedGuildId}`:
      return Response.json({ id: allowedGuildId, name: "Allowed Guild" });
    case `/channels/${allowedChannelId}`:
      return Response.json(allowedChannel);
    case `/channels/${nestedChannelId}`:
      return Response.json({
        id: nestedChannelId,
        name: "secret-child",
        guild_id: allowedGuildId,
        type: 0,
        parent_id: deniedCategoryId,
      });
    case `/channels/${deniedCategoryId}`:
      return Response.json({
        id: deniedCategoryId,
        name: "secret-category",
        guild_id: allowedGuildId,
        type: 4,
      });
    case `/channels/${allowedChannelId}/messages`:
      return Response.json([{ id: "400000000000000001", content: "allowed message" }]);
    case `/guilds/${allowedGuildId}/members/search`:
      return Response.json([{ user: { id: allowedUserId, username: "allowed-user" } }]);
    case `/guilds/${excludedGuildId}/members/search`:
      return Response.json([{ user: { id: excludedUserId, username: "excluded-user" } }]);
    default:
      throw new Error(`Unexpected fixture request: ${path}`);
  }
}

async function invoke(
  cfg: OpenClawConfig,
  prepare: (params: Record<string, unknown>) => Promise<void>,
  overrides: Partial<ChannelMessageActionContext> = {},
) {
  const adapter = discordMessageActions.conversationReadAuthority;
  if (!adapter) {
    throw new Error("Missing Discord V2 adapter");
  }
  const params: Record<string, unknown> = { channelId: allowedChannelId };
  return await adapter.handleAction({
    channel: "discord",
    action: "read",
    cfg,
    params,
    accountId: "default",
    requesterAccountId: "default",
    conversationReadOrigin: "delegated",
    assertConversationReadAuthority: () => {},
    prepareConversationReadTarget: () => prepare(params),
    ...overrides,
  });
}

beforeEach(() => {
  paths.length = 0;
  clearDiscordDirectoryCacheForTest();
  vi.stubEnv("DISCORD_BOT_TOKEN", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => fixtureFetch(input)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Discord V2 named read target directory policy", () => {
  it("resolves only the trusted current row from an unconfigured guild before applying the limit", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          token: "synthetic-current-directory-token",
          groupPolicy: "allowlist",
          guilds: { [excludedGuildId]: {} },
        },
      },
    };
    await expect(
      invoke(
        cfg,
        async (params) => {
          const rows = await listDiscordDirectoryGroupsLive({
            cfg,
            query: "shared-name",
            limit: 1,
          });
          expect(rows).toEqual([
            {
              kind: "group",
              id: `channel:${allowedChannelId}`,
              name: "shared-name",
              handle: "#shared-name",
              raw: { id: allowedChannelId, name: "shared-name", guild_id: allowedGuildId },
            },
          ]);
          params.channelId = rows[0].id;
        },
        {
          toolContext: { currentChannelProvider: "discord", currentChannelId: allowedChannelId },
        },
      ),
    ).resolves.toMatchObject({ details: { ok: true } });
    expect(paths).toEqual([
      "/users/@me/guilds",
      `/channels/${allowedChannelId}`,
      `/channels/${allowedChannelId}`,
      `/guilds/${allowedGuildId}`,
      `/channels/${allowedChannelId}/messages`,
    ]);
  });

  it.each(["provider", "missing-account", "account", "group", "channel", "category"])(
    "does not expand a named current conversation past its %s restriction",
    async (restriction) => {
      const discord: DiscordConfig = {
        token: "synthetic-current-directory-token",
        groupPolicy: restriction === "group" ? "disabled" : "allowlist",
        guilds:
          restriction === "channel"
            ? { [allowedGuildId]: { channels: { [allowedChannelId]: { enabled: false } } } }
            : restriction === "category"
              ? {
                  [allowedGuildId]: {
                    channels: {
                      [nestedChannelId]: { enabled: true },
                      [deniedCategoryId]: { enabled: false },
                    },
                  },
                }
              : {},
      };
      const cfg: OpenClawConfig = { channels: { discord } };
      await expect(
        invoke(
          cfg,
          async () => {
            const rows = await listDiscordDirectoryGroupsLive({
              cfg,
              query: restriction === "category" ? "secret-child" : "shared-name",
            });
            expect(rows).toEqual([]);
            throw new Error("No matching directory target");
          },
          {
            requesterAccountId:
              restriction === "account"
                ? "other"
                : restriction === "missing-account"
                  ? undefined
                  : "default",
            toolContext: {
              currentChannelProvider: restriction === "provider" ? "slack" : "discord",
              currentChannelId: restriction === "category" ? nestedChannelId : allowedChannelId,
            },
          },
        ),
      ).rejects.toThrow(
        restriction === "account"
          ? "Discord read target account is not allowed"
          : "No matching directory target",
      );
      expect(paths).not.toContain(`/guilds/${excludedGuildId}/channels`);
      expect(paths.some((path) => path.endsWith("/messages"))).toBe(false);
      if (["provider", "missing-account", "group"].includes(restriction)) {
        expect(paths).toEqual(["/users/@me/guilds"]);
      }
      if (restriction === "account") {
        expect(paths).toEqual([]);
      }
      if (restriction === "category") {
        expect(paths).toContain(`/channels/${deniedCategoryId}`);
      }
    },
  );

  it("filters excluded guilds and denied duplicate names before applying the limit and reading", async () => {
    const cfg = config();
    await expect(
      invoke(cfg, async (params) => {
        const rows = await listDiscordDirectoryGroupsLive({ cfg, query: "shared-name", limit: 1 });
        expect(rows.map((row) => row.id)).toEqual([`channel:${allowedChannelId}`]);
        params.channelId = rows[0].id;
      }),
    ).resolves.toMatchObject({ details: { ok: true } });

    expect(paths).toEqual([
      "/users/@me/guilds",
      `/guilds/${allowedGuildId}/channels`,
      `/channels/${allowedChannelId}`,
      `/guilds/${allowedGuildId}`,
      `/channels/${allowedChannelId}/messages`,
    ]);
  });

  it.each(["excluded-only", "secret", "unlisted"])(
    "does not expose a denied name (%s) during target preparation",
    async (query) => {
      const cfg = config();
      await expect(
        invoke(cfg, async () => {
          const rows = await listDiscordDirectoryGroupsLive({ cfg, query });
          expect(rows).toEqual([]);
          throw new Error("No matching directory target");
        }),
      ).rejects.toThrow("No matching directory target");
      expect(paths).toEqual(["/users/@me/guilds", `/guilds/${allowedGuildId}/channels`]);
    },
  );

  it("preserves direct-operator expansion but excludes disabled channels and descendants", async () => {
    const cfg = config();
    await invoke(
      cfg,
      async () => {
        const rows = await listDiscordDirectoryGroupsLive({ cfg });
        expect(rows.map((row) => row.id)).toEqual([
          "channel:200000000000000099",
          `channel:${allowedChannelId}`,
          `channel:${unlistedChannelId}`,
        ]);
      },
      { conversationReadOrigin: "direct-operator" },
    );
  });

  it("does not enumerate or cache members from excluded guilds", async () => {
    const cfg = config(false);
    await invoke(cfg, async () => {
      const rows = await listDiscordDirectoryPeersLive({ cfg, query: "user", limit: 1 });
      expect(rows.map((row) => row.id)).toEqual([`user:${allowedUserId}`]);
      expect(resolveDiscordDirectoryUserId({ handle: "allowed-user" })).toBe(allowedUserId);
      expect(resolveDiscordDirectoryUserId({ handle: "excluded-user" })).toBeUndefined();
    });
    expect(paths).not.toContain(`/guilds/${excludedGuildId}/members/search`);
  });

  it("does not enumerate guild-wide members under a channel-scoped allowlist", async () => {
    const cfg = config();
    await invoke(cfg, async () => {
      expect(await listDiscordDirectoryPeersLive({ cfg, query: "user" })).toEqual([]);
      expect(resolveDiscordDirectoryUserId({ handle: "allowed-user" })).toBeUndefined();
    });
    expect(paths.filter((path) => path.endsWith("/members/search"))).toEqual([]);
  });

  it("rejects a different originating account before directory I/O", async () => {
    const cfg = config();
    await expect(
      invoke(
        cfg,
        async () => {
          await listDiscordDirectoryGroupsLive({ cfg, query: "shared-name" });
        },
        { requesterAccountId: "other" },
      ),
    ).rejects.toThrow("Discord read target account is not allowed");
    expect(paths).toEqual([]);
  });
});
