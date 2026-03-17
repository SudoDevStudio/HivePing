import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ApprovalGrantStore } from "../../core/approval-grant-store.js";
import { ApprovalStore } from "../../core/approval-store.js";
import { BindingStore } from "../../core/binding-store.js";
import { HistoryStore } from "../../core/history-store.js";
import { registerMentionHook, resetMentionHookStateForTests } from "../../hooks/mention.js";

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function createDeps(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "hiveping-mention-hook-"));
  return {
    config: {
      mentionHookEnabled: true,
      rolePolicyEnabled: false,
      ...config,
    },
    store: new BindingStore(path.join(root, "bindings.json")),
    approvals: new ApprovalStore(path.join(root, "approvals.json")),
    grants: new ApprovalGrantStore(path.join(root, "grants.json")),
    history: new HistoryStore(path.join(root, "history.json")),
    historyMaxMessages: 20,
  };
}

function createApiHarness() {
  resetMentionHookStateForTests();
  const handlers = new Map<string, HookHandler>();
  const deliveries: Array<{
    channelId: string;
    target: string;
    content: string;
    accountId?: string;
    replyTo?: string;
    threadId?: string;
  }> = [];
  const api = {
    on: (hookName: string, handler: HookHandler) => {
      handlers.set(hookName, handler);
    },
    logger: {},
  };
  return {
    api,
    handlers,
    deliveries,
    sendReply: async (delivery: {
      channelId: string;
      target: string;
      content: string;
      accountId?: string;
      replyTo?: string;
      threadId?: string;
    }) => {
      deliveries.push(delivery);
    },
  };
}

test("mention hook accepts plain text when explicit mention metadata is present", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "discord:123",
      content: "help",
      metadata: {
        wasMentioned: true,
        to: "channel:123456789012345678",
      },
    },
    {
      channelId: "discord",
      conversationId: "channel:123456789012345678",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.channelId, "discord");
  assert.equal(deliveries[0]?.target, "channel:123456789012345678");
  assert.match(deliveries[0]?.content || "", /HivePing mention flow:/);

  const suppressed = await messageSending?.(
    { to: "channel:123456789012345678" },
    { channelId: "discord", conversationId: "channel:123456789012345678" },
  );
  assert.equal(suppressed?.cancel, true);

  const notSuppressedAgain = await messageSending?.(
    { to: "channel:123456789012345678" },
    { channelId: "discord", conversationId: "channel:123456789012345678" },
  );
  assert.equal(notSuppressedAgain, undefined);
});

test("mention hook does not capture non-mention text without explicit mention metadata", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "discord:123",
      content: "help",
      metadata: {
        to: "channel:223456789012345678",
        wasMentioned: false,
      },
    },
    {
      channelId: "discord",
      conversationId: "channel:223456789012345678",
    },
  );

  assert.equal(handled, undefined);
  assert.equal(deliveries.length, 0);

  const suppressed = await messageSending?.(
    { to: "channel:223456789012345678" },
    { channelId: "discord", conversationId: "channel:223456789012345678" },
  );
  assert.equal(suppressed, undefined);
});

test("mention hook ignores plain text when mention metadata is missing", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "discord:123",
      content: "status",
      metadata: {
        to: "channel:legacy",
      },
    },
    {
      channelId: "discord",
      conversationId: "channel:legacy",
    },
  );

  assert.equal(handled, undefined);
  assert.equal(deliveries.length, 0);

  const suppressed = await messageSending?.(
    { to: "channel:legacy" },
    { channelId: "discord", conversationId: "channel:legacy" },
  );
  assert.equal(suppressed, undefined);
});

test("mention hook accepts Slack native mention token with label", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "<@U999|HivePing> status",
      metadata: {
        to: "channel:C55",
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C55",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.channelId, "slack");
  assert.equal(deliveries[0]?.target, "channel:C55");
  assert.match(deliveries[0]?.content || "", /No repository is bound/);

  const suppressed = await messageSending?.(
    { to: "channel:C55" },
    { channelId: "slack", conversationId: "channel:C55" },
  );
  assert.equal(suppressed?.cancel, true);
});

