import { AsyncLocalStorage } from "node:async_hooks";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";

// Directory preparation runs before action dispatch, but must use the same
// invocation origin and current-conversation policy as the final read.
type DiscordConversationReadContext = Pick<
  ChannelMessageActionContext,
  "conversationReadOrigin" | "requesterAccountId" | "toolContext"
>;

// The adapter owns the invocation scope; REST requests retain its assertion
// individually so shared queues cannot inherit another action's authority.
export const discordConversationReadAuthority = new AsyncLocalStorage<
  ((() => void) & { readContext?: DiscordConversationReadContext }) | undefined
>();
