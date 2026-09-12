import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordApiError, requestDiscord } from "./api.js";
import { discordConversationReadAuthority } from "./conversation-read-authority.js";
import { discordDirectoryCacheState } from "./directory-cache-state.js";
import { rememberDiscordDirectoryUser, resolveDiscordDirectoryUserId } from "./directory-cache.js";
import { jsonResponse } from "./test-http-helpers.js";

const accountId = "synthetic-api-authority";

afterEach(() => {
  discordDirectoryCacheState.handlesByAccount.delete(accountId);
  vi.useRealTimers();
});

function authority() {
  let active = true;
  return {
    assert: () => {
      if (!active) {
        throw new Error("Synthetic API read authority revoked");
      }
    },
    revoke: () => {
      active = false;
    },
  };
}

describe("Discord directory API read authority", () => {
  it.each([403, 429].flatMap((status) => [false, true].map((revoked) => ({ status, revoked }))))(
    "fences a delayed HTTP $status error body (revoked=$revoked)",
    async ({ status, revoked }) => {
      vi.useFakeTimers();
      const owner = authority();
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              started.resolve();
              await release.promise;
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ message: "Synthetic body", retry_after: 1 }),
                ),
              );
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { status },
      );
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(jsonResponse([{ id: "123456789012345678", name: "healthy retry" }]));
      let settled: PromiseSettledResult<unknown>[] | undefined;
      const pending = discordConversationReadAuthority.run(owner.assert, () =>
        requestDiscord("/users/@me/guilds", "synthetic-api-token", {
          fetcher,
          endpointRuntime: null,
          retry: { attempts: 2, minDelayMs: 1000, maxDelayMs: 1000, jitter: 0 },
        }),
      );
      const outcome = Promise.allSettled([pending]).then((results) => {
        settled = results;
        return results;
      });
      try {
        await started.promise;
        if (revoked) {
          owner.revoke();
        }
        release.resolve();
        await vi.advanceTimersByTimeAsync(0);
        if (revoked) {
          // A revoked 429 must reject now, without entering its retry timer.
          expect(settled).toEqual([
            { status: "rejected", reason: new Error("Synthetic API read authority revoked") },
          ]);
          expect(vi.getTimerCount()).toBe(0);
          expect(fetcher).toHaveBeenCalledOnce();
        } else if (status === 403) {
          expect(settled).toEqual([
            {
              status: "rejected",
              reason: expect.objectContaining({
                status: 403,
                message: expect.stringContaining("Synthetic body"),
              }),
            },
          ]);
          await expect(pending).rejects.toBeInstanceOf(DiscordApiError);
          expect(fetcher).toHaveBeenCalledOnce();
        } else {
          expect(settled).toBeUndefined();
          expect(fetcher).toHaveBeenCalledOnce();
          await vi.advanceTimersByTimeAsync(1000);
          expect(await outcome).toEqual([
            { status: "fulfilled", value: [{ id: "123456789012345678", name: "healthy retry" }] },
          ]);
          expect(fetcher).toHaveBeenCalledTimes(2);
        }
      } finally {
        release.resolve();
        await vi.runAllTimersAsync();
        await outcome;
      }
    },
  );

  it.each([false, true])("rechecks authority before a 429 retry (revoked=%s)", async (revoked) => {
    vi.useFakeTimers();
    const owner = authority();
    const limited = createDeferred<void>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        limited.resolve();
        return jsonResponse({ message: "Rate limited", retry_after: 1 }, 429);
      })
      .mockResolvedValueOnce(jsonResponse([{ id: "123456789012345678", name: "fixture" }]));
    const pending = discordConversationReadAuthority.run(owner.assert, () =>
      requestDiscord("/users/@me/guilds", "synthetic-api-token", {
        fetcher,
        endpointRuntime: null,
        retry: { attempts: 2, minDelayMs: 1000, maxDelayMs: 1000, jitter: 0 },
      }),
    );
    const outcome = Promise.allSettled([pending]);
    await Promise.race([
      limited.promise,
      outcome.then(() => {
        throw new Error("API request settled before the initial fixture request");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    if (revoked) {
      owner.revoke();
    }
    await vi.advanceTimersByTimeAsync(1000);
    const [result] = await outcome;
    if (revoked) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.reason)).toContain("Synthetic API read authority revoked");
      }
      expect(fetcher).toHaveBeenCalledOnce();
    } else {
      expect(result).toEqual({
        status: "fulfilled",
        value: [{ id: "123456789012345678", name: "fixture" }],
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe("https://discord.com/api/v10/users/@me/guilds");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bot synthetic-api-token");
    }
  });

  it("rejects a stale directory-cache publication without replacing the healthy entry", () => {
    const owner = authority();
    const handle = "synthetic-collector";
    discordConversationReadAuthority.run(owner.assert, () =>
      rememberDiscordDirectoryUser({ accountId, userId: "123456789012345678", handles: [handle] }),
    );
    expect(resolveDiscordDirectoryUserId({ accountId, handle })).toBe("123456789012345678");
    owner.revoke();
    expect(() =>
      discordConversationReadAuthority.run(owner.assert, () =>
        rememberDiscordDirectoryUser({
          accountId,
          userId: "223456789012345678",
          handles: [handle, "stale-new-handle"],
        }),
      ),
    ).toThrow("Synthetic API read authority revoked");
    expect(resolveDiscordDirectoryUserId({ accountId, handle })).toBe("123456789012345678");
    expect(
      resolveDiscordDirectoryUserId({ accountId, handle: "stale-new-handle" }),
    ).toBeUndefined();
  });
});
