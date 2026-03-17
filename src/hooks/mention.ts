import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runGovern, type GovernDeps } from "../commands/govern.js";
import { allMentionAliases, resolveAgentProfiles } from "../core/agent-profiles.js";
import { DEFAULT_MENTION_ALIASES, PLUGIN_ID, PLUGIN_NAME } from "../core/branding.js";
import { callReasoningOnce } from "../core/codex-client.js";
import { resolveConversationKey } from "../providers/index.js";
import type { AgentProfile, ConversationKeyContext, PluginConfig } from "../types.js";

type MentionHookApi = {
  on?: (
    hookName: string,
    handler: (event: any, ctx: any) => Promise<any> | any,
    opts?: { priority?: number },
  ) => void;
  logger?: {
    warn?: (...args: any[]) => void;
    debug?: (...args: any[]) => void;
  };
};

type MessageEvent = {
  from?: unknown;
  content?: unknown;
  metadata?: unknown;
  to?: unknown;
};

type MessageContext = {
  channelId?: unknown;
  accountId?: unknown;
  conversationId?: unknown;
};

type MentionReplyDelivery = {
  channelId: string;
  target: string;
  content: string;
  accountId?: string;
  replyTo?: string;
  threadId?: string;
};

type MentionHookOptions = {
  sendReply?: (delivery: MentionReplyDelivery) => Promise<void>;
  consolidateReply?: (params: { prompt: string; results: AgentExecutionResult[] }) => Promise<string>;
};

type MentionInvocation = {
  args: string;
  agentProfiles?: AgentProfile[];
  restrictedAgents?: Array<{ agentProfile: AgentProfile; reason: string }>;
};

type LeadingMentionMatch = {
  args: string;
  matchedGeneric: boolean;
  matchedAgent?: AgentProfile;
};

type AgentExecutionResult = {
  agentProfile: AgentProfile;
  text: string;
  error?: string;
};

const execFileAsync = promisify(execFile);
const MODEL_SUPPRESSION_WINDOW_MS = 20_000;
const pendingModelSuppression = new Map<string, number>();
const pendingModelSuppressionByChannel = new Map<string, number>();
const pendingModelSuppressionFallback: number[] = [];
const pendingModelSuppressionBypass = new Map<string, Array<{ content: string; expiresAt: number }>>();
const pendingModelSuppressionBypassByChannel = new Map<
  string,
  Array<{ content: string; expiresAt: number }>
>();
const pendingModelSuppressionBypassFallback: Array<{ content: string; expiresAt: number }> = [];
const PROMPT_SUPPRESSION_WINDOW_MS = 20_000;
const pendingPromptSuppressionByConversation = new Map<string, number>();
const pendingPromptSuppressionFallback: number[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function mentionAliases(config: PluginConfig): string[] {
  const configured = allMentionAliases(config);
  if (configured.length > 0) {
    return configured;
  }
  return [...DEFAULT_MENTION_ALIASES];
}

function extractPlatformMention(content: string): { mentionId: string; args: string } | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  const match = trimmed.match(
    /^(?:<@!?([A-Za-z0-9._-]+)(?:\|[^>]+)?>)(?:\s*[:,\-]?\s*)(.*)$/,
  );
  if (!match) return undefined;

  return {
    mentionId: (match[1] || "").trim(),
    args: (match[2] || "").trim(),
  };
}

function extractAliasArgs(content: string, alias: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  const regex = new RegExp(
    `(?:^|\\s)${escapeRegExp(alias)}(?=$|\\s|[:,\\-])(?:\\s*[:,\\-]?\\s*)(.*)$`,
    "i",
  );
  const match = trimmed.match(regex);
  if (!match) {
    return undefined;
  }
  return (match[1] || "").trim();
}

function isLeadingOnlyAlias(alias: string): boolean {
  const trimmed = alias.trim();
  return trimmed.startsWith("(") && trimmed.endsWith(")");
}

function extractLeadingParenthesizedAgentArgs(
  content: string,
  agentId: string,
): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("(")) {
    return undefined;
  }

  const closeIndex = trimmed.indexOf(")");
  if (closeIndex <= 1) {
    return undefined;
  }

  const inside = trimmed.slice(1, closeIndex).trim().toLowerCase();
  if (inside !== agentId.trim().toLowerCase()) {
    return undefined;
  }

  const nextChar = trimmed.slice(closeIndex + 1, closeIndex + 2);
  if (nextChar && !/[\s,:-]/.test(nextChar)) {
    return undefined;
  }

  return trimmed.slice(closeIndex + 1).replace(/^\s*[:,\-]?\s*/, "").trim();
}

function extractStrippedAliasArgs(content: string, alias: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  const normalizedAlias = alias.trim().toLowerCase();
  const bareAlias = normalizedAlias.startsWith("@") ? normalizedAlias.slice(1) : normalizedAlias;
  if (!bareAlias) {
    return undefined;
  }

  const regex = new RegExp(`^${escapeRegExp(bareAlias)}(?=$|\\s|[:,\\-])(?:\\s*[:,\\-]?\\s*)(.*)$`, "i");
  const match = trimmed.match(regex);
  if (!match) {
    return undefined;
  }
  return (match[1] || "").trim();
}

function extractLeadingAliasArgs(content: string, alias: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  const regex = new RegExp(`^${escapeRegExp(alias)}(?=$|\\s|[:,\\-])(?:\\s*[:,\\-]?\\s*)(.*)$`, "i");
  const match = trimmed.match(regex);
  if (!match) {
    return undefined;
  }
  return (match[1] || "").trim();
}

function extractLeadingStrippedAliasArgs(content: string, alias: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  const normalizedAlias = alias.trim().toLowerCase();
  const bareAlias = normalizedAlias.startsWith("@") ? normalizedAlias.slice(1) : normalizedAlias;
  if (!bareAlias) {
    return undefined;
  }

  const regex = new RegExp(`^${escapeRegExp(bareAlias)}(?=$|\\s|[:,\\-])(?:\\s*[:,\\-]?\\s*)(.*)$`, "i");
  const match = trimmed.match(regex);
  if (!match) {
    return undefined;
  }
  return (match[1] || "").trim();
}

