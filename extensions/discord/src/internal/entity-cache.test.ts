// Discord tests cover entity cache plugin behavior.
import { GatewayDispatchEvents } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordConversationReadAuthority } from "../conversation-read-authority.js";
import { DiscordEntityCache } from "./entity-cache.js";
import { RequestClient } from "./rest.js";
import type { StructureClient } from "./structures.js";

function makeCache(opts: { ttlMs?: number; maxEntries?: number; sweepIntervalMs?: number }) {
  let getCalls = 0;
  const rest = {
    get: async (route: string) => {
      getCalls += 1;
      const id = route.split("/").pop() ?? "x";
      return { id };
    },
  } as unknown as RequestClient;
  const client = {} as StructureClient;
  const cache = new DiscordEntityCache({ client, rest, ...opts });
  return { cache, getCalls: () => getCalls };
}

describe("DiscordEntityCache eviction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps entries by dropping oldest on insert past maxEntries", async () => {
    const { cache } = makeCache({ ttlMs: 60_000, maxEntries: 3 });

    await cache.fetchUser("u1");
    await cache.fetchUser("u2");
    await cache.fetchUser("u3");
    expect(cache.size).toBe(3);

    await cache.fetchUser("u4");
    expect(cache.size).toBe(3);
  });

  it("sweeps expired entries on insert when sweep interval has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { cache } = makeCache({ ttlMs: 1, sweepIntervalMs: 0, maxEntries: 1000 });

    await cache.fetchUser("u1");
    await cache.fetchUser("u2");
    expect(cache.size).toBe(2);

    vi.advanceTimersByTime(5);

    await cache.fetchUser("u3");
    expect(cache.size).toBe(1);
  });

  it("does not sweep before sweep interval elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { cache } = makeCache({
      ttlMs: 1,
      sweepIntervalMs: 60_000,
      maxEntries: 1000,
    });

    await cache.fetchUser("u1");
    await cache.fetchUser("u2");
    vi.advanceTimersByTime(5);
    await cache.fetchUser("u3");

    expect(cache.size).toBe(3);
  });

  it("does not write when ttl is 0", async () => {
    const { cache } = makeCache({ ttlMs: 0 });

    await cache.fetchUser("u1");
    await cache.fetchUser("u2");

    expect(cache.size).toBe(0);
  });

  it("reuses normalized guild emojis until their cache entry expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { cache } = makeCache({ ttlMs: 30_000 });
    const fetchEmojis = vi.fn(async () => [{ name: "party", identifier: "party:1" }]);

    expect(await cache.fetchGuildEmojis("g1", fetchEmojis)).toEqual([
      { name: "party", identifier: "party:1" },
    ]);
    await cache.fetchGuildEmojis("g1", fetchEmojis);
    expect(fetchEmojis).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    await cache.fetchGuildEmojis("g1", fetchEmojis);
    expect(fetchEmojis).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["updated", GatewayDispatchEvents.ThreadUpdate],
    ["deleted", GatewayDispatchEvents.ThreadDelete],
  ])("invalidates cached channels when a thread is %s", async (_label, eventType) => {
    const { cache, getCalls } = makeCache({ ttlMs: 60_000 });

    await cache.fetchChannel("thread-42");
    await cache.fetchChannel("thread-42");
    expect(getCalls()).toBe(1);

    cache.invalidateForGatewayEvent(eventType, { id: "thread-42" });
    await cache.fetchChannel("thread-42");

    expect(getCalls()).toBe(2);
  });
});