test("mention hook accepts @hiveping alias", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "discord:123",
      content: "@hiveping status",
      metadata: {
        to: "channel:hiveping-alias",
        wasMentioned: true,
      },
    },
    {
      channelId: "discord",
      conversationId: "channel:hiveping-alias",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.channelId, "discord");
  assert.equal(deliveries[0]?.target, "channel:hiveping-alias");
  assert.match(deliveries[0]?.content || "", /No repository is bound/);

  const suppressed = await messageSending?.(
    { to: "channel:hiveping-alias" },
    { channelId: "discord", conversationId: "channel:hiveping-alias" },
  );
  assert.equal(suppressed?.cancel, true);
});

test("mention hook routes agent aliases to fixed project context", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(
    api,
    createDeps({
      agents: [
        {
          id: "fe",
          aliases: ["@hiveping1"],
          repoPath: "/workspace/frontend-app",
          homeConversationKey: "slack:T_DEFAULT:C_FE",
        },
      ],
    }),
    { sendReply },
  );

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "@hiveping1 status",
      metadata: {
        to: "channel:C_SHARED",
        wasMentioned: true,
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C_SHARED",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0]?.content || "", /Agent: fe/);
  assert.match(deliveries[0]?.content || "", /History key: slack:T_DEFAULT:C_FE/);
  assert.match(deliveries[0]?.content || "", /\/workspace\/frontend-app/);

  const suppressed = await messageSending?.(
    { to: "channel:C_SHARED" },
    { channelId: "slack", conversationId: "channel:C_SHARED" },
  );
  assert.equal(suppressed?.cancel, true);
});

test("mention hook supports parenthesized derived agent aliases from agent id", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(
    api,
    createDeps({
      agents: [
        {
          id: "frontend",
          repoPath: "/workspace/frontend-app",
          homeConversationKey: "slack:T_DEFAULT:C_FE",
        },
      ],
    }),
    { sendReply },
  );

  const messageReceived = handlers.get("message_received");
  assert.ok(messageReceived);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "@hiveping (frontend) status",
      metadata: {
        to: "channel:C_SHARED",
        wasMentioned: true,
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C_SHARED",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0]?.content || "", /Agent: frontend/);
  assert.match(deliveries[0]?.content || "", /History key: slack:T_DEFAULT:C_FE/);
});

test("mention hook supports parenthesized derived agent aliases for ids with spaces", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(
    api,
    createDeps({
      agents: [
        {
          id: "project a",
          repoPath: "/workspace/project-a",
          homeConversationKey: "slack:T_DEFAULT:C_PROJECT_A",
        },
      ],
    }),
    { sendReply },
  );

  const messageReceived = handlers.get("message_received");
  assert.ok(messageReceived);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "@hiveping (project a) status",
      metadata: {
        to: "channel:C_SHARED",
        wasMentioned: true,
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C_SHARED",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0]?.content || "", /Agent: project a/);
  assert.match(deliveries[0]?.content || "", /History key: slack:T_DEFAULT:C_PROJECT_A/);
});

test("mention hook does not treat parenthesized agent aliases inside normal questions as routing indicators", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(
    api,
    createDeps({
      agents: [
        {
          id: "project-a",
          repoPath: "/workspace/project-a",
          homeConversationKey: "slack:T_DEFAULT:C_PROJECT_A",
        },
      ],
    }),
    { sendReply },
  );

  const messageReceived = handlers.get("message_received");
  assert.ok(messageReceived);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "@hiveping what is meta(project-a tags) of this project",
      metadata: {
        to: "channel:C_SHARED",
        wasMentioned: true,
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C_SHARED",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.doesNotMatch(deliveries[0]?.content || "", /Agent: project-a/);
  assert.match(deliveries[0]?.content || "", /No repository is bound/);
});