function matchLeadingMention(
  content: string,
  config: PluginConfig,
  allowStrippedAliasFallback: boolean,
): LeadingMentionMatch | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }

  const agentProfiles = resolveAgentProfiles(config);
  const leadingPlatformMention = extractPlatformMention(trimmed);
  if (leadingPlatformMention) {
    return {
      args: leadingPlatformMention.args,
      matchedGeneric: true,
      matchedAgent: agentProfiles.find((profile) =>
        (profile.mentionIds || []).includes(leadingPlatformMention.mentionId),
      ),
    };
  }

  for (const profile of agentProfiles) {
    const parenthesizedArgs = extractLeadingParenthesizedAgentArgs(trimmed, profile.id);
    if (parenthesizedArgs !== undefined) {
      return {
        args: parenthesizedArgs,
        matchedGeneric: true,
        matchedAgent: profile,
      };
    }

    for (const alias of profile.aliases || []) {
      const args = extractLeadingAliasArgs(trimmed, alias);
      if (args !== undefined) {
        return {
          args,
          matchedGeneric: true,
          matchedAgent: profile,
        };
      }
    }
  }

  for (const alias of mentionAliases(config)) {
    const args = extractLeadingAliasArgs(trimmed, alias);
    if (args !== undefined) {
      return {
        args,
        matchedGeneric: true,
      };
    }
  }

  if (!allowStrippedAliasFallback) {
    return undefined;
  }

  for (const profile of agentProfiles) {
    for (const alias of profile.aliases || []) {
      const args = extractLeadingStrippedAliasArgs(trimmed, alias);
      if (args !== undefined) {
        return {
          args,
          matchedGeneric: true,
          matchedAgent: profile,
        };
      }
    }
  }

  for (const alias of mentionAliases(config)) {
    const args = extractLeadingStrippedAliasArgs(trimmed, alias);
    if (args !== undefined) {
      return {
        args,
        matchedGeneric: true,
      };
    }
  }

  return undefined;
}

function dedupeAgentProfiles(agentProfiles: AgentProfile[]): AgentProfile[] {
  const seen = new Set<string>();
  const out: AgentProfile[] = [];
  for (const profile of agentProfiles) {
    if (seen.has(profile.id)) {
      continue;
    }
    seen.add(profile.id);
    out.push(profile);
  }
  return out;
}

function resolveLeadingMentionInvocation(
  content: string,
  config: PluginConfig,
  allowStrippedAliasFallback: boolean,
): MentionInvocation | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }

  const matchedAgents: AgentProfile[] = [];
  let current = trimmed;
  let matchedAny = false;

  while (true) {
    const match = matchLeadingMention(current, config, allowStrippedAliasFallback);
    if (!match) {
      break;
    }

    matchedAny = matchedAny || match.matchedGeneric;
    if (match.matchedAgent) {
      matchedAgents.push(match.matchedAgent);
    }
    current = match.args;
  }

  if (!matchedAny) {
    return undefined;
  }

  return {
    args: current.trim(),
    agentProfiles: dedupeAgentProfiles(matchedAgents),
  };
}

function resolveSingleMentionInvocation(
  content: string,
  config: PluginConfig,
  allowStrippedAliasFallback: boolean,
): MentionInvocation | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }

  const agentProfiles = resolveAgentProfiles(config);
  const leadingPlatformMention = extractPlatformMention(trimmed);
  if (leadingPlatformMention) {
    const matchedAgent =
      agentProfiles.find((profile) => (profile.mentionIds || []).includes(leadingPlatformMention.mentionId));
    if (matchedAgent) {
      return {
        args: leadingPlatformMention.args,
        agentProfiles: [matchedAgent],
      };
    }

    const nested = resolveSingleMentionInvocation(leadingPlatformMention.args, config, allowStrippedAliasFallback);
    if (nested) {
      return nested;
    }

    return {
      args: leadingPlatformMention.args,
    };
  }

  for (const profile of agentProfiles) {
    for (const alias of profile.aliases || []) {
      if (isLeadingOnlyAlias(alias)) {
        continue;
      }
      const args = extractAliasArgs(trimmed, alias);
      if (args !== undefined) {
        return {
          args,
          agentProfiles: [profile],
        };
      }
    }
  }

  for (const alias of mentionAliases(config)) {
    if (isLeadingOnlyAlias(alias)) {
      continue;
    }
    const args = extractAliasArgs(trimmed, alias);
    if (args !== undefined) {
      return {
        args,
      };
    }
  }

  if (!allowStrippedAliasFallback) {
    return undefined;
  }

  for (const profile of agentProfiles) {
    for (const alias of profile.aliases || []) {
      if (isLeadingOnlyAlias(alias)) {
        continue;
      }
      const args = extractStrippedAliasArgs(trimmed, alias);
      if (args !== undefined) {
        return {
          args,
          agentProfiles: [profile],
        };
      }
    }
  }

  for (const alias of mentionAliases(config)) {
    if (isLeadingOnlyAlias(alias)) {
      continue;
    }
    const args = extractStrippedAliasArgs(trimmed, alias);
    if (args !== undefined) {
      return {
        args,
      };
    }
  }

  return undefined;
}

function resolveMentionInvocation(
  content: string,
  config: PluginConfig,
  allowStrippedAliasFallback: boolean,
): MentionInvocation | undefined {
  return (
    resolveLeadingMentionInvocation(content, config, allowStrippedAliasFallback) ||
    resolveSingleMentionInvocation(content, config, allowStrippedAliasFallback)
  );
}

