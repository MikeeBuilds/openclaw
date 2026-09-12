import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { targetResolutionAuthority } from "./target-resolution-authority.js";
import { resetDirectoryCache, resolveChannelTarget } from "./target-resolver.js";

const { discordPlugin } = loadBundledPluginPublicArtifactModuleSync<{
  discordPlugin: ChannelPlugin;
}>({
  dirName: "discord",
  artifactBasename: "channel-plugin-api.js",
});

const allowedGuildId = "500000000000000001";
const excludedGuildId = "500000000000000002";
const allowedChannelId = "600000000000000001";
const excludedChannelId = "600000000000000002";
const cfg: OpenClawConfig = {
  channels: {
    discord: {
      token: "synthetic-composed-directory-token",
      groupPolicy: "allowlist",
      guilds: { [allowedGuildId]: {} },
    },
  },
};
const paths: string[] = [];

function fixtureFetch(input: Parameters<typeof fetch>[0]) {
  const url = new URL(input instanceof Request ? input.url : input);
  const path = url.pathname.replace(/^\/api\/v10/, "");
  paths.push(path);
  const allowed = { id: allowedChannelId, name: "shared", guild_id: allowedGuildId, type: 0 };
  switch (path) {
    case "/users/@me/guilds":
      return Response.json([
        { id: excludedGuildId, name: "Excluded" },
        { id: allowedGuildId, name: "Allowed" },
      ]);
    case `/guilds/${excludedGuildId}/channels`:
      return Response.json([{ id: excludedChannelId, name: "shared", type: 0 }]);
    case `/guilds/${allowedGuildId}/channels`:
      return Response.json([allowed]);
    case `/channels/${allowedChannelId}`:
      return Response.json(allowed);
    case `/channels/${allowedChannelId}/messages`:
      return Response.json([{ id: "700000000000000001", content: "allowed message" }]);
    default:
      throw new Error(`Unexpected fixture request: ${path}`);
  }
}

beforeEach(() => {
  paths.length = 0;
  resetDirectoryCache();
  vi.stubEnv("DISCORD_BOT_TOKEN", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => fixtureFetch(input)),
  );
});

afterEach(() => {
  resetDirectoryCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("does not reuse broader outbound directory matches for a delegated Discord V2 read", async () => {
  const target = { cfg, channel: "discord", input: "shared", plugin: discordPlugin };
  const broad = await resolveChannelTarget(target);
  expect(broad).toMatchObject({
    ok: false,
    candidates: [{ id: `channel:${excludedChannelId}` }, { id: `channel:${allowedChannelId}` }],
  });
  if (broad.ok) {
    throw new Error("Expected broader outbound lookup to be ambiguous");
  }
  expect(paths).toContain(`/guilds/${excludedGuildId}/channels`);
  paths.length = 0;

  const adapter = discordPlugin.actions?.conversationReadAuthority;
  if (!adapter) {
    throw new Error("Missing Discord V2 adapter");
  }
  const params: Record<string, unknown> = {};
  const assertCurrent = vi.fn();
  await expect(
    targetResolutionAuthority.run(assertCurrent, () =>
      adapter.handleAction({
        channel: "discord",
        action: "read",
        cfg,
        params,
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        assertConversationReadAuthority: assertCurrent,
        prepareConversationReadTarget: async () => {
          const resolved = await resolveChannelTarget(target);
          expect(resolved).toMatchObject({
            ok: true,
            target: { to: `channel:${allowedChannelId}` },
          });
          if (!resolved.ok) {
            throw resolved.error;
          }
          params.channelId = resolved.target.to;
        },
      }),
    ),
  ).resolves.toMatchObject({ details: { ok: true } });
  expect(paths).toEqual([
    "/users/@me/guilds",
    `/guilds/${allowedGuildId}/channels`,
    `/channels/${allowedChannelId}`,
    `/channels/${allowedChannelId}/messages`,
  ]);
  expect(assertCurrent).toHaveBeenCalled();

  paths.length = 0;
  expect(await resolveChannelTarget(target)).toMatchObject({
    ok: false,
    candidates: broad.candidates,
  });
  expect(paths).toEqual([]);
});