test("mention hook allows agent routing only in configured channels", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(
    api,
    createDeps({
      agents: [
        {
          id: "project-a",
          repoPath: "/workspace/project-a",
          homeConversationKey: "slack:T_DEFAULT:C_PROJECT_A",
          allowedChannels: ["project-a-room"],
        },
      ],
    }),
    { sendReply },
  );

  const messageReceived = handlers.get("message_received");
  assert.ok(messageReceived);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "@hiveping (project-a) status",
      metadata: {
        to: "channel:C_ALLOWED",
        channelName: "project-a-room",
        wasMentioned: true,
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C_ALLOWED",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0]?.content || "", /Agent: project-a/);
});

test("mention hook blocks agent routing outside configured channels", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(
    api,
    createDeps({
      agents: [
        {
          id: "project-a",
          repoPath: "/workspace/project-a",
          homeConversationKey: "slack:T_DEFAULT:C_PROJECT_A",
          allowedChannels: ["project-a-room"],
        },
      ],
    }),
    { sendReply },
  );

  const messageReceived = handlers.get("message_received");
  assert.ok(messageReceived);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "@hiveping (project-a) status",
      metadata: {
        to: "channel:C_OTHER",
        channelName: "shared-room",
        wasMentioned: true,
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C_OTHER",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0]?.content || "", /not allowed in this channel/i);
  assert.match(deliveries[0]?.content || "", /project-a-room/);
  assert.doesNotMatch(deliveries[0]?.content || "", /No repository is bound/);
});

test("mention hook consolidates responses when multiple agent aliases are mentioned", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  let consolidationPrompt = "";
  let consolidationAgentIds: string[] = [];
  registerMentionHook(
    api,
    createDeps({
      agents: [
        {
          id: "fe",
          aliases: ["@hiveping1"],
          repoPath: "/workspace/frontend-app",
          homeConversationKey: "slack:T_DEFAULT:C_FE",
        },
        {
          id: "api",
          aliases: ["@hiveping2"],
          repoPath: "/workspace/api-service",
          homeConversationKey: "slack:T_DEFAULT:C_API",
        },
      ],
    }),
    {
      sendReply,
      consolidateReply: async ({ prompt, results }) => {
        consolidationPrompt = prompt;
        consolidationAgentIds = results.map((result) => result.agentProfile.id);
        return `Final model synthesis for ${results.map((result) => result.agentProfile.id).join(", ")}`;
      },
    },
  );

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "@hiveping1 @hiveping2 status",
      metadata: {
        to: "channel:C_SHARED",
        wasMentioned: true,
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C_SHARED",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.content, "Final model synthesis for fe, api");
  assert.equal(consolidationPrompt, "status");
  assert.deepEqual(consolidationAgentIds, ["fe", "api"]);

  const suppressed = await messageSending?.(
    { to: "channel:C_SHARED" },
    { channelId: "slack", conversationId: "channel:C_SHARED" },
  );
  assert.equal(suppressed?.cancel, true);
});

test("mention hook accepts Slack stripped alias text fallback", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "hiveping status",
      metadata: {
        to: "channel:C55",
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C55",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.target, "channel:C55");
  assert.match(deliveries[0]?.content || "", /No repository is bound/);

  const suppressed = await messageSending?.(
    { to: "channel:C55" },
    { channelId: "slack", conversationId: "channel:C55" },
  );
  assert.equal(suppressed?.cancel, true);
});

test("mention hook can send using metadata target when conversation id is missing", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      content: "status",
      metadata: {
        wasMentioned: true,
        to: "channel:C55",
      },
    },
    {
      channelId: "slack",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.target, "channel:C55");
  assert.match(deliveries[0]?.content || "", /No repository is bound/);

  const suppressed = await messageSending?.(
    { to: "channel:C55" },
    { channelId: "slack", conversationId: "channel:C55" },
  );
  assert.equal(suppressed?.cancel, true);
});