function hasExplicitMentionSignal(metadata: Record<string, unknown>): boolean {
  const mentions = metadata.mentions;
  const mentionIds = metadata.mentionIds;
  const mentionedUsers = metadata.mentionedUsers;
  const hasMentionCollection =
    (Array.isArray(mentions) && mentions.length > 0) ||
    (Array.isArray(mentionIds) && mentionIds.length > 0) ||
    (Array.isArray(mentionedUsers) && mentionedUsers.length > 0);

  return (
    metadata.wasMentioned === true ||
    metadata.isExplicitlyMentioned === true ||
    metadata.explicitMention === true ||
    metadata.mentioned === true ||
    metadata.botMentioned === true ||
    metadata.mention === true ||
    hasMentionCollection
  );
}

function textCandidatesFromEvent(event: MessageEvent): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    const normalized = asString(value);
    if (!normalized) {
      return;
    }
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    out.push(normalized);
  };

  push(event.content);
  const metadata = asRecord(event.metadata);
  push(metadata.rawBody);
  push(metadata.raw_text);
  push(metadata.rawMessage);
  push(metadata.bodyForAgent);
  push(metadata.bodyForCommands);
  push(metadata.commandBody);
  push(metadata.body);
  push(metadata.text);
  push(metadata.content);
  push(metadata.originalText);
  return out;
}

function threadIdFromMetadata(metadata: Record<string, unknown>): string | number | undefined {
  if (typeof metadata.threadId === "string" || typeof metadata.threadId === "number") {
    return metadata.threadId;
  }

  if (typeof metadata.threadTs === "string") {
    return metadata.threadTs;
  }

  if (typeof metadata.thread_id === "string" || typeof metadata.thread_id === "number") {
    return metadata.thread_id;
  }

  return undefined;
}

function userDisplayNameFromMetadata(metadata: Record<string, unknown>): string | undefined {
  return (
    asString(metadata.displayName) ||
    asString(metadata.senderDisplayName) ||
    asString(metadata.senderName) ||
    asString(metadata.userName) ||
    asString(metadata.username)
  );
}

function userUsernameFromMetadata(metadata: Record<string, unknown>): string | undefined {
  return (
    asString(metadata.senderUsername) ||
    asString(metadata.username) ||
    asString(metadata.userName) ||
    asString(metadata.handle)
  );
}

function userEmailFromMetadata(metadata: Record<string, unknown>): string | undefined {
  return asString(metadata.email) || asString(metadata.senderEmail) || asString(metadata.userEmail);
}

function senderIdFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const userRecord = asRecord(metadata.user);
  return (
    asString(metadata.senderId) ||
    asString(metadata.userId) ||
    asString(metadata.user_id) ||
    asString(userRecord.id) ||
    asString(metadata.authorId) ||
    asString(metadata.memberId)
  );
}

function contextFromMessageEvent(event: MessageEvent, ctx: MessageContext): ConversationKeyContext {
  const metadata = asRecord(event.metadata);
  const provider = asString(ctx.channelId);
  const senderId = senderIdFromMetadata(metadata) || asString(event.from);
  const conversationId =
    asString(ctx.conversationId) || asString(metadata.originatingTo) || asString(metadata.to);
  const providerPrefix = provider ? `${provider.toLowerCase()}:` : "";
  const toValue =
    conversationId && provider && !conversationId.toLowerCase().startsWith(providerPrefix)
      ? `${provider}:${conversationId}`
      : conversationId;

  return {
    channel: provider,
    channelId: provider,
    from: senderId,
    to: toValue,
    accountId: asString(ctx.accountId),
    messageThreadId: threadIdFromMetadata(metadata),
    conversationId,
    userDisplayName: userDisplayNameFromMetadata(metadata),
    userUsername: userUsernameFromMetadata(metadata),
    userEmail: userEmailFromMetadata(metadata),
  };
}

function normalizeChannelMatcher(value: string): string {
  return value.trim().toLowerCase();
}

function channelMatchersFromEvent(
  event: MessageEvent,
  ctx: MessageContext,
  conversationContext: ConversationKeyContext,
): Set<string> {
  const metadata = asRecord(event.metadata);
  const values = new Set<string>();
  const add = (value: unknown) => {
    const normalized = asString(value);
    if (!normalized) {
      return;
    }
    values.add(normalizeChannelMatcher(normalized));
  };

  const { key: conversationKey } = resolveConversationKey(conversationContext);
  add(conversationKey);

  add(ctx.conversationId);
  add(metadata.conversationId);
  add(metadata.channelId);
  add(metadata.channel);
  add(metadata.channelName);
  add(metadata.channel_name);
  add(metadata.conversationName);
  add(metadata.conversation_name);
  add(metadata.roomName);
  add(metadata.room);
  add(metadata.teamChannelName);
  add(metadata.teamChannel);
  add(metadata.to);
  add(metadata.originatingTo);

  return values;
}

function formatAllowedChannels(agentProfile: AgentProfile): string {
  const allowedChannels = (agentProfile.allowedChannels || []).filter((value) => value.trim().length > 0);
  return allowedChannels.length > 0 ? allowedChannels.join(", ") : "(none configured)";
}

function applyAgentChannelRestrictions(
  invocation: MentionInvocation | undefined,
  event: MessageEvent,
  ctx: MessageContext,
  conversationContext: ConversationKeyContext,
): MentionInvocation | undefined {
  if (!invocation?.agentProfiles || invocation.agentProfiles.length === 0) {
    return invocation;
  }

  const channelMatchers = channelMatchersFromEvent(event, ctx, conversationContext);
  const allowed: AgentProfile[] = [];
  const restricted: Array<{ agentProfile: AgentProfile; reason: string }> = [];

  for (const agentProfile of invocation.agentProfiles) {
    const configuredChannels = (agentProfile.allowedChannels || [])
      .map((value) => normalizeChannelMatcher(value))
      .filter((value) => value.length > 0);

    if (configuredChannels.length === 0) {
      allowed.push(agentProfile);
      continue;
    }

    const isAllowed = configuredChannels.some((value) => channelMatchers.has(value));
    if (isAllowed) {
      allowed.push(agentProfile);
      continue;
    }

    restricted.push({
      agentProfile,
      reason: `Agent ${agentProfile.id} is not allowed in this channel. Allowed channels: ${formatAllowedChannels(agentProfile)}`,
    });
  }

  return {
    ...invocation,
    agentProfiles: allowed,
    ...(restricted.length > 0 ? { restrictedAgents: restricted } : {}),
  };
}

