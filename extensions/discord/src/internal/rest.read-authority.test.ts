import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { discordConversationReadAuthority } from "../conversation-read-authority.js";
import { RequestClient } from "./rest.js";

const path = "/guilds/123456789012345678/emojis";
const authorityError = "Synthetic REST read owner was replaced";
const rateLimitHeaders = {
  "X-RateLimit-Bucket": "synthetic-emojis",
  "X-RateLimit-Limit": "1",
  "X-RateLimit-Remaining": "0",
  "X-RateLimit-Reset-After": "60",
};

function createAuthority() {
  const originalOwner = {};
  let currentOwner = originalOwner;
  return {
    assert: () => {
      if (currentOwner !== originalOwner) {
        throw new Error(authorityError);
      }
    },
    replace: () => {
      currentOwner = {};
    },
  };
}

function createDelayedBodyResponse(status: number) {
  const started = createDeferred<void>();
  const released = createDeferred<void>();
  const payload =
    status === 200
      ? [{ id: "223456789012345678", name: "synthetic" }]
      : { message: "Synthetic rejection", retry_after: 60, global: true };
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          started.resolve();
          await released.promise;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    { status, headers: rateLimitHeaders },
  );
  return { response, started, released, payload };
}

function expectNoResponsePublication(client: RequestClient) {
  expect(client.getSchedulerMetrics()).toMatchObject({
    globalRateLimitUntil: 0,
    routeBucketMappings: 0,
    invalidRequestCount: 0,
    invalidRequestCountByStatus: {},
    queueSize: 0,
    activeWorkers: 0,
  });
  expect(client.getSchedulerMetrics().buckets).toEqual([]);
}

describe("Discord REST response read authority", () => {
  it.each([false, true])(
    "rejects a replaced owner after fetch without consuming the body (queued=%s)",
    async (queueRequests) => {
      const owner = createAuthority();
      const started = createDeferred<void>();
      const delayed = createDeferred<Response>();
      const fetcher = vi.fn<typeof fetch>(async () => {
        started.resolve();
        return await delayed.promise;
      });
      const client = new RequestClient("synthetic-rest-token", { queueRequests, fetch: fetcher });
      const response = new Response("[]", { headers: rateLimitHeaders });
      const pending = discordConversationReadAuthority.run(owner.assert, () => client.get(path));
      const outcome = Promise.allSettled([pending]);
      try {
        await started.promise;
        owner.replace();
        delayed.resolve(response);
        expect(await outcome).toEqual([{ status: "rejected", reason: new Error(authorityError) }]);
        expect(response.bodyUsed).toBe(false);
        expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        expect(fetcher).toHaveBeenCalledOnce();
        expectNoResponsePublication(client);
      } finally {
        delayed.resolve(response);
        client.abortAllRequests();
        await outcome;
        await response.body?.cancel();
      }
    },
  );

  it.each(
    [false, true].flatMap((queueRequests) =>
      [200, 403, 429].map((status) => ({ queueRequests, status })),
    ),
  )(
    "rejects a replaced owner after body consumption before publishing HTTP $status state (queued=$queueRequests)",
    async ({ queueRequests, status }) => {
      const owner = createAuthority();
      const delayed = createDelayedBodyResponse(status);
      const fetcher = vi.fn<typeof fetch>(async () => delayed.response);
      const client = new RequestClient("synthetic-rest-token", {
        queueRequests,
        fetch: fetcher,
        scheduler: { maxRateLimitRetries: 0 },
      });
      const pending = discordConversationReadAuthority.run(owner.assert, () => client.get(path));
      const outcome = Promise.allSettled([pending]);
      try {
        await delayed.started.promise;
        owner.replace();
        delayed.released.resolve();
        expect(await outcome).toEqual([{ status: "rejected", reason: new Error(authorityError) }]);
        expect(delayed.response.bodyUsed).toBe(true);
        expect(fetcher).toHaveBeenCalledOnce();
        expectNoResponsePublication(client);
      } finally {
        delayed.released.resolve();
        client.abortAllRequests();
        await outcome;
      }
    },
  );

  it.each([false, true])(
    "retains successful data and bucket publication for a live owner (queued=%s)",
    async (queueRequests) => {
      const owner = createAuthority();
      const delayed = createDelayedBodyResponse(200);
      const client = new RequestClient("synthetic-rest-token", {
        queueRequests,
        fetch: async () => delayed.response,
      });
      const pending = discordConversationReadAuthority.run(owner.assert, () => client.get(path));
      const outcome = Promise.allSettled([pending]);
      try {
        await delayed.started.promise;
        delayed.released.resolve();
        expect(await outcome).toEqual([{ status: "fulfilled", value: delayed.payload }]);
        expect(client.getSchedulerMetrics()).toMatchObject({ routeBucketMappings: 1 });
        expect(client.getSchedulerMetrics().buckets).toEqual([
          expect.objectContaining({
            // Public diagnostics retain bucket equality through a stable hash.
            bucket: "sha256:3ba8a404383085c91e32b3976770b852",
            remaining: 0,
          }),
        ]);
      } finally {
        delayed.released.resolve();
        client.abortAllRequests();
        await outcome;
      }
    },
  );
});