test("mention hook uses senderId for whoami identity instead of channel sender", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "slack:channel:C55",
      content: "whoami",
      metadata: {
        wasMentioned: true,
        to: "channel:C55",
        senderId: "U_TWO",
        senderUsername: "user-two",
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C55",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0]?.content || "", /Detected sender: U_TWO/);
  assert.match(deliveries[0]?.content || "", /Detected username: user-two/);
  assert.match(deliveries[0]?.content || "", /Resolved principal: slack:U_TWO/);

  const suppressed = await messageSending?.(
    { to: "channel:C55" },
    { channelId: "slack", conversationId: "channel:C55" },
  );
  assert.equal(suppressed?.cancel, true);
});

test("before_prompt_build suppresses explicit @hiveping prompts", async () => {
  const { api, handlers, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const beforePromptBuild = handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild);

  const result = await beforePromptBuild?.(
    {
      messages: [
        {
          role: "user",
          content: "@hiveping status",
        },
      ],
    },
    {},
  );

  assert.equal(typeof result?.prependSystemContext, "string");
  assert.match(result?.prependSystemContext || "", /NO_REPLY/);
  assert.match(result?.prependContext || "", /NO_REPLY/);
});

test("before_agent_start suppresses explicit @hiveping prompts", async () => {
  const { api, handlers, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const beforeAgentStart = handlers.get("before_agent_start");
  assert.ok(beforeAgentStart);

  const result = await beforeAgentStart?.(
    {
      prompt: "@hiveping status",
    },
    {},
  );

  assert.equal(typeof result?.prependSystemContext, "string");
  assert.match(result?.prependSystemContext || "", /NO_REPLY/);
  assert.match(result?.prependContext || "", /NO_REPLY/);
});

test("before_prompt_build suppresses metadata-only mention fallback", async () => {
  const { api, handlers, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const beforePromptBuild = handlers.get("before_prompt_build");
  assert.ok(messageReceived);
  assert.ok(beforePromptBuild);

  await messageReceived?.(
    {
      from: "discord:123",
      content: "status",
      metadata: {
        wasMentioned: true,
        to: "channel:meta-fallback",
      },
    },
    {
      channelId: "discord",
      conversationId: "channel:meta-fallback",
    },
  );

  const result = await beforePromptBuild?.(
    {
      messages: [
        {
          role: "user",
          content: "status",
        },
      ],
    },
    {},
  );

  assert.equal(typeof result?.prependSystemContext, "string");
  assert.match(result?.prependSystemContext || "", /NO_REPLY/);
});

test("before_agent_start suppresses metadata-only mention fallback", async () => {
  const { api, handlers, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const beforeAgentStart = handlers.get("before_agent_start");
  assert.ok(messageReceived);
  assert.ok(beforeAgentStart);

  await messageReceived?.(
    {
      from: "discord:123",
      content: "status",
      metadata: {
        wasMentioned: true,
        to: "channel:meta-fallback",
      },
    },
    {
      channelId: "discord",
      conversationId: "channel:meta-fallback",
    },
  );

  const result = await beforeAgentStart?.(
    {
      prompt: "status",
    },
    {},
  );

  assert.equal(typeof result?.prependSystemContext, "string");
  assert.match(result?.prependSystemContext || "", /NO_REPLY/);
});

test("before_prompt_build does not suppress normal non-mention prompt", async () => {
  const { api, handlers, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const beforePromptBuild = handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild);

  const result = await beforePromptBuild?.(
    {
      messages: [
        {
          role: "user",
          content: "what is the status",
        },
      ],
    },
    {},
  );

  assert.equal(result, undefined);
});

test("mention hook prefers channel conversation target over originating user target", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  assert.ok(messageReceived);

  const handled = await messageReceived?.(
    {
      from: "slack:U_SENDER",
      content: "@hiveping status",
      metadata: {
        originatingTo: "slack:user:U_SENDER",
        to: "slack:user:U_SENDER",
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C_TEAM",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.target, "channel:C_TEAM");
});

test("mention hook does not set replyTo for Discord channel delivery", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  assert.ok(messageReceived);

  const handled = await messageReceived?.(
    {
      from: "discord:123",
      content: "@hiveping status",
      metadata: {
        to: "channel:123456789012345678",
        messageId: "mid-123",
      },
    },
    {
      channelId: "discord",
      conversationId: "channel:123456789012345678",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.replyTo, undefined);
});

test("mention hook sends Slack mention replies to channel conversation (no thread metadata)", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  assert.ok(messageReceived);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "<@U999> status",
      metadata: {
        to: "channel:C55",
        messageId: "1710179822.700000",
        threadTs: "1710179822.700000",
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C55",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.target, "channel:C55");
  assert.equal(deliveries[0]?.replyTo, undefined);
  assert.equal(deliveries[0]?.threadId, undefined);
});

test("message_sending allows hiveping delivery content and still suppresses model output", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "discord:123",
      content: "@hiveping status",
      metadata: {
        to: "channel:123456789012345678",
      },
    },
    {
      channelId: "discord",
      conversationId: "channel:123456789012345678",
    },
  );
  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);

  const allowedHivePingDelivery = await messageSending?.(
    {
      to: "channel:123456789012345678",
      content: deliveries[0]?.content,
    },
    { channelId: "discord", conversationId: "channel:123456789012345678" },
  );
  assert.equal(allowedHivePingDelivery, undefined);

  const suppressedModelReply = await messageSending?.(
    {
      to: "channel:123456789012345678",
      content: "generic model response",
    },
    { channelId: "discord", conversationId: "channel:123456789012345678" },
  );
  assert.equal(suppressedModelReply?.cancel, true);
});

test("message_sending suppresses model output via channel fallback when target format differs", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "discord:123",
      content: "@hiveping status",
      metadata: {
        to: "default:123456789012345678",
      },
    },
    {
      channelId: "discord",
      conversationId: "default:123456789012345678",
    },
  );
  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);

  const suppressedModelReply = await messageSending?.(
    {
      to: "channel:123456789012345678",
      content: "generic model response",
    },
    { channelId: "discord", conversationId: "channel:123456789012345678" },
  );
  assert.equal(suppressedModelReply?.cancel, true);
});