function isLikelyBotMessage(event: MessageEvent): boolean {
  const metadata = asRecord(event.metadata);
  return (
    metadata.isBot === true ||
    metadata.fromBot === true ||
    metadata.fromSelf === true ||
    metadata.senderType === "bot"
  );
}

function resolveReplyTarget(event: MessageEvent, ctx: MessageContext): string | undefined {
  const metadata = asRecord(event.metadata);
  return (
    asString(ctx.conversationId) ||
    asString(metadata.conversationId) ||
    asString(metadata.channelId) ||
    asString(metadata.channel) ||
    asString(metadata.to) ||
    asString(metadata.originatingTo) ||
    asString(metadata.senderId) ||
    asString(event.from)
  );
}

function normalizeDiscordTarget(rawTarget: string): string {
  let target = rawTarget.trim();
  if (target.toLowerCase().startsWith("discord:")) {
    target = target.slice("discord:".length).trim();
  }

  const channelMatch = target.match(/(?:^|:)channel:(\d{8,})/i);
  if (channelMatch?.[1]) {
    return `channel:${channelMatch[1]}`;
  }

  const userMatch = target.match(/(?:^|:)user:(\d{8,})/i);
  if (userMatch?.[1]) {
    return `user:${userMatch[1]}`;
  }

  if (/^\d+$/.test(target)) {
    return `channel:${target}`;
  }

  const accountScopedChannel = target.match(/^[a-z0-9._-]+:channel:(\d{8,})$/i);
  if (accountScopedChannel?.[1]) {
    return `channel:${accountScopedChannel[1]}`;
  }

  const accountScopedUser = target.match(/^[a-z0-9._-]+:user:(\d{8,})$/i);
  if (accountScopedUser?.[1]) {
    return `user:${accountScopedUser[1]}`;
  }

  const accountScopedId = target.match(/^[a-z0-9._-]+:(\d{8,})$/i);
  if (accountScopedId?.[1]) {
    return `channel:${accountScopedId[1]}`;
  }

  return target;
}

function normalizeSlackTarget(rawTarget: string): string {
  let target = rawTarget.trim();
  if (target.toLowerCase().startsWith("slack:")) {
    target = target.slice("slack:".length).trim();
  }
  return target;
}

function normalizeConversationForKey(channelId: string, raw: string): string {
  if (channelId === "discord") {
    return normalizeDiscordTarget(raw);
  }
  if (channelId === "slack") {
    return normalizeSlackTarget(raw);
  }
  return raw.trim();
}

function buildRoutingKey(channelId: string, rawTarget: string): string {
  return `${channelId}|${normalizeConversationForKey(channelId, rawTarget)}`;
}

function normalizeOutgoingContent(content: unknown): string {
  if (typeof content !== "string") {
    return "";
  }
  return content.trim().replace(/\s+/g, " ");
}

function buildRoutingKeyFromContext(
  event: { to?: unknown },
  ctx: MessageContext,
): string | undefined {
  const channelId = asString(ctx.channelId)?.toLowerCase();
  if (!channelId) return undefined;

  const rawTarget = asString(event.to) || asString(ctx.conversationId);
  if (!rawTarget) return undefined;
  return buildRoutingKey(channelId, rawTarget);
}

function cleanupPendingSuppression(now = Date.now()): void {
  for (const [key, expiresAt] of pendingModelSuppression) {
    if (expiresAt <= now) {
      pendingModelSuppression.delete(key);
    }
  }
  for (const [channelId, expiresAt] of pendingModelSuppressionByChannel) {
    if (expiresAt <= now) {
      pendingModelSuppressionByChannel.delete(channelId);
    }
  }
  while (pendingModelSuppressionFallback.length > 0) {
    const expiresAt = pendingModelSuppressionFallback[0];
    if (typeof expiresAt !== "number" || expiresAt > now) {
      break;
    }
    pendingModelSuppressionFallback.shift();
  }

  for (const [key, entries] of pendingModelSuppressionBypass) {
    const kept = entries.filter((entry) => entry.expiresAt > now);
    if (kept.length === 0) {
      pendingModelSuppressionBypass.delete(key);
      continue;
    }
    pendingModelSuppressionBypass.set(key, kept);
  }

  for (const [channelId, entries] of pendingModelSuppressionBypassByChannel) {
    const kept = entries.filter((entry) => entry.expiresAt > now);
    if (kept.length === 0) {
      pendingModelSuppressionBypassByChannel.delete(channelId);
      continue;
    }
    pendingModelSuppressionBypassByChannel.set(channelId, kept);
  }

  while (pendingModelSuppressionBypassFallback.length > 0) {
    const first = pendingModelSuppressionBypassFallback[0];
    if (!first || first.expiresAt > now) {
      break;
    }
    pendingModelSuppressionBypassFallback.shift();
  }
}

function markPendingSuppression(channelId: string, target: string): void {
  cleanupPendingSuppression();
  pendingModelSuppression.set(
    buildRoutingKey(channelId, target),
    Date.now() + MODEL_SUPPRESSION_WINDOW_MS,
  );
  pendingModelSuppressionByChannel.set(channelId, Date.now() + MODEL_SUPPRESSION_WINDOW_MS);
}

function markPendingSuppressionFallback(): void {
  cleanupPendingSuppression();
  pendingModelSuppressionFallback.push(Date.now() + MODEL_SUPPRESSION_WINDOW_MS);
}

function consumePendingSuppression(key: string): boolean {
  cleanupPendingSuppression();
  const expiresAt = pendingModelSuppression.get(key);
  if (!expiresAt) return false;
  pendingModelSuppression.delete(key);
  return true;
}

