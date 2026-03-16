import path from "node:path";
import { DEFAULT_MENTION_ALIASES } from "./branding.js";
import type { AgentProfile, PluginConfig } from "../types.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item));
}

function deriveDefaultAgentAliases(id: string): string[] {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return [];
  }

  return [normalizedId, `(${normalizedId})`];
}

function normalizeAgentProfile(value: unknown): AgentProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = asString(record.id);
  const repoPath = asString(record.repoPath);
  const homeConversationKey = asString(record.homeConversationKey);
  if (!id || !repoPath || !homeConversationKey) {
    return undefined;
  }

  const configuredAliases = asStringArray(record.aliases).map((item) => item.trim());
  const derivedAliases = deriveDefaultAgentAliases(id);
  const aliases = Array.from(new Set([...configuredAliases, ...derivedAliases]));
  const mentionIds = Array.from(
    new Set(asStringArray(record.mentionIds).map((item) => item.trim())),
  );
  const allowedChannels = Array.from(
    new Set(asStringArray(record.allowedChannels).map((item) => item.trim())),
  );

  return {
    id,
    repoPath: path.resolve(repoPath),
    homeConversationKey,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(mentionIds.length > 0 ? { mentionIds } : {}),
    ...(allowedChannels.length > 0 ? { allowedChannels } : {}),
  };
}

function sortAliasesLongestFirst(values: string[]): string[] {
  return [...values].sort((left, right) => {
    if (right.length !== left.length) {
      return right.length - left.length;
    }
    return left.localeCompare(right);
  });
}

export function resolveAgentProfiles(config: PluginConfig): AgentProfile[] {
  if (!Array.isArray(config.agents)) {
    return [];
  }

  return config.agents
    .map((item) => normalizeAgentProfile(item))
    .filter((item): item is AgentProfile => Boolean(item));
}

export function findAgentProfileById(
  config: PluginConfig,
  agentId: string | undefined,
): AgentProfile | undefined {
  const normalizedId = asString(agentId);
  if (!normalizedId) {
    return undefined;
  }

  return resolveAgentProfiles(config).find((profile) => profile.id === normalizedId);
}

export function allMentionAliases(config: PluginConfig): string[] {
  const aliases = new Set<string>();

  for (const alias of DEFAULT_MENTION_ALIASES) {
    aliases.add(alias.trim());
  }

  for (const alias of asStringArray(config.mentionAliases)) {
    aliases.add(alias.trim());
  }

  for (const profile of resolveAgentProfiles(config)) {
    for (const alias of profile.aliases || []) {
      aliases.add(alias.trim());
    }
  }

  return sortAliasesLongestFirst(
    Array.from(aliases).filter((item) => item.length > 0),
  );
}