test("mention hook extracts @hiveping intent from metadata rawBody when content is stripped", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  assert.ok(messageReceived);

  const handled = await messageReceived?.(
    {
      from: "slack:U123",
      content: "status",
      metadata: {
        to: "channel:C55",
        rawBody: "@hiveping status",
      },
    },
    {
      channelId: "slack",
      conversationId: "channel:C55",
    },
  );

  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.target, "channel:C55");
});

test("message_sending suppresses model output via global fallback when context is missing", async () => {
  const { api, handlers, deliveries, sendReply } = createApiHarness();
  registerMentionHook(api, createDeps(), { sendReply });

  const messageReceived = handlers.get("message_received");
  const messageSending = handlers.get("message_sending");
  assert.ok(messageReceived);
  assert.ok(messageSending);

  const handled = await messageReceived?.(
    {
      from: "discord:123",
      content: "@hiveping status",
      metadata: {
        to: "channel:123456789012345678",
      },
    },
    {
      channelId: "discord",
      conversationId: "channel:123456789012345678",
    },
  );
  assert.equal(handled?.cancel, true);
  assert.equal(deliveries.length, 1);

  const allowedHivePingDelivery = await messageSending?.(
    {
      to: "unknown-target",
      content: deliveries[0]?.content,
    },
    {},
  );
  assert.equal(allowedHivePingDelivery, undefined);

  const suppressedModelReply = await messageSending?.(
    {
      to: "unknown-target",
      content: "generic model response",
    },
    {},
  );
  assert.equal(suppressedModelReply?.cancel, true);
});