function markPendingSuppressionForTargets(channelId: string, targets: Array<unknown>): void {
  const seen = new Set<string>();
  for (const rawTarget of targets) {
    const target = asString(rawTarget);
    if (!target) continue;
    const key = buildRoutingKey(channelId, target);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    markPendingSuppression(channelId, target);
  }
}

function markPendingSuppressionBypass(channelId: string, target: string, content: string): void {
  const normalizedContent = normalizeOutgoingContent(content);
  if (!normalizedContent) {
    return;
  }
  cleanupPendingSuppression();
  const key = buildRoutingKey(channelId, target);
  const entries = pendingModelSuppressionBypass.get(key) || [];
  entries.push({
    content: normalizedContent,
    expiresAt: Date.now() + MODEL_SUPPRESSION_WINDOW_MS,
  });
  pendingModelSuppressionBypass.set(key, entries);
  const channelEntries = pendingModelSuppressionBypassByChannel.get(channelId) || [];
  channelEntries.push({
    content: normalizedContent,
    expiresAt: Date.now() + MODEL_SUPPRESSION_WINDOW_MS,
  });
  pendingModelSuppressionBypassByChannel.set(channelId, channelEntries);
  pendingModelSuppressionBypassFallback.push({
    content: normalizedContent,
    expiresAt: Date.now() + MODEL_SUPPRESSION_WINDOW_MS,
  });
}

function consumePendingSuppressionBypass(key: string, content: unknown): boolean {
  cleanupPendingSuppression();
  const entries = pendingModelSuppressionBypass.get(key);
  if (!entries || entries.length === 0) {
    return false;
  }

  const normalizedContent = normalizeOutgoingContent(content);
  if (!normalizedContent) {
    return false;
  }

  const index = entries.findIndex((entry) => entry.content === normalizedContent);
  if (index < 0) {
    return false;
  }

  entries.splice(index, 1);
  if (entries.length === 0) {
    pendingModelSuppressionBypass.delete(key);
  } else {
    pendingModelSuppressionBypass.set(key, entries);
  }
  return true;
}

function consumePendingSuppressionBypassForChannel(channelId: string, content: unknown): boolean {
  cleanupPendingSuppression();
  const entries = pendingModelSuppressionBypassByChannel.get(channelId);
  if (!entries || entries.length === 0) {
    return false;
  }

  const normalizedContent = normalizeOutgoingContent(content);
  if (!normalizedContent) {
    return false;
  }

  const index = entries.findIndex((entry) => entry.content === normalizedContent);
  if (index < 0) {
    return false;
  }
  entries.splice(index, 1);
  if (entries.length === 0) {
    pendingModelSuppressionBypassByChannel.delete(channelId);
  } else {
    pendingModelSuppressionBypassByChannel.set(channelId, entries);
  }
  return true;
}

function consumePendingSuppressionBypassFallback(content: unknown): boolean {
  cleanupPendingSuppression();
  const normalizedContent = normalizeOutgoingContent(content);
  if (!normalizedContent) {
    return false;
  }
  const index = pendingModelSuppressionBypassFallback.findIndex(
    (entry) => entry.content === normalizedContent,
  );
  if (index < 0) {
    return false;
  }
  pendingModelSuppressionBypassFallback.splice(index, 1);
  return true;
}

function consumePendingSuppressionForChannel(channelId: string): boolean {
  cleanupPendingSuppression();
  const expiresAt = pendingModelSuppressionByChannel.get(channelId);
  if (!expiresAt) {
    return false;
  }
  pendingModelSuppressionByChannel.delete(channelId);
  return true;
}

function consumePendingSuppressionFallback(): boolean {
  cleanupPendingSuppression();
  if (pendingModelSuppressionFallback.length === 0) {
    return false;
  }
  pendingModelSuppressionFallback.shift();
  return true;
}

function clearPendingSuppressionForChannel(channelId: string): void {
  pendingModelSuppressionByChannel.delete(channelId);
}

function cleanupPendingPromptSuppression(now = Date.now()): void {
  for (const [key, expiresAt] of pendingPromptSuppressionByConversation) {
    if (expiresAt <= now) {
      pendingPromptSuppressionByConversation.delete(key);
    }
  }

  while (pendingPromptSuppressionFallback.length > 0) {
    const expiresAt = pendingPromptSuppressionFallback[0];
    if (typeof expiresAt !== "number" || expiresAt > now) {
      break;
    }
    pendingPromptSuppressionFallback.shift();
  }
}

function markPendingPromptSuppression(conversationKey: string): void {
  cleanupPendingPromptSuppression();
  pendingPromptSuppressionByConversation.set(
    conversationKey,
    Date.now() + PROMPT_SUPPRESSION_WINDOW_MS,
  );
}

function markPendingPromptSuppressionFallback(): void {
  cleanupPendingPromptSuppression();
  pendingPromptSuppressionFallback.push(Date.now() + PROMPT_SUPPRESSION_WINDOW_MS);
}

function consumePendingPromptSuppressionByConversation(conversationKey: string): boolean {
  cleanupPendingPromptSuppression();
  const expiresAt = pendingPromptSuppressionByConversation.get(conversationKey);
  if (!expiresAt) {
    return false;
  }
  pendingPromptSuppressionByConversation.delete(conversationKey);
  return true;
}

function consumePendingPromptSuppressionFallback(): boolean {
  cleanupPendingPromptSuppression();
  if (pendingPromptSuppressionFallback.length === 0) {
    return false;
  }
  pendingPromptSuppressionFallback.shift();
  return true;
}