describe("DiscordEntityCache gateway invalidation", () => {
  it("invalidates only the updated guild's normalized emoji list", async () => {
    const { cache } = makeCache({ ttlMs: 60_000 });
    const fetchEmojis = vi.fn(async () => [{ name: "party", identifier: "party:1" }]);

    await cache.fetchGuildEmojis("g1", fetchEmojis);
    await cache.fetchGuildEmojis("g2", fetchEmojis);
    cache.invalidateForGatewayEvent(GatewayDispatchEvents.GuildEmojisUpdate, { guild_id: "g1" });
    await cache.fetchGuildEmojis("g1", fetchEmojis);
    await cache.fetchGuildEmojis("g2", fetchEmojis);

    expect(fetchEmojis).toHaveBeenCalledTimes(3);
  });

  it.each([
    GatewayDispatchEvents.GuildMemberAdd,
    GatewayDispatchEvents.GuildMemberRemove,
    GatewayDispatchEvents.GuildMemberUpdate,
  ])("invalidates member and user entries for %s", async (event) => {
    const { cache, getCalls } = makeCache({ ttlMs: 60_000 });

    await cache.fetchMember("g1", "u1");
    await cache.fetchUser("u1");
    await cache.fetchMember("g1", "u1");
    await cache.fetchUser("u1");
    expect(getCalls()).toBe(2);

    cache.invalidateForGatewayEvent(event, { guild_id: "g1", user: { id: "u1" } });

    await cache.fetchMember("g1", "u1");
    await cache.fetchUser("u1");
    expect(getCalls()).toBe(4);
  });
});

describe("DiscordEntityCache read authority", () => {
  it.each([false, true])(
    "rechecks the originating owner after normalization awaits beyond REST (replaced=%s)",
    async (replaced) => {
      const restValue = [{ name: "original", identifier: "original:1" }];
      const replacementValue = [{ name: "replacement", identifier: "replacement:2" }];
      const otherGuildValue = [{ name: "other", identifier: "other:3" }];
      const rest = new RequestClient("synthetic-cache-token", {
        queueRequests: false,
        fetch: async () => new Response(JSON.stringify(restValue)),
      });
      const cache = new DiscordEntityCache({
        rest,
        client: {
          rest,
          fetchUser: async () => {
            throw new Error("Unexpected user fetch in emoji cache fixture");
          },
        },
      });
      await cache.fetchGuildEmojis("other-guild", async () => otherGuildValue);
      const restCompleted = createDeferred<void>();
      const normalized = createDeferred<void>();
      const originalOwner = {};
      let currentOwner = originalOwner;
      const assertOriginalOwner = () => {
        if (currentOwner !== originalOwner) {
          throw new Error("Synthetic cache read owner was replaced");
        }
      };
      const pending = discordConversationReadAuthority.run(assertOriginalOwner, () =>
        cache.fetchGuildEmojis("guild", async () => {
          const value = await rest.get("/guilds/123456789012345678/emojis");
          restCompleted.resolve();
          await normalized.promise;
          return value;
        }),
      );
      const outcome = Promise.allSettled([pending]);
      try {
        await restCompleted.promise;
        expect(cache.size).toBe(1);
        if (replaced) {
          currentOwner = {};
          await cache.fetchGuildEmojis("guild", async () => replacementValue);
        }
        normalized.resolve();
        expect(await outcome).toEqual([
          replaced
            ? { status: "rejected", reason: new Error("Synthetic cache read owner was replaced") }
            : { status: "fulfilled", value: restValue },
        ]);
        const unexpectedFetch = vi.fn(async () => []);
        // The late original result must not overwrite the healthy replacement or
        // evict another guild; both reads must still be served from the cache.
        await expect(cache.fetchGuildEmojis("guild", unexpectedFetch)).resolves.toEqual(
          replaced ? replacementValue : restValue,
        );
        await expect(cache.fetchGuildEmojis("other-guild", unexpectedFetch)).resolves.toEqual(
          otherGuildValue,
        );
        if (replaced) {
          await expect(
            discordConversationReadAuthority.run(assertOriginalOwner, () =>
              cache.fetchGuildEmojis("guild", unexpectedFetch),
            ),
          ).rejects.toThrow("Synthetic cache read owner was replaced");
        }
        expect(unexpectedFetch).not.toHaveBeenCalled();
        expect(cache.size).toBe(2);
      } finally {
        normalized.resolve();
        rest.abortAllRequests();
        await outcome;
      }
    },
  );
});
