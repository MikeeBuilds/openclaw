import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createHostCurrentTurnDeliveryOwner } from "./host-tool-surface.js";

function createCurrentTurnDelivery() {
  return createHostCurrentTurnDeliveryOwner({
    abortSignal: new AbortController().signal,
    assertActive: () => {},
    attempt: {
      agentId: "main",
      config: { tools: { codeMode: { enabled: true } } } as OpenClawConfig,
      model: { compat: { supportsTools: true } },
      modelId: "gpt-test",
      provider: "openai",
      sessionKey: "agent:main:telegram:direct:123",
    } as never,
    sessionTarget: {
      agentId: "main",
      expectedWriterRunId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:123",
      storePath: "/state/sessions.json",
    },
  });
}

describe("agent harness host tool surface", () => {
  it("keeps delivery authority independent from terminal-result capability", () => {
    const owner = createCurrentTurnDelivery();

    const ordinaryDelivery = owner.create();
    const terminalDelivery = owner.create({ terminalCompletion: "per-result" });

    expect(ordinaryDelivery).toEqual({
      deliveryAuthority: expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        assertActive: expect.any(Function),
      }),
    });
    expect(terminalDelivery).toEqual({
      deliveryAuthority: ordinaryDelivery.deliveryAuthority,
      terminalReply: {
        authority: expect.objectContaining({
          abortSignal: expect.any(AbortSignal),
          assertActive: expect.any(Function),
        }),
        toolRef: {},
      },
    });
  });

  it("keeps ordinary delivery without minting terminal authority when no writer exists", () => {
    const owner = createHostCurrentTurnDeliveryOwner({
      abortSignal: new AbortController().signal,
      assertActive: () => {},
      attempt: {
        config: { tools: { codeMode: { enabled: true } } } as OpenClawConfig,
        model: { compat: { supportsTools: true } },
        modelId: "gpt-test",
        provider: "openai",
      } as never,
      sessionTarget: undefined,
    });

    expect(owner.create({ terminalCompletion: "per-result" })).toEqual({
      deliveryAuthority: owner.authority,
    });
  });
});