function textContainsMentionTrigger(text: string, aliases: string[]): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (/^<@!?[A-Za-z0-9._-]+(?:\|[^>]+)?>/i.test(trimmed)) {
    return true;
  }

  const normalized = ` ${trimmed.toLowerCase()} `;
  for (const alias of aliases) {
    const cleaned = alias.trim().toLowerCase();
    if (!cleaned) continue;
    if (normalized.includes(` ${cleaned} `) || normalized.includes(` ${cleaned}:`) || normalized.includes(` ${cleaned},`)) {
      return true;
    }
  }

  return false;
}

function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((item) => extractTextFromMessageContent(item))
      .filter((item) => item.length > 0)
      .join(" ");
  }

  const record = asRecord(content);
  return (
    asString(record.text) ||
    asString(record.value) ||
    asString(record.content) ||
    asString(record.body) ||
    ""
  );
}

function latestUserLikeTextFromPromptEvent(event: unknown): string | undefined {
  const eventRecord = asRecord(event);
  const rawMessages = eventRecord.messages;
  if (!Array.isArray(rawMessages)) {
    return asString(eventRecord.prompt);
  }

  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = rawMessages[index];
    const textCandidate =
      typeof message === "string"
        ? message
        : extractTextFromMessageContent(asRecord(message).content) ||
          asString(asRecord(message).text) ||
          asString(asRecord(message).body) ||
          asString(asRecord(message).prompt) ||
          "";
    if (!textCandidate || textCandidate.trim().length === 0) {
      continue;
    }

    const role = asString(asRecord(message).role)?.toLowerCase();
    if (!role || role === "user") {
      return textCandidate.trim();
    }

    // If role is unknown but this is the most recent text message, still use it as fallback.
    if (index === rawMessages.length - 1) {
      return textCandidate.trim();
    }
  }

  return asString(eventRecord.prompt);
}

function conversationKeyCandidatesFromPromptHook(event: unknown, ctx: unknown): string[] {
  const out = new Set<string>();
  const push = (value: unknown) => {
    const normalized = asString(value);
    if (!normalized) return;
    out.add(normalized);
  };

  const eventRecord = asRecord(event);
  const ctxRecord = asRecord(ctx);
  push(eventRecord.sessionKey);
  push(ctxRecord.sessionKey);
  push(asRecord(eventRecord.session).key);
  push(asRecord(ctxRecord.session).key);
  push(asRecord(eventRecord.run).sessionKey);
  push(asRecord(ctxRecord.run).sessionKey);
  push(eventRecord.conversationKey);
  push(ctxRecord.conversationKey);

  const providerContext: ConversationKeyContext = {
    channelId: asString(eventRecord.channelId) || asString(ctxRecord.channelId),
    from: asString(eventRecord.from) || asString(ctxRecord.from),
    to: asString(eventRecord.to) || asString(ctxRecord.to),
    conversationId: asString(eventRecord.conversationId) || asString(ctxRecord.conversationId),
    accountId: asString(eventRecord.accountId) || asString(ctxRecord.accountId),
    messageThreadId:
      (typeof eventRecord.messageThreadId === "string" || typeof eventRecord.messageThreadId === "number"
        ? eventRecord.messageThreadId
        : undefined) ||
      (typeof ctxRecord.messageThreadId === "string" || typeof ctxRecord.messageThreadId === "number"
        ? ctxRecord.messageThreadId
        : undefined),
  };
  const resolved = resolveConversationKey(providerContext);
  push(resolved.key);

  return Array.from(out);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resolveReplyDelivery(event: MessageEvent, ctx: MessageContext): MentionReplyDelivery | undefined {
  const channelId = asString(ctx.channelId)?.toLowerCase();
  if (!channelId) {
    return undefined;
  }

  const rawTarget = resolveReplyTarget(event, ctx);
  if (!rawTarget) {
    return undefined;
  }

  const target = normalizeConversationForKey(channelId, rawTarget);
  if (!target) return undefined;

  return {
    channelId,
    target,
    content: "",
    accountId: asString(ctx.accountId),
  };
}

function formatConsolidatedAgentReply(args: string, results: AgentExecutionResult[]): string {
  const promptLabel = args.trim() || "(no prompt)";
  const lines = [
    `Consolidated multi-agent response`,
    `Prompt: ${promptLabel}`,
  ];

  for (const result of results) {
    lines.push("");
    lines.push(`== ${result.agentProfile.id} ==`);
    lines.push(result.error ? `Error: ${result.error}` : result.text.trim() || "(no reply)");
  }

  return lines.join("\n");
}

function commonDirectory(paths: string[]): string {
  if (paths.length === 0) {
    return process.cwd();
  }

  let shared = path.resolve(paths[0] || process.cwd());
  for (const rawPath of paths.slice(1)) {
    const candidate = path.resolve(rawPath);
    while (!candidate.startsWith(shared + path.sep) && candidate !== shared && shared !== path.dirname(shared)) {
      shared = path.dirname(shared);
    }
    if (candidate === shared || candidate.startsWith(shared + path.sep)) {
      continue;
    }
    shared = path.dirname(shared);
  }

  return shared;
}

function buildConsolidationPrompt(prompt: string, results: AgentExecutionResult[]): string {
  const sections = results.map((result) => {
    const label = result.agentProfile.id;
    const body = result.error
      ? `Status: error\nDetails: ${result.error}`
      : `Status: ok\nDetails:\n${result.text.trim() || "(no reply)"}`;
    return `Agent: ${label}\n${body}`;
  });

  return [
    "You are consolidating completed HivePing multi-agent results.",
    "Do not inspect repositories or run new work. Use only the findings below.",
    "Write one final answer for the user, not a transcript.",
    "Start with the direct conclusion, then summarize key evidence from each agent, and call out any conflicts or next checks if needed.",
    "",
    `Original user request: ${prompt.trim() || "(no prompt)"}`,
    "",
    "Agent findings:",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

async function synthesizeConsolidatedAgentReply(
  prompt: string,
  results: AgentExecutionResult[],
  deps: GovernDeps,
  options: MentionHookOptions,
): Promise<string> {
  if (typeof options.consolidateReply === "function") {
    return (await options.consolidateReply({ prompt, results })).trim();
  }

  const repoPaths = results.map((result) => result.agentProfile.repoPath).filter((value) => value.trim().length > 0);
  const cwd = commonDirectory(repoPaths);
  const synthesisConfig: PluginConfig = {
    ...deps.config,
    defaultSandbox: "read-only",
    defaultApprovalPolicy: "never",
  };
  const response = await callReasoningOnce(
    synthesisConfig,
    cwd,
    buildConsolidationPrompt(prompt, results),
  );
  return response.text.trim();
}

async function runMentionInvocation(
  invocation: MentionInvocation | undefined,
  args: string,
  conversationContext: ConversationKeyContext,
  deps: GovernDeps,
  options: MentionHookOptions,
): Promise<string> {
  const agentProfiles = invocation?.agentProfiles || [];
  const restrictedAgents = invocation?.restrictedAgents || [];
  const restrictedResults: AgentExecutionResult[] = restrictedAgents.map(({ agentProfile, reason }) => ({
    agentProfile,
    text: "",
    error: reason,
  }));

  if (agentProfiles.length === 0 && restrictedResults.length > 0) {
    if (restrictedResults.length === 1) {
      return `Error: ${restrictedResults[0]?.error || "Agent is not allowed in this channel."}`;
    }
    try {
      return await synthesizeConsolidatedAgentReply(args, restrictedResults, deps, options);
    } catch {
      return formatConsolidatedAgentReply(args, restrictedResults).trim();
    }
  }

  if (agentProfiles.length <= 1) {
    const agentProfile = agentProfiles[0];
    const text = (
      await runGovern(args, conversationContext, deps, {
        ...(agentProfile
          ? {
              agentProfile,
              fixedBinding: {
                repoPath: agentProfile.repoPath,
                provider: asString(conversationContext.channel)?.toLowerCase() || "unknown",
                metadata: {
                  agentId: agentProfile.id,
                },
                updatedAt: new Date().toISOString(),
              },
              historyConversationKey: agentProfile.homeConversationKey,
            }
          : {}),
      })
    ).text.trim();
    if (restrictedResults.length === 0) {
      return text;
    }
    const combinedResults = [
      ...(agentProfile ? [{ agentProfile, text }] : []),
      ...restrictedResults,
    ];
    try {
      return await synthesizeConsolidatedAgentReply(args, combinedResults, deps, options);
    } catch {
      return formatConsolidatedAgentReply(args, combinedResults).trim();
    }
  }

  const results: AgentExecutionResult[] = [];
  for (const agentProfile of agentProfiles) {
    try {
      const text = (
        await runGovern(args, conversationContext, deps, {
          agentProfile,
          fixedBinding: {
            repoPath: agentProfile.repoPath,
            provider: asString(conversationContext.channel)?.toLowerCase() || "unknown",
            metadata: {
              agentId: agentProfile.id,
            },
            updatedAt: new Date().toISOString(),
          },
          historyConversationKey: agentProfile.homeConversationKey,
        })
      ).text.trim();
      results.push({
        agentProfile,
        text,
      });
    } catch (error) {
      results.push({
        agentProfile,
        text: "",
        error: formatError(error),
      });
    }
  }

  const combinedResults = [...results, ...restrictedResults];
  try {
    return await synthesizeConsolidatedAgentReply(args, combinedResults, deps, options);
  } catch {
    return formatConsolidatedAgentReply(args, combinedResults).trim();
  }
}

function shouldSuppressDefaultTurn(event: unknown, ctx: unknown, aliases: string[]): boolean {
  const conversationKeys = conversationKeyCandidatesFromPromptHook(event, ctx);
  const suppressByConversation = conversationKeys.some((key) =>
    consumePendingPromptSuppressionByConversation(key),
  );
  const latestUserText = latestUserLikeTextFromPromptEvent(event);
  const suppressByContent = latestUserText ? textContainsMentionTrigger(latestUserText, aliases) : false;
  const suppressByFallback = suppressByConversation || suppressByContent
    ? false
    : consumePendingPromptSuppressionFallback();
  return suppressByConversation || suppressByContent || suppressByFallback;
}

function noReplyPromptMutation() {
  return {
    prependSystemContext:
      `This inbound turn was already handled by the ${PLUGIN_NAME} mention bridge. Reply with exactly NO_REPLY.`,
    prependContext: "Output exactly NO_REPLY.",
    systemPrompt: "Output exactly NO_REPLY.",
  };
}

function isCommandNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown };
  return record.code === "ENOENT";
}

function commandCandidates(config: PluginConfig): string[] {
  const configured = asString(config.openclawCommand);
  if (configured) {
    if (configured.toLowerCase() === "openclaw") {
      return [configured, "openclaw-cli"];
    }
    return [configured];
  }
  return ["openclaw", "openclaw-cli"];
}

async function sendReplyViaOpenClawCli(
  delivery: MentionReplyDelivery,
  config: PluginConfig,
): Promise<void> {
  const text = delivery.content.trim();
  if (text.length === 0) {
    return;
  }

  const args = [
    "message",
    "send",
    "--channel",
    delivery.channelId,
    "--target",
    delivery.target,
    "--message",
    text,
  ];
  if (delivery.accountId) {
    args.push("--account", delivery.accountId);
  }
  if (delivery.replyTo) {
    args.push("--reply-to", delivery.replyTo);
  }
  if (delivery.threadId) {
    args.push("--thread-id", delivery.threadId);
  }

  const candidates = commandCandidates(config);
  const run = async (command: string) =>
    await execFileAsync(command, args, {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });

  for (let index = 0; index < candidates.length; index += 1) {
    const command = candidates[index];
    if (!command) continue;
    try {
      await run(command);
      return;
    } catch (error) {
      const isLast = index === candidates.length - 1;
      if (!isCommandNotFoundError(error) || isLast) {
        throw error;
      }
    }
  }
}

export function registerMentionHook(
  api: MentionHookApi,
  deps: GovernDeps,
  options: MentionHookOptions = {},
): void {
  if (deps.config.mentionHookEnabled === false) {
    return;
  }

  if (typeof api.on !== "function") {
    api.logger?.warn?.(`${PLUGIN_ID}: typed plugin hooks are unavailable in this runtime`);
    return;
  }

  const aliases = mentionAliases(deps.config);
  const sendReply = options.sendReply || ((delivery: MentionReplyDelivery) => sendReplyViaOpenClawCli(delivery, deps.config));

  api.on("message_received", async (event: MessageEvent, ctx: MessageContext) => {
    if (isLikelyBotMessage(event)) {
      return;
    }

    const contentCandidates = textCandidatesFromEvent(event);
    const metadata = asRecord(event.metadata);
    const provider = asString(ctx.channelId)?.toLowerCase();
    const invocation =
      contentCandidates
        .map((candidate) =>
          resolveMentionInvocation(
            candidate,
            deps.config,
            provider === "slack" || provider === "msteams" || provider === "teams",
          ),
        )
        .find((candidate) => candidate !== undefined) ?? undefined;
    const fallbackContentCandidate = contentCandidates.find((candidate) => candidate.trim().length > 0);
    const metadataMentionArgs =
      invocation === undefined &&
      hasExplicitMentionSignal(metadata) &&
      fallbackContentCandidate !== undefined
        ? fallbackContentCandidate.trim()
        : undefined;
    const conversationContext = contextFromMessageEvent(event, ctx);
    const effectiveInvocation = applyAgentChannelRestrictions(invocation, event, ctx, conversationContext);
    const args = effectiveInvocation?.args ?? metadataMentionArgs;
    if (args === undefined) {
      return;
    }

    const { key: conversationKey } = resolveConversationKey(conversationContext);
    markPendingPromptSuppression(conversationKey);
    markPendingPromptSuppressionFallback();

    const deliveryBase = resolveReplyDelivery(event, ctx);
    if (!deliveryBase) {
      api.logger?.warn?.(`${PLUGIN_ID}: unable to resolve reply target for mention`);
      return { cancel: true };
    }
    markPendingSuppressionForTargets(deliveryBase.channelId, [
      deliveryBase.target,
      ctx.conversationId,
      metadata.conversationId,
      metadata.channelId,
      metadata.channel,
      metadata.to,
      metadata.originatingTo,
    ]);
    markPendingSuppressionFallback();

    try {
      const replyText = await runMentionInvocation(effectiveInvocation, args, conversationContext, deps, options);
      if (replyText.length === 0) {
        return { cancel: true };
      }

      markPendingSuppressionBypass(deliveryBase.channelId, deliveryBase.target, replyText);
      await sendReply({
        ...deliveryBase,
        content: replyText,
      });
      api.logger?.debug?.(`${PLUGIN_ID}: sent mention reply via direct outbound delivery`);
    } catch (error) {
      api.logger?.warn?.(`${PLUGIN_ID}: failed to send mention reply (${formatError(error)})`);
    }

    // We fully handle mention commands here; prevent default model response duplication.
    return { cancel: true };
  });

  api.on("before_prompt_build", async (event: unknown, ctx: unknown) => {
    if (!shouldSuppressDefaultTurn(event, ctx, aliases)) {
      return;
    }

    api.logger?.debug?.(`${PLUGIN_ID}: suppressing default model turn for handled mention`);
    return noReplyPromptMutation();
  });

  api.on("before_agent_start", async (event: unknown, ctx: unknown) => {
    if (!shouldSuppressDefaultTurn(event, ctx, aliases)) {
      return;
    }

    api.logger?.debug?.(`${PLUGIN_ID}: suppressing default model turn in legacy hook path`);
    return noReplyPromptMutation();
  });

  // message_received is a void hook in OpenClaw core, so duplicate prevention is enforced here.
  api.on(
    "message_sending",
    async (event: { to?: unknown; content?: unknown }, ctx: MessageContext) => {
      const channelId = asString(ctx.channelId)?.toLowerCase();
      const key = buildRoutingKeyFromContext(event, ctx);

      if (key && consumePendingSuppressionBypass(key, event.content)) {
        api.logger?.debug?.(`${PLUGIN_ID}: allowed mention bridge outbound message`);
        return;
      }
      if (channelId && consumePendingSuppressionBypassForChannel(channelId, event.content)) {
        api.logger?.debug?.(`${PLUGIN_ID}: allowed mention bridge outbound message (channel fallback)`);
        return;
      }
      if (consumePendingSuppressionBypassFallback(event.content)) {
        api.logger?.debug?.(`${PLUGIN_ID}: allowed mention bridge outbound message (global fallback)`);
        return;
      }

      if (key && consumePendingSuppression(key)) {
        if (channelId) {
          clearPendingSuppressionForChannel(channelId);
        }
        consumePendingSuppressionFallback();
        api.logger?.debug?.(`${PLUGIN_ID}: suppressed default model response after mention handling`);
        return { cancel: true };
      }
      if (channelId && consumePendingSuppressionForChannel(channelId)) {
        consumePendingSuppressionFallback();
        api.logger?.debug?.(`${PLUGIN_ID}: suppressed default model response via channel fallback`);
        return { cancel: true };
      }
      if (consumePendingSuppressionFallback()) {
        api.logger?.debug?.(`${PLUGIN_ID}: suppressed default model response via global fallback`);
        return { cancel: true };
      }
      return;
    },
    { priority: -1000 },
  );
}

export function resetMentionHookStateForTests(): void {
  pendingModelSuppression.clear();
  pendingModelSuppressionByChannel.clear();
  pendingModelSuppressionFallback.length = 0;
  pendingModelSuppressionBypass.clear();
  pendingModelSuppressionBypassByChannel.clear();
  pendingModelSuppressionBypassFallback.length = 0;
  pendingPromptSuppressionByConversation.clear();
  pendingPromptSuppressionFallback.length = 0;
}
