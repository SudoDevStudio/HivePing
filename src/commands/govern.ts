import fs from "node:fs/promises";
import path from "node:path";
import {
  executeApprovedWebhookAction,
  externalActionUsage,
  parseExternalActionInput,
} from "../core/action-webhook.js";
import { ApprovalStore } from "../core/approval-store.js";
import { BindingStore } from "../core/binding-store.js";
import { HistoryStore } from "../core/history-store.js";
import {
  applyApiPolicyToConfig,
  fetchConfigApiDecision,
  isActionAllowedByPermissions,
  type ConfigApiAccessDecision,
  type ConfigApiRequestInput,
} from "../core/config-api.js";
import { callReasoningOnce } from "../core/codex-client.js";
import { validateAndResolveRepoPath } from "../core/path-validation.js";
import { resolveRolePolicyDir } from "../core/role-policy-path.js";
import { matchSkillRouteWithAgent } from "../core/skill-agent.js";
import {
  loadSkillRoutes,
  loadSkillsDocument,
  matchSkillRoute,
  resolveSkillsFilePath,
} from "../core/skill-router.js";
import {
  applyProjectPolicyRuntimeDefaults,
  approverRoles,
  detectHeavyChange,
  detectWriteIntent,
  emailCandidates,
  extractTicketReference,
  isApprovalEnabled,
  isRoleAllowedForAction,
  loadProjectPolicies,
  minRequiredRoleForAction,
  parseProjectRole,
  principalCandidates,
  PROJECT_ROLES,
  removeProjectMemberRole,
  resolvePolicyByRepoPath,
  roleForPrincipal,
  setProjectMemberRole,
  usernameCandidates,
} from "../core/role-policy.js";
import {
  loadManagedRuntimeConfig,
  type ManagedRuntimeConfig,
  updateManagedRuntimeConfig,
} from "../core/runtime-config.js";
import { PLUGIN_NAME, PRIMARY_MENTION_ALIAS, primaryStoragePath } from "../core/branding.js";
import { resolveConversationKey } from "../providers/index.js";
import type {
  BindingMetadata,
  ConversationBinding,
  ConversationKeyContext,
  GovernAction,
  PluginConfig,
  ProjectRole,
  ProjectPolicy,
} from "../types.js";

export type GovernDeps = {
  config: PluginConfig;
  store: BindingStore;
  approvals: ApprovalStore;
  history: HistoryStore;
  historyMaxMessages?: number;
  approvalsFilePath?: string;
};

type BindArgs = {
  repoPath: string;
  metadata?: BindingMetadata;
};

type AskOptions = {
  binding?: ConversationBinding;
  actorLabel?: string;
  configOverride?: PluginConfig;
};

type AuthorizationResult = {
  decision: ConfigApiAccessDecision | null;
  effectiveConfig: PluginConfig;
  apiReadOnlyForced: boolean;
};

type RolePolicyState = {
  enabled: boolean;
  policies: ProjectPolicy[];
};

type WriteRequestIntent = {
  prompt: string;
  writeIntent: boolean;
};

type RoleCommandArgs =
  | { action: "list" }
  | { action: "set"; memberKey: string; role: ProjectRole }
  | { action: "remove"; memberKey: string };

type ManagedConfigKey =
  | "reasoningCommand"
  | "reasoningArgs"
  | "reasoningToolName"
  | "defaultModel"
  | "defaultProfile"
  | "rolePolicyEnabled"
  | "rolePolicyDir"
  | "skillsFile"
  | "skillsMode"
  | "approvalRequestsFile"
  | "changeSandbox"
  | "changeApprovalPolicy"
  | "actionWebhookUrl"
  | "actionWebhookToken"
  | "actionWebhookTimeoutMs";

type ConfigCommandArgs =
  | { action: "show" }
  | { action: "defaults" }
  | { action: "set"; key: ManagedConfigKey; rawValue: string };

const MANAGED_CONFIG_KEYS: readonly ManagedConfigKey[] = [
  "reasoningCommand",
  "reasoningArgs",
  "reasoningToolName",
  "defaultModel",
  "defaultProfile",
  "rolePolicyEnabled",
  "rolePolicyDir",
  "skillsFile",
  "skillsMode",
  "approvalRequestsFile",
  "changeSandbox",
  "changeApprovalPolicy",
  "actionWebhookUrl",
  "actionWebhookToken",
  "actionWebhookTimeoutMs",
];
const DEFAULT_HISTORY_MESSAGES = 30;

function noRepositoryBoundMessage(conversationKey?: string): string {
  const lines = ["No repository is bound for this conversation."];
  if (conversationKey) {
    lines.push(`Key: ${conversationKey}`);
    lines.push(`Use ${PRIMARY_MENTION_ALIAS} bind <repo-path>.`);
  } else {
    lines.push(`Run ${PRIMARY_MENTION_ALIAS} bind <repo-path> first.`);
  }
  return lines.join("\n");
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function redactUrlForApproval(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return "(missing)";
  }

  try {
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname || "/";
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return "(invalid url)";
  }
}

function safeKeyList(value: unknown): string {
  const keys = Object.keys(asRecord(value)).sort();
  return keys.length > 0 ? keys.join(", ") : "(none)";
}

function approvalPreviewLines(payload: Record<string, unknown>): string[] {
  const mode = asString(payload.mode)?.toLowerCase();
  if (mode === "http") {
    const method = asString(payload.method)?.toUpperCase() || "(method missing)";
    const url = redactUrlForApproval(asString(payload.url));
    return [
      `HTTP target: ${method} ${url}`,
      `Header keys: ${safeKeyList(payload.headers)}`,
      `Query keys: ${safeKeyList(payload.query)}`,
      `Input keys: ${safeKeyList(payload.input)}`,
    ];
  }

  return ["Request payload: hidden (PII-safe)"];
}

function externalActionUserPrompt(request: {
  prompt?: string;
  externalAction?: { payload?: Record<string, unknown>; summary?: string };
}): string {
  const payload = asRecord(request.externalAction?.payload);
  const input = asRecord(payload.input);
  return (
    asString(input.prompt) ||
    asString(request.externalAction?.summary) ||
    asString(request.prompt) ||
    "Handle this external action result."
  );
}

function shouldNaturalizeExternalActionResponse(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

async function naturalizeExternalActionResponse(params: {
  deps: GovernDeps;
  repoPath: string;
  conversationKey: string;
  userPrompt: string;
  actionName: string;
  rawResponse: string;
  configOverride?: PluginConfig;
}): Promise<string> {
  if (!shouldNaturalizeExternalActionResponse(params.rawResponse)) {
    return params.rawResponse;
  }

  const formatConfig: PluginConfig = {
    ...(params.configOverride || params.deps.config),
    defaultSandbox: "read-only",
    defaultApprovalPolicy: "never",
  };

  const recentHistory = await params.deps.history.recent(params.conversationKey, 8);

  try {
    const result = await callReasoningOnce(
      formatConfig,
      params.repoPath,
      [
        "Rewrite the API result into a natural chat reply for the user.",
        "Return plain text only.",
        "Do not include JSON or internal field names unless the user asked for raw output.",
        "",
        `User request: ${params.userPrompt}`,
        `Action: ${params.actionName}`,
        "API result:",
        params.rawResponse,
      ].join("\n"),
      recentHistory,
    );
    const text = result.text.trim();
    return text || params.rawResponse;
  } catch {
    return params.rawResponse;
  }
}

function tokenizeArgs(rawArgs: string): string[] {
  const tokens: string[] = [];
  const matcher = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;

  for (const match of rawArgs.matchAll(matcher)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (value.length === 0) continue;
    tokens.push(value.replace(/\\(["'\\])/g, "$1"));
  }

  return tokens;
}

function parseBindArgs(rawArgs: string): BindArgs {
  const tokens = tokenizeArgs(rawArgs);
  if (tokens.length === 0) {
    throw new Error(`Usage: ${PRIMARY_MENTION_ALIAS} bind <repo-path> [--meta key=value]`);
  }

  let repoPath: string | undefined;
  const metadata: BindingMetadata = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--meta") {
      const next = tokens[index + 1];
      if (!next) {
        throw new Error("Missing value after --meta. Expected key=value.");
      }

      const separator = next.indexOf("=");
      if (separator <= 0 || separator === next.length - 1) {
        throw new Error(`Invalid --meta value "${next}". Expected key=value.`);
      }

      const key = next.slice(0, separator).trim();
      const value = next.slice(separator + 1).trim();
      metadata[key] = value;
      index += 1;
      continue;
    }

    if (!repoPath) {
      repoPath = token;
      continue;
    }

    throw new Error(`Unexpected argument "${token}".`);
  }

  if (!repoPath) {
    throw new Error(`Usage: ${PRIMARY_MENTION_ALIAS} bind <repo-path> [--meta key=value]`);
  }

  return {
    repoPath,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function parseApprovalCommandArgs(rawArgs: string): { requestId: string; reason?: string } {
  const tokens = tokenizeArgs(rawArgs);
  const requestId = tokens[0];

  if (!requestId) {
    throw new Error(
      `Usage: ${PRIMARY_MENTION_ALIAS} approve <request-id> OR ${PRIMARY_MENTION_ALIAS} reject <request-id> [reason]`,
    );
  }

  const reason = tokens.length > 1 ? tokens.slice(1).join(" ") : undefined;
  return { requestId, reason };
}

function parseActionCommandArgs(rawArgs: string): {
  name: string;
  payload: Record<string, unknown>;
  summary: string;
} {
  let parsed: ReturnType<typeof parseExternalActionInput>;
  try {
    parsed = parseExternalActionInput(rawArgs);
  } catch {
    throw new Error(externalActionUsage());
  }
  return {
    name: parsed.name,
    payload: parsed.payload,
    summary: parsed.summary,
  };
}

function roleUsageText(): string {
  return [
    "Usage:",
    `${PRIMARY_MENTION_ALIAS} role list`,
    `${PRIMARY_MENTION_ALIAS} role set <member-or-email> <role>`,
    `${PRIMARY_MENTION_ALIAS} role remove <member-or-email>`,
    `Allowed roles: ${PROJECT_ROLES.join(", ")}`,
  ].join("\n");
}

function parseRoleCommandArgs(rawArgs: string): RoleCommandArgs {
  const tokens = tokenizeArgs(rawArgs);
  if (tokens.length === 0) {
    return { action: "list" };
  }

  const action = tokens[0].toLowerCase();

  if (action === "list") {
    return { action: "list" };
  }

  if (action === "set") {
    const memberKey = tokens[1];
    const roleRaw = tokens[2];

    if (!memberKey || !roleRaw) {
      throw new Error(roleUsageText());
    }

    const role = parseProjectRole(roleRaw);
    if (!role) {
      throw new Error(`Invalid role \"${roleRaw}\". Allowed roles: ${PROJECT_ROLES.join(", ")}`);
    }

    return { action: "set", memberKey, role };
  }

  if (action === "remove") {
    const memberKey = tokens[1];
    if (!memberKey) {
      throw new Error(roleUsageText());
    }
    return { action: "remove", memberKey };
  }

  throw new Error(roleUsageText());
}

function configUsageText(): string {
  return [
    "Usage:",
    `${PRIMARY_MENTION_ALIAS} config show`,
    `${PRIMARY_MENTION_ALIAS} config defaults`,
    `${PRIMARY_MENTION_ALIAS} config set <key> <value>`,
    `Keys: ${MANAGED_CONFIG_KEYS.join(", ")}`,
  ].join("\n");
}

function parseBooleanString(rawValue: string): boolean | undefined {
  const lowered = rawValue.trim().toLowerCase();
  if (lowered === "true" || lowered === "1" || lowered === "yes" || lowered === "on") {
    return true;
  }
  if (lowered === "false" || lowered === "0" || lowered === "no" || lowered === "off") {
    return false;
  }
  return undefined;
}

function parseConfigCommandArgs(rawArgs: string): ConfigCommandArgs {
  const tokens = tokenizeArgs(rawArgs);
  if (tokens.length === 0) {
    return { action: "show" };
  }

  const action = tokens[0].toLowerCase();

  if (action === "show") {
    return { action: "show" };
  }

  if (action === "defaults") {
    return { action: "defaults" };
  }

  if (action === "set") {
    const key = tokens[1] as ManagedConfigKey | undefined;
    if (!key || !MANAGED_CONFIG_KEYS.includes(key)) {
      throw new Error(configUsageText());
    }

    if (tokens.length < 3) {
      throw new Error(configUsageText());
    }

    return {
      action: "set",
      key,
      rawValue: tokens.slice(2).join(" "),
    };
  }

  throw new Error(configUsageText());
}

function configSnapshotText(config: PluginConfig): string {
  return [
    "Managed config:",
    `reasoningCommand: ${config.reasoningCommand || config.codexCommand || "codex"}`,
    `reasoningArgs: ${JSON.stringify(config.reasoningArgs || ["mcp-server"])}`,
    `reasoningToolName: ${config.reasoningToolName || "codex"}`,
    `defaultModel: ${config.defaultModel || "(unset)"}`,
    `defaultProfile: ${config.defaultProfile || "(unset)"}`,
    `rolePolicyEnabled: ${config.rolePolicyEnabled === true ? "true" : "false"}`,
    `rolePolicyDir: ${config.rolePolicyDir || "(unset)"}`,
    `skillsFile: ${config.skillsFile || `(unset; default is <bound-repo>/${primaryStoragePath("skills.md")})`}`,
    `skillsMode: ${config.skillsMode || "rules"}`,
    `approvalRequestsFile: ${config.approvalRequestsFile || "(unset)"}`,
    `changeSandbox: ${config.changeSandbox || "(unset)"}`,
    `changeApprovalPolicy: ${config.changeApprovalPolicy || "(unset)"}`,
    `actionWebhookUrl: ${config.actionWebhookUrl || "(unset)"}`,
    `actionWebhookToken: ${config.actionWebhookToken ? "(set)" : "(unset)"}`,
    `actionWebhookTimeoutMs: ${
      typeof config.actionWebhookTimeoutMs === "number"
        ? String(config.actionWebhookTimeoutMs)
        : "(unset)"
    }`,
  ].join("\n");
}

function helpText(): string {
  return [
    `${PLUGIN_NAME} mention flow:`,
    `${PRIMARY_MENTION_ALIAS} bind <repo-path> [--meta key=value]  - bind this conversation to a repository`,
    `${PRIMARY_MENTION_ALIAS} status                               - show the current binding`,
    `${PRIMARY_MENTION_ALIAS} whoami                               - show detected user identity and resolved role`,
    `${PRIMARY_MENTION_ALIAS} config show|defaults|set             - manage plugin runtime settings`,
    `${PRIMARY_MENTION_ALIAS} role list|set|remove                 - manage role bindings for the bound project`,
    `${PRIMARY_MENTION_ALIAS} action <name> <json-payload>         - create an approval-gated external action`,
    `${PRIMARY_MENTION_ALIAS} skills                               - list loaded skill routes for this repo`,
    `${PRIMARY_MENTION_ALIAS} unbind                               - remove the current binding`,
    `${PRIMARY_MENTION_ALIAS} approve <request-id>                 - maintainer/owner approval for pending write request`,
    `${PRIMARY_MENTION_ALIAS} reject <request-id> [reason]         - reject pending write request`,
    `${PRIMARY_MENTION_ALIAS} <question>                           - ask the configured reasoning backend (default behavior)`,
  ].join("\n");
}

function normalizeNaturalPrompt(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^\/(?:hiveping)\b\s*/i, "").trim();
}

function normalizeRepoPathForComparison(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
}

function projectIdFromMetadata(metadata?: BindingMetadata): string | undefined {
  if (!metadata) {
    return undefined;
  }

  const candidate =
    asString(metadata.projectId) ||
    asString(metadata.project) ||
    asString(metadata.project_id) ||
    asString(metadata["project-id"]);

  return candidate;
}

function rolePolicyEnabled(config: PluginConfig): boolean {
  return config.rolePolicyEnabled === true;
}

async function loadRolePolicyState(
  config: PluginConfig,
  repoPathHint?: string,
): Promise<RolePolicyState> {
  if (!rolePolicyEnabled(config)) {
    return { enabled: false, policies: [] };
  }

  const policyDir = resolveRolePolicyDir(config, repoPathHint);
  if (!policyDir) {
    return { enabled: true, policies: [] };
  }

  const policies = await loadProjectPolicies(policyDir, { repoPathHint });
  return { enabled: true, policies };
}

function defaultManagedConfig(config: PluginConfig): ManagedRuntimeConfig {
  return {
    reasoningCommand: config.reasoningCommand || config.codexCommand || "codex",
    reasoningArgs: config.reasoningArgs || ["mcp-server"],
    reasoningToolName: config.reasoningToolName || "codex",
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    ...(config.defaultProfile ? { defaultProfile: config.defaultProfile } : {}),
    rolePolicyEnabled: true,
    ...(config.rolePolicyDir ? { rolePolicyDir: path.resolve(config.rolePolicyDir) } : {}),
    ...(config.skillsFile ? { skillsFile: path.resolve(config.skillsFile) } : {}),
    skillsMode: config.skillsMode === "agent" ? "agent" : "rules",
    approvalRequestsFile:
      config.approvalRequestsFile || path.resolve(primaryStoragePath("approval-requests.json")),
    changeSandbox: "workspace-write",
    changeApprovalPolicy: "on-request",
    ...(config.actionWebhookUrl ? { actionWebhookUrl: config.actionWebhookUrl } : {}),
    ...(config.actionWebhookToken ? { actionWebhookToken: config.actionWebhookToken } : {}),
    actionWebhookTimeoutMs:
      typeof config.actionWebhookTimeoutMs === "number" ? config.actionWebhookTimeoutMs : 8_000,
  };
}

function parseStringArrayValue(rawValue: string): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("reasoningArgs cannot be empty.");
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("reasoningArgs must be a JSON string array.");
    }

    const normalized = parsed
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item));

    if (normalized.length === 0 && parsed.length > 0) {
      throw new Error("reasoningArgs must contain only non-empty strings.");
    }

    return normalized;
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Fall back to shell-style token parsing below.
    } else if (error instanceof Error) {
      throw error;
    }
  }

  const tokens = tokenizeArgs(rawValue);
  if (tokens.length === 0) {
    throw new Error("reasoningArgs expects a JSON array or a quoted argument list.");
  }
  return tokens;
}

function managedPatchFromSetArg(key: ManagedConfigKey, rawValue: string): ManagedRuntimeConfig {
  if (key === "reasoningCommand") {
    const value = asString(rawValue);
    if (!value) {
      throw new Error("reasoningCommand cannot be empty.");
    }
    return { reasoningCommand: value };
  }

  if (key === "reasoningArgs") {
    return { reasoningArgs: parseStringArrayValue(rawValue) };
  }

  if (key === "reasoningToolName") {
    const value = asString(rawValue);
    if (!value) {
      throw new Error("reasoningToolName cannot be empty.");
    }
    return { reasoningToolName: value };
  }

  if (key === "defaultModel") {
    const value = asString(rawValue);
    if (!value) {
      throw new Error("defaultModel cannot be empty.");
    }
    return { defaultModel: value };
  }

  if (key === "defaultProfile") {
    const value = asString(rawValue);
    if (!value) {
      throw new Error("defaultProfile cannot be empty.");
    }
    return { defaultProfile: value };
  }

  if (key === "rolePolicyEnabled") {
    const parsed = parseBooleanString(rawValue);
    if (typeof parsed === "undefined") {
      throw new Error("rolePolicyEnabled expects true/false.");
    }
    return { rolePolicyEnabled: parsed };
  }

  if (key === "rolePolicyDir") {
    const value = asString(rawValue);
    if (!value) {
      throw new Error("rolePolicyDir cannot be empty.");
    }
    return { rolePolicyDir: path.resolve(value) };
  }

  if (key === "skillsFile") {
    const value = asString(rawValue);
    if (!value) {
      throw new Error("skillsFile cannot be empty.");
    }
    return { skillsFile: path.resolve(value) };
  }

  if (key === "skillsMode") {
    const value = asString(rawValue)?.toLowerCase();
    if (value !== "rules" && value !== "agent") {
      throw new Error("skillsMode expects rules or agent.");
    }
    return { skillsMode: value };
  }

  if (key === "approvalRequestsFile") {
    const value = asString(rawValue);
    if (!value) {
      throw new Error("approvalRequestsFile cannot be empty.");
    }
    return { approvalRequestsFile: path.resolve(value) };
  }

  if (key === "changeSandbox") {
    const value = asString(rawValue)?.toLowerCase();
    if (value !== "workspace-write" && value !== "danger-full-access") {
      throw new Error("changeSandbox expects workspace-write or danger-full-access.");
    }
    return { changeSandbox: value };
  }

  if (key === "actionWebhookUrl") {
    const value = asString(rawValue);
    if (!value) {
      throw new Error("actionWebhookUrl cannot be empty.");
    }
    return { actionWebhookUrl: value };
  }

  if (key === "actionWebhookToken") {
    const value = asString(rawValue);
    if (!value) {
      throw new Error("actionWebhookToken cannot be empty.");
    }
    return { actionWebhookToken: value };
  }

  if (key === "actionWebhookTimeoutMs") {
    const value = Number(rawValue.trim());
    if (!Number.isFinite(value) || value < 500) {
      throw new Error("actionWebhookTimeoutMs expects a number >= 500.");
    }
    return { actionWebhookTimeoutMs: Math.round(value) };
  }

  const value = asString(rawValue)?.toLowerCase();
  if (value !== "untrusted" && value !== "on-request" && value !== "never") {
    throw new Error("changeApprovalPolicy expects untrusted, on-request, or never.");
  }
  return { changeApprovalPolicy: value };
}

function applyManagedConfigToDeps(deps: GovernDeps, patch: ManagedRuntimeConfig): void {
  const next: PluginConfig = {
    ...deps.config,
    ...patch,
  };

  if (next.rolePolicyDir) {
    next.rolePolicyDir = path.resolve(next.rolePolicyDir);
  }

  if (next.skillsFile) {
    next.skillsFile = path.resolve(next.skillsFile);
  }

  if (next.approvalRequestsFile) {
    next.approvalRequestsFile = path.resolve(next.approvalRequestsFile);
  }

  deps.config = next;

  const approvalFile = deps.config.approvalRequestsFile;
  if (approvalFile && deps.approvalsFilePath !== approvalFile) {
    deps.approvals = new ApprovalStore(approvalFile);
    deps.approvalsFilePath = approvalFile;
  }
}

async function refreshManagedConfigFromDisk(deps: GovernDeps): Promise<void> {
  const runtimeConfigFile = deps.config.runtimeConfigFile?.trim();
  if (!runtimeConfigFile) {
    return;
  }

  const managed = await loadManagedRuntimeConfig(runtimeConfigFile);
  applyManagedConfigToDeps(deps, managed);
}

function roleDeniedMessage(params: {
  actionLabel: string;
  role: ProjectRole;
  requiredRole: ProjectRole;
  suggestApproval?: boolean;
}): string {
  const lines = [
    `Access denied: ${params.actionLabel}.`,
    `Your role: ${params.role}`,
    `Minimum required role: ${params.requiredRole}`,
  ];

  if (params.suggestApproval) {
    lines.push("Ask a maintainer/owner to approve this request.");
  }

  return lines.join("\n");
}

function actorPrincipal(provider: string, context: ConversationKeyContext): string {
  const raw = asString(context.from);
  if (!raw) {
    return `${provider}:unknown`;
  }

  if (raw.toLowerCase().startsWith(`${provider.toLowerCase()}:`)) {
    return raw;
  }

  return `${provider}:${raw}`;
}

const WHOAMI_ACTIONS: Array<
  "ask" | "status" | "change" | "bind" | "unbind" | "approve" | "externalApi"
> = [
  "ask",
  "status",
  "change",
  "bind",
  "unbind",
  "approve",
  "externalApi",
];

function buildWhoAmIText(params: {
  provider: string;
  conversationKey: string;
  context: ConversationKeyContext;
  rolePolicyState: RolePolicyState;
  binding: ConversationBinding | undefined;
}): string {
  const actor = actorPrincipal(params.provider, params.context);
  const detectedSender = asString(params.context.from) || "unknown";
  const detectedUsername = asString(params.context.userUsername);
  const detectedEmail = asString(params.context.userEmail);
  const candidates = Array.from(
    new Set([
      ...principalCandidates(params.provider, asString(params.context.from)),
      ...usernameCandidates(params.provider, detectedUsername),
      ...emailCandidates(params.provider, detectedEmail),
    ]),
  );

  const lines: string[] = [
    "Identity summary:",
    `Detected sender: ${detectedSender}`,
    `Detected username: ${detectedUsername || "(not available from channel event)"}`,
    `Detected email: ${detectedEmail || "(not available from channel event)"}`,
    `Resolved principal: ${actor}`,
    `Provider: ${params.provider}`,
    `Conversation key: ${params.conversationKey}`,
  ];

  if (!params.binding) {
    lines.push(`Bound repo: none (run ${PRIMARY_MENTION_ALIAS} bind <repo-path> first)`);
  } else {
    lines.push(`Bound repo: ${params.binding.repoPath}`);
  }

  if (!params.rolePolicyState.enabled) {
    lines.push("Role policy: disabled (rolePolicyEnabled=false)");
    lines.push("Enable role policy to resolve project role and permissions.");
  } else if (!params.binding) {
    lines.push("Role policy: enabled");
    lines.push("Role resolution needs a bound repo with matching project policy file.");
  } else {
    const policy = resolvePolicyByRepoPath(params.rolePolicyState.policies, params.binding.repoPath);

    if (!policy) {
      lines.push(`Role policy: no project file matched bound repo ${params.binding.repoPath}`);
    } else {
      const role = roleForPrincipal(
        policy,
        params.provider,
        actor,
        detectedEmail,
        detectedUsername,
      );
      lines.push(`Project: ${policy.projectId}`);
      lines.push(`Resolved role: ${role}`);

      const accessSummary = WHOAMI_ACTIONS.map((action) =>
        `${action}=${isRoleAllowedForAction(role, policy, action) ? "allowed" : "denied"}`,
      ).join(", ");

      lines.push(`Permissions: ${accessSummary}`);
    }
  }

  if (candidates.length > 0) {
    lines.push("Use one of these keys in policy members:");
    for (const candidate of candidates.slice(0, 8)) {
      lines.push(`- ${candidate}`);
    }
  }

  return lines.join("\n");
}

function roleForActionOrThrow(params: {
  policy: ProjectPolicy;
  provider: string;
  context: ConversationKeyContext;
  action: "ask" | "status" | "change" | "bind" | "unbind" | "approve" | "externalApi";
  actionLabel: string;
  suggestApproval?: boolean;
}): ProjectRole {
  const actor = actorPrincipal(params.provider, params.context);
  const role = roleForPrincipal(
    params.policy,
    params.provider,
    actor,
    params.context.userEmail,
    params.context.userUsername,
  );

  if (!isRoleAllowedForAction(role, params.policy, params.action)) {
    const requiredRole = minRequiredRoleForAction(params.policy, params.action);
    throw new Error(
      roleDeniedMessage({
        actionLabel: params.actionLabel,
        role,
        requiredRole,
        suggestApproval: params.suggestApproval,
      }),
    );
  }

  return role;
}

function formatRoleMembersText(policy: ProjectPolicy): string {
  const members = Object.entries(policy.members || {}).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );

  const lines = [
    `Project: ${policy.projectId}`,
    `Repo: ${policy.repoPath}`,
    `Default model: ${policy.defaultModel || "(inherit hiveping default)"}`,
    `Default profile: ${policy.defaultProfile || "(inherit hiveping default)"}`,
  ];

  if (members.length === 0) {
    lines.push("Members: none (all users resolve to role anyone unless mapped)");
    return lines.join("\n");
  }

  lines.push(`Members (${members.length}):`);
  for (const [principal, role] of members) {
    lines.push(`- ${principal} => ${role}`);
  }

  return lines.join("\n");
}

async function handleRoleCommand(params: {
  parsed: RoleCommandArgs;
  binding: ConversationBinding | undefined;
  rolePolicyState: RolePolicyState;
  provider: string;
  context: ConversationKeyContext;
  deps: GovernDeps;
}): Promise<{ text: string }> {
  if (!params.rolePolicyState.enabled) {
    throw new Error("Role management requires rolePolicyEnabled=true.");
  }

  if (!params.binding) {
    throw new Error(noRepositoryBoundMessage());
  }

  const policy = enforceProjectPolicyExistsForRepo(params.rolePolicyState, params.binding.repoPath);
  if (!policy) {
    throw new Error(`No policy found for bound repository: ${params.binding.repoPath}`);
  }

  if (params.parsed.action === "list") {
    roleForActionOrThrow({
      policy,
      provider: params.provider,
      context: params.context,
      action: "status",
      actionLabel: "view role members",
    });
    return { text: formatRoleMembersText(policy) };
  }

  roleForActionOrThrow({
    policy,
    provider: params.provider,
    context: params.context,
    action: "bind",
    actionLabel: "manage role members",
  });

  const policyDir = resolveRolePolicyDir(params.deps.config, params.binding.repoPath);
  if (!policyDir) {
    throw new Error("Unable to resolve rolePolicyDir for this bound repository.");
  }

  if (params.parsed.action === "set") {
    const result = await setProjectMemberRole({
      policyDir,
      repoPath: params.binding.repoPath,
      provider: params.provider,
      memberKey: params.parsed.memberKey,
      role: params.parsed.role,
    });

    return {
      text: [
        "Role updated.",
        `Project: ${result.policy.projectId}`,
        `Member: ${result.normalizedMemberKey}`,
        `Role: ${params.parsed.role}`,
        "Persisted in project policy JSON (survives restart).",
      ].join("\n"),
    };
  }

  const result = await removeProjectMemberRole({
    policyDir,
    repoPath: params.binding.repoPath,
    provider: params.provider,
    memberKey: params.parsed.memberKey,
  });

  return {
    text: [
      result.removed ? "Role mapping removed." : "Role mapping not found.",
      `Project: ${result.policy.projectId}`,
      `Member: ${result.normalizedMemberKey}`,
      "Persisted in project policy JSON (survives restart).",
    ].join("\n"),
  };
}

async function handleConfigCommand(params: {
  parsed: ConfigCommandArgs;
  binding: ConversationBinding | undefined;
  rolePolicyState: RolePolicyState;
  provider: string;
  context: ConversationKeyContext;
  deps: GovernDeps;
}): Promise<{ text: string }> {
  const runtimeConfigFile = params.deps.config.runtimeConfigFile?.trim();
  if (!runtimeConfigFile) {
    throw new Error("runtimeConfigFile is not configured.");
  }

  if (params.binding && params.rolePolicyState.enabled) {
    const policy = resolvePolicyByRepoPath(params.rolePolicyState.policies, params.binding.repoPath);
    if (policy) {
      roleForActionOrThrow({
        policy,
        provider: params.provider,
        context: params.context,
        action: params.parsed.action === "show" ? "status" : "bind",
        actionLabel: params.parsed.action === "show" ? "view runtime config" : "update runtime config",
      });
    }
  }

  if (params.parsed.action === "show") {
    return {
      text: `${configSnapshotText(params.deps.config)}\nRuntime config file: ${runtimeConfigFile}`,
    };
  }

  const patch =
    params.parsed.action === "defaults"
      ? defaultManagedConfig(params.deps.config)
      : managedPatchFromSetArg(params.parsed.key, params.parsed.rawValue);

  const mergedManaged = await updateManagedRuntimeConfig(runtimeConfigFile, patch);
  applyManagedConfigToDeps(params.deps, mergedManaged);

  const effectivePolicyDir = resolveRolePolicyDir(
    params.deps.config,
    params.binding?.repoPath,
  );
  if (effectivePolicyDir) {
    await fs.mkdir(effectivePolicyDir, { recursive: true });
  }

  return {
    text: [
      params.parsed.action === "defaults" ? "Applied managed defaults." : "Updated managed config.",
      configSnapshotText(params.deps.config),
      `Runtime config file: ${runtimeConfigFile}`,
      "Settings are persisted and survive restarts.",
    ].join("\n"),
  };
}

function inferWriteRequestIntent(subcommand: string, rest: string, fallbackPrompt: string): WriteRequestIntent {
  if (subcommand === "ask") {
    return {
      prompt: rest,
      writeIntent: detectWriteIntent(rest),
    };
  }

  if (subcommand === "change" || subcommand === "update" || subcommand === "edit" || subcommand === "fix") {
    return {
      prompt: rest,
      writeIntent: true,
    };
  }

  return {
    prompt: fallbackPrompt,
    writeIntent: detectWriteIntent(fallbackPrompt),
  };
}

function enforceProjectPolicyExistsForRepo(
  state: RolePolicyState,
  repoPath: string,
): ProjectPolicy | undefined {
  if (!state.enabled) {
    return undefined;
  }

  const policy = resolvePolicyByRepoPath(state.policies, repoPath);
  if (!policy) {
    throw new Error(
      `No project policy found for repository: ${repoPath}. Add a JSON policy file under rolePolicyDir.`,
    );
  }

  return policy;
}

function isProjectVisibleForRequest(
  decision: ConfigApiAccessDecision,
  conversationKey: string,
  project: ConfigApiAccessDecision["projects"][number],
): boolean {
  if (!project.enabled) {
    return false;
  }

  if (project.allowedRoles.length > 0) {
    const hasRole = project.allowedRoles.some((role) => decision.roles.includes(role));
    if (!hasRole) {
      return false;
    }
  }

  if (project.allowedConversationPrefixes.length > 0) {
    const allowedConversation = project.allowedConversationPrefixes.some((prefix) =>
      conversationKey.startsWith(prefix),
    );
    if (!allowedConversation) {
      return false;
    }
  }

  return true;
}

function enforceProjectAccessForRepo(
  action: "bind" | "ask",
  repoPath: string,
  decision: ConfigApiAccessDecision | null,
  conversationKey: string,
): void {
  if (!decision) {
    return;
  }

  const visibleProjects = decision.projects.filter((project) =>
    isProjectVisibleForRequest(decision, conversationKey, project),
  );

  if (visibleProjects.length === 0) {
    if (action === "ask" && decision.projects.length > 0) {
      throw new Error("No approved project is available for this conversation.");
    }

    if (
      action === "bind" &&
      (decision.policy.requireProjectMatchForBind === true || decision.projects.length > 0)
    ) {
      throw new Error("No enabled project is available for this conversation by organization policy.");
    }

    return;
  }

  const normalizedRepoPath = normalizeRepoPathForComparison(repoPath);
  const hasMatch = visibleProjects.some(
    (project) => normalizeRepoPathForComparison(project.repoPath) === normalizedRepoPath,
  );

  const mustMatchForBind =
    action === "bind" &&
    (decision.policy.requireProjectMatchForBind === true || decision.projects.length > 0);
  const mustMatchForAsk = action === "ask" && decision.projects.length > 0;

  if ((mustMatchForBind || mustMatchForAsk) && !hasMatch) {
    if (action === "bind") {
      throw new Error(
        "Requested repository is not approved for this conversation. Use an allowed project repository.",
      );
    }

    throw new Error(
      "The bound repository is not approved for this conversation. Re-bind to an allowed project repository.",
    );
  }
}

function buildConfigApiInput(params: {
  action: GovernAction;
  provider: string;
  conversationKey: string;
  context: ConversationKeyContext;
  requested?: {
    projectId?: string;
    repoPath?: string;
  };
}): ConfigApiRequestInput {
  const threadId =
    typeof params.context.messageThreadId === "number"
      ? String(params.context.messageThreadId)
      : asString(params.context.messageThreadId);

  return {
    action: params.action,
    provider: params.provider,
    conversationKey: params.conversationKey,
    user: {
      id: asString(params.context.from),
      displayName: asString(params.context.userDisplayName),
      username: asString(params.context.userUsername),
      email: asString(params.context.userEmail),
    },
    context: {
      accountId: asString(params.context.accountId),
      channelId: asString(params.context.conversationId) || asString(params.context.to),
      threadId,
    },
    requested: {
      projectId: asString(params.requested?.projectId),
      repoPath: asString(params.requested?.repoPath),
    },
  };
}

async function resolveAuthorization(
  params: {
    action: GovernAction;
    provider: string;
    conversationKey: string;
    context: ConversationKeyContext;
    requested?: {
      projectId?: string;
      repoPath?: string;
    };
  },
  deps: GovernDeps,
): Promise<AuthorizationResult> {
  const decision = await fetchConfigApiDecision(
    deps.config,
    buildConfigApiInput({
      action: params.action,
      provider: params.provider,
      conversationKey: params.conversationKey,
      context: params.context,
      requested: params.requested,
    }),
  );

  if (!decision) {
    return {
      decision: null,
      effectiveConfig: deps.config,
      apiReadOnlyForced: false,
    };
  }

  if (!isActionAllowedByPermissions(decision.permissions, params.action)) {
    throw new Error(`Access denied by organization policy for action: ${params.action}`);
  }

  return {
    decision,
    effectiveConfig: applyApiPolicyToConfig(deps.config, decision.policy),
    apiReadOnlyForced: decision.policy.readOnlyCodex === true,
  };
}

function writeExecutionConfig(baseConfig: PluginConfig, apiReadOnlyForced: boolean): PluginConfig {
  if (apiReadOnlyForced) {
    throw new Error("This request is read-only by organization policy. A maintainer must allow write mode.");
  }

  const sandbox =
    baseConfig.changeSandbox ||
    (baseConfig.defaultSandbox && baseConfig.defaultSandbox !== "read-only"
      ? baseConfig.defaultSandbox
      : "workspace-write");

  return {
    ...baseConfig,
    defaultSandbox: sandbox,
    defaultApprovalPolicy: baseConfig.changeApprovalPolicy || "on-request",
  };
}

function historyMaxMessages(deps: GovernDeps): number {
  const configured = deps.historyMaxMessages;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_HISTORY_MESSAGES;
  }
  return Math.max(2, Math.floor(configured));
}

function skillRoutingMode(config: PluginConfig): "rules" | "agent" {
  return config.skillsMode === "agent" ? "agent" : "rules";
}

async function resolveSkillMatchForAsk(params: {
  config: PluginConfig;
  deps: GovernDeps;
  repoPath: string;
  conversationKey: string;
  askPrompt: string;
}): Promise<{ matched: ReturnType<typeof matchSkillRoute>; sourceLabel: string }> {
  const mode = skillRoutingMode(params.config);

  if (mode === "agent") {
    try {
      const recentHistory = await params.deps.history.recent(params.conversationKey, 12);
      const semanticMatch = await matchSkillRouteWithAgent({
        config: params.config,
        repoPath: params.repoPath,
        userPrompt: params.askPrompt,
        history: recentHistory,
      });

      if (semanticMatch) {
        return {
          matched: semanticMatch,
          sourceLabel: "SKILLS.md agent-route",
        };
      }
    } catch {
      // Agent routing should not block ask flow; deterministic fallback runs below.
    }
  }

  const routes = await loadSkillRoutes(params.config, params.repoPath);
  const matched = matchSkillRoute(params.askPrompt, routes);
  return {
    matched,
    sourceLabel: mode === "agent" ? "skills.md rules-fallback" : "skills.md rules-route",
  };
}

async function runCodexWithHistory(params: {
  prompt: string;
  conversationKey: string;
  repoPath: string;
  deps: GovernDeps;
  actorLabel?: string;
  configOverride?: PluginConfig;
}): Promise<{ text: string }> {
  const normalizedPrompt = normalizeNaturalPrompt(params.prompt);
  if (!normalizedPrompt) {
    throw new Error("Ask prompt is empty.");
  }

  const promptWithActor = params.actorLabel
    ? `[${params.actorLabel}] ${normalizedPrompt}`
    : normalizedPrompt;

  const maxHistory = historyMaxMessages(params.deps);
  const history = await params.deps.history.recent(params.conversationKey, maxHistory);

  await params.deps.history.append({
    conversationKey: params.conversationKey,
    role: "user",
    content: promptWithActor,
    maxEntries: maxHistory,
  });

  try {
    const result = await callReasoningOnce(
      params.configOverride || params.deps.config,
      params.repoPath,
      promptWithActor,
      history,
    );

    await params.deps.history.append({
      conversationKey: params.conversationKey,
      role: "assistant",
      content: result.text,
      maxEntries: maxHistory,
    });

    return { text: result.text };
  } catch (error) {
    await params.deps.history.append({
      conversationKey: params.conversationKey,
      role: "assistant",
      content: `Error: ${formatError(error)}`,
      maxEntries: maxHistory,
    });
    throw error;
  }
}

async function runAskPrompt(
  prompt: string,
  conversationKey: string,
  deps: GovernDeps,
  options: AskOptions,
): Promise<{ text: string }> {
  const binding = options.binding || (await deps.store.get(conversationKey));
  if (!binding) {
    throw new Error(
      noRepositoryBoundMessage(),
    );
  }

  return await runCodexWithHistory({
    prompt,
    conversationKey,
    repoPath: binding.repoPath,
    deps,
    actorLabel: options.actorLabel,
    configOverride: options.configOverride,
  });
}

async function handleApprovalDecision(params: {
  decision: "approved" | "rejected";
  args: string;
  context: ConversationKeyContext;
  provider: string;
  conversationKey: string;
  rolePolicy: RolePolicyState;
  deps: GovernDeps;
}): Promise<{ text: string }> {
  if (!params.rolePolicy.enabled) {
    throw new Error("Approval workflow requires rolePolicyEnabled=true.");
  }

  const parsed = parseApprovalCommandArgs(params.args);
  const request = await params.deps.approvals.get(parsed.requestId);

  if (!request) {
    throw new Error(`Approval request not found: ${parsed.requestId}`);
  }

  if (request.status !== "pending") {
    throw new Error(`Approval request ${request.id} is already ${request.status}.`);
  }

  if (request.conversationKey !== params.conversationKey) {
    throw new Error("Approval request belongs to a different conversation.");
  }

  const rolePolicyForRequest = await loadRolePolicyState(params.deps.config, request.repoPath);
  const policy = enforceProjectPolicyExistsForRepo(rolePolicyForRequest, request.repoPath);
  if (!policy) {
    throw new Error(`No policy found for approval request repo: ${request.repoPath}`);
  }

  const approverRole = roleForActionOrThrow({
    policy,
    provider: params.provider,
    context: params.context,
    action: "approve",
    actionLabel: "approve change request",
  });

  const approverId = actorPrincipal(params.provider, params.context);

  if (params.decision === "rejected") {
    await params.deps.approvals.decide({
      id: request.id,
      status: "rejected",
      decisionBy: approverId,
      decisionReason: parsed.reason,
    });

    const reasonText = parsed.reason ? `\nReason: ${parsed.reason}` : "";
    return {
      text: `Rejected request ${request.id}.\nDecision by: ${approverId}${reasonText}`,
    };
  }

  const authorization = await resolveAuthorization(
    {
      action: "ask",
      provider: params.provider,
      conversationKey: params.conversationKey,
      context: params.context,
      requested: {
        projectId: request.projectId,
        repoPath: request.repoPath,
      },
    },
    params.deps,
  );

  enforceProjectAccessForRepo("ask", request.repoPath, authorization.decision, params.conversationKey);

  if (request.requestType === "external-action" || request.requestType === "webhook-action") {
    const requestConfig = applyProjectPolicyRuntimeDefaults(authorization.effectiveConfig, policy);
    const history = await params.deps.history.recent(params.conversationKey, 20);
    const actionResult = await executeApprovedWebhookAction({
      config: requestConfig,
      request,
      approvedBy: approverId,
      approvalReason: parsed.reason,
      discussion: history,
    });

    await params.deps.approvals.decide({
      id: request.id,
      status: "approved",
      decisionBy: approverId,
      decisionReason: parsed.reason,
    });

    const reasonText = parsed.reason ? `\nReason: ${parsed.reason}` : "";
    const actionName = request.externalAction?.name || "unknown";
    const naturalResponse = await naturalizeExternalActionResponse({
      deps: params.deps,
      repoPath: request.repoPath,
      conversationKey: params.conversationKey,
      userPrompt: externalActionUserPrompt(request),
      actionName,
      rawResponse: actionResult.responseSummary,
      configOverride: requestConfig,
    });

    return {
      text: [
        `Approved request ${request.id}.`,
        `Approved by: ${approverId} (${approverRole})${reasonText}`,
        `Executed action: ${actionName}`,
        `Webhook response: ${naturalResponse}`,
      ].join("\n"),
    };
  }

  const ticketRef = request.ticketRef || extractTicketReference(request.prompt);
  if (
    policy.approval?.requireTicketForHeavyChange !== false &&
    detectHeavyChange(request.prompt, policy) &&
    !ticketRef
  ) {
    throw new Error(
      "This pending request is marked as heavy and requires a Jira/GitHub ticket reference before approval.",
    );
  }

  const writeConfig = applyProjectPolicyRuntimeDefaults(
    writeExecutionConfig(authorization.effectiveConfig, authorization.apiReadOnlyForced),
    policy,
  );
  const result = await runCodexWithHistory({
    prompt: request.prompt,
    conversationKey: params.conversationKey,
    repoPath: request.repoPath,
    deps: params.deps,
    actorLabel: request.requestedBy,
    configOverride: writeConfig,
  });

  await params.deps.approvals.decide({
    id: request.id,
    status: "approved",
    decisionBy: approverId,
    decisionReason: parsed.reason,
  });

  const reasonText = parsed.reason ? `\nReason: ${parsed.reason}` : "";
  return {
    text: [
      `Approved request ${request.id}.`,
      `Approved by: ${approverId} (${approverRole})${reasonText}`,
      `Project: ${request.projectId}`,
      "",
      result.text,
    ].join("\n"),
  };
}

async function createExternalActionApproval(params: {
  deps: GovernDeps;
  conversationKey: string;
  provider: string;
  repoPath: string;
  actorId: string;
  actorRole: ProjectRole;
  policy: ProjectPolicy;
  actionName: string;
  actionSummary: string;
  actionPayload: Record<string, unknown>;
  sourceLabel: string;
}): Promise<{ text: string }> {
  if (!isApprovalEnabled(params.policy)) {
    throw new Error("approval.enabled=false in project policy; enable it to approve external actions.");
  }

  const requiredRole = minRequiredRoleForAction(params.policy, "approve");
  const prompt = `External action request (${params.sourceLabel}): ${params.actionName}\n${params.actionSummary}`;
  const request = await params.deps.approvals.create({
    conversationKey: params.conversationKey,
    provider: params.provider,
    projectId: params.policy.projectId,
    repoPath: params.repoPath,
    prompt,
    requestedBy: params.actorId,
    requestedRole: params.actorRole,
    requiredRole,
    requestType: "external-action",
    externalAction: {
      name: params.actionName,
      payload: params.actionPayload,
      summary: params.actionSummary,
    },
  });

  return {
    text: [
      `Approval request created: ${request.id}`,
      `Action: ${params.actionName}`,
      `Summary: ${params.actionSummary}`,
      `Requested by: ${params.actorId} (${params.actorRole})`,
      `Source: ${params.sourceLabel}`,
      ...approvalPreviewLines(params.actionPayload),
      `Approver roles: ${approverRoles(params.policy).join(", ")}`,
      `Approve with: ${PRIMARY_MENTION_ALIAS} approve ${request.id}`,
      `Reject with: ${PRIMARY_MENTION_ALIAS} reject ${request.id} <reason>`,
    ].join("\n"),
  };
}

async function executeExternalActionDirectly(params: {
  deps: GovernDeps;
  conversationKey: string;
  provider: string;
  repoPath: string;
  actorId: string;
  actorRole: ProjectRole;
  policy: ProjectPolicy;
  actionName: string;
  actionSummary: string;
  actionPayload: Record<string, unknown>;
  sourceLabel: string;
}): Promise<{ text: string }> {
  const requiredRole = minRequiredRoleForAction(params.policy, "externalApi");
  const prompt = `External action direct-run (${params.sourceLabel}): ${params.actionName}\n${params.actionSummary}`;
  const request = await params.deps.approvals.create({
    conversationKey: params.conversationKey,
    provider: params.provider,
    projectId: params.policy.projectId,
    repoPath: params.repoPath,
    prompt,
    requestedBy: params.actorId,
    requestedRole: params.actorRole,
    requiredRole,
    requestType: "external-action",
    externalAction: {
      name: params.actionName,
      payload: params.actionPayload,
      summary: params.actionSummary,
    },
  });

  const actionResult = await executeApprovedWebhookAction({
    config: applyProjectPolicyRuntimeDefaults(params.deps.config, params.policy),
    request,
    approvedBy: params.actorId,
    approvalReason: "Auto-approved by externalApi permission",
    discussion: await params.deps.history.load(params.conversationKey),
  });

  await params.deps.approvals.decide({
    id: request.id,
    status: "approved",
    decisionBy: params.actorId,
    decisionReason: "Auto-approved by externalApi permission",
  });

  const naturalResponse = await naturalizeExternalActionResponse({
    deps: params.deps,
    repoPath: params.repoPath,
      conversationKey: params.conversationKey,
      userPrompt: asString(asRecord(asRecord(params.actionPayload).input).prompt) || params.actionSummary,
      actionName: params.actionName,
      rawResponse: actionResult.responseSummary,
      configOverride: applyProjectPolicyRuntimeDefaults(params.deps.config, params.policy),
    });

  return {
    text: [
      `External action executed directly: ${request.id}`,
      `Action: ${params.actionName}`,
      `Summary: ${params.actionSummary}`,
      `Executed by: ${params.actorId} (${params.actorRole})`,
      `Source: ${params.sourceLabel}`,
      ...approvalPreviewLines(params.actionPayload),
      `Webhook response: ${naturalResponse}`,
    ].join("\n"),
  };
}

async function executeGovernArgs(
  args: string,
  context: ConversationKeyContext,
  deps: GovernDeps,
): Promise<{ text: string }> {
  await refreshManagedConfigFromDisk(deps);

  const trimmedArgs = args.trim();

  if (!trimmedArgs) {
    return {
      text: [
        `${PLUGIN_NAME} is ready.`,
        `Bind once: ${PRIMARY_MENTION_ALIAS} bind /workspace/YOUR_DIR/<repo-name>`,
        `Then ask naturally: ${PRIMARY_MENTION_ALIAS} explain this project`,
      ].join("\n"),
    };
  }

  const spaceIndex = trimmedArgs.indexOf(" ");
  const subcommand = (spaceIndex >= 0 ? trimmedArgs.slice(0, spaceIndex) : trimmedArgs).toLowerCase();
  const rest = (spaceIndex >= 0 ? trimmedArgs.slice(spaceIndex + 1) : "").trim();

  const { key: conversationKey, provider } = resolveConversationKey(context);
  const actorId = actorPrincipal(provider, context);
  const boundConversation = await deps.store.get(conversationKey);
  const rolePolicyState = await loadRolePolicyState(deps.config, boundConversation?.repoPath);

  if (subcommand === "help") {
    return { text: helpText() };
  }

  if (subcommand === "whoami") {
    return {
      text: buildWhoAmIText({
        provider,
        conversationKey,
        context,
        rolePolicyState,
        binding: boundConversation,
      }),
    };
  }

  if (subcommand === "approve") {
    return await handleApprovalDecision({
      decision: "approved",
      args: rest,
      context,
      provider,
      conversationKey,
      rolePolicy: rolePolicyState,
      deps,
    });
  }

  if (subcommand === "reject") {
    return await handleApprovalDecision({
      decision: "rejected",
      args: rest,
      context,
      provider,
      conversationKey,
      rolePolicy: rolePolicyState,
      deps,
    });
  }

  if (subcommand === "bind") {
    const previousBinding = boundConversation;
    const parsed = parseBindArgs(rest);
    const authorization = await resolveAuthorization(
      {
        action: "bind",
        provider,
        conversationKey,
        context,
        requested: {
          projectId: projectIdFromMetadata(parsed.metadata),
          repoPath: parsed.repoPath,
        },
      },
      deps,
    );

    const resolvedPath = await validateAndResolveRepoPath(parsed.repoPath, authorization.effectiveConfig);
    enforceProjectAccessForRepo("bind", resolvedPath, authorization.decision, conversationKey);

    const policyStateForTargetRepo = await loadRolePolicyState(deps.config, resolvedPath);
    const policy = enforceProjectPolicyExistsForRepo(policyStateForTargetRepo, resolvedPath);

    if (policy) {
      roleForActionOrThrow({
        policy,
        provider,
        context,
        action: "bind",
        actionLabel: "bind repository",
      });
    }

    const metadata: BindingMetadata = {
      ...(parsed.metadata || {}),
      ...(policy && !parsed.metadata?.projectId ? { projectId: policy.projectId } : {}),
    };

    const finalMetadata = Object.keys(metadata).length > 0 ? metadata : undefined;

    await deps.store.set(conversationKey, {
      repoPath: resolvedPath,
      metadata: finalMetadata,
      provider,
      updatedAt: new Date().toISOString(),
    });

    const repoChanged =
      !previousBinding ||
      normalizeRepoPathForComparison(previousBinding.repoPath) !== normalizeRepoPathForComparison(resolvedPath);
    if (repoChanged) {
      await deps.history.clear(conversationKey);
    }

    const metadataText = finalMetadata ? `\nMetadata: ${JSON.stringify(finalMetadata)}` : "";
    return {
      text: `Bound conversation.\nKey: ${conversationKey}\nRepo: ${resolvedPath}${metadataText}`,
    };
  }

  if (subcommand === "status") {
    const binding = boundConversation;

    await resolveAuthorization(
      {
        action: "status",
        provider,
        conversationKey,
        context,
        requested: {
          projectId: projectIdFromMetadata(binding?.metadata),
          repoPath: binding?.repoPath,
        },
      },
      deps,
    );

    if (!binding) {
      return {
        text: noRepositoryBoundMessage(conversationKey),
      };
    }

    const policy = enforceProjectPolicyExistsForRepo(rolePolicyState, binding.repoPath);
    if (policy) {
      roleForActionOrThrow({
        policy,
        provider,
        context,
        action: "status",
        actionLabel: "view status",
      });
    }

    const metadataText = binding.metadata ? `\nMetadata: ${JSON.stringify(binding.metadata)}` : "";
    return {
      text: `Binding status:\nKey: ${conversationKey}\nProvider: ${binding.provider}\nRepo: ${binding.repoPath}\nUpdated: ${binding.updatedAt}${metadataText}`,
    };
  }

  if (subcommand === "config") {
    const parsedConfigCommand = parseConfigCommandArgs(rest);
    const binding = boundConversation;

    await resolveAuthorization(
      {
        action: parsedConfigCommand.action === "show" ? "status" : "bind",
        provider,
        conversationKey,
        context,
        requested: {
          projectId: projectIdFromMetadata(binding?.metadata),
          repoPath: binding?.repoPath,
        },
      },
      deps,
    );

    return await handleConfigCommand({
      parsed: parsedConfigCommand,
      binding,
      rolePolicyState,
      provider,
      context,
      deps,
    });
  }

  if (subcommand === "role") {
    const parsedRoleCommand = parseRoleCommandArgs(rest);
    const binding = boundConversation;

    await resolveAuthorization(
      {
        action: parsedRoleCommand.action === "list" ? "status" : "bind",
        provider,
        conversationKey,
        context,
        requested: {
          projectId: projectIdFromMetadata(binding?.metadata),
          repoPath: binding?.repoPath,
        },
      },
      deps,
    );

    return await handleRoleCommand({
      parsed: parsedRoleCommand,
      binding,
      rolePolicyState,
      provider,
      context,
      deps,
    });
  }

  if (subcommand === "skills") {
    if (!boundConversation) {
      throw new Error(noRepositoryBoundMessage());
    }

    await resolveAuthorization(
      {
        action: "status",
        provider,
        conversationKey,
        context,
        requested: {
          projectId: projectIdFromMetadata(boundConversation.metadata),
          repoPath: boundConversation.repoPath,
        },
      },
      deps,
    );

    const routes = await loadSkillRoutes(deps.config, boundConversation.repoPath);
    const skillsFilePath = resolveSkillsFilePath(deps.config, boundConversation.repoPath);
    const skillsMode = deps.config.skillsMode === "agent" ? "agent" : "rules";
    const skillsDocument = await loadSkillsDocument(deps.config, boundConversation.repoPath);
    if (routes.length === 0) {
      return {
        text: [
          "No skill routes found.",
          `skillsMode: ${skillsMode}`,
          `Configured path: ${skillsFilePath}`,
          skillsDocument
            ? `Detected skills file: ${skillsDocument.filePath}`
            : "Detected skills file: (none found)",
          skillsMode === "agent"
            ? "In agent mode, the configured reasoning backend can interpret natural-language SKILLS.md as long as method/url are present."
            : "Add a skills.md file using markdown sections.",
        ].join("\n"),
      };
    }

    return {
      text: [
        `skillsMode: ${skillsMode}`,
        `Configured path: ${skillsFilePath}`,
        `Detected skills file: ${skillsDocument?.filePath || skillsFilePath}`,
        `Loaded routes: ${routes.length}`,
        ...routes.map((route) => `- ${route.name} -> ${route.http.method} ${route.http.url}`),
      ].join("\n"),
    };
  }

  if (subcommand === "action") {
    if (!boundConversation) {
      throw new Error(noRepositoryBoundMessage());
    }

    const action = parseActionCommandArgs(rest);
    const authorization = await resolveAuthorization(
      {
        action: "ask",
        provider,
        conversationKey,
        context,
        requested: {
          projectId: projectIdFromMetadata(boundConversation.metadata),
          repoPath: boundConversation.repoPath,
        },
      },
      deps,
    );

    enforceProjectAccessForRepo(
      "ask",
      boundConversation.repoPath,
      authorization.decision,
      conversationKey,
    );

    const rolePolicyStateForAction = await loadRolePolicyState(deps.config, boundConversation.repoPath);
    if (!rolePolicyStateForAction.enabled) {
      throw new Error(
        [
          "Role policy is required for action approvals.",
          "Set rolePolicyEnabled=true and add a policy file first.",
        ].join("\n"),
      );
    }

    const policy = enforceProjectPolicyExistsForRepo(rolePolicyStateForAction, boundConversation.repoPath);
    if (!policy) {
      throw new Error(`No policy found for bound repository: ${boundConversation.repoPath}`);
    }

    const actorRole = roleForActionOrThrow({
      policy,
      provider,
      context,
      action: "ask",
      actionLabel: "request external action",
    });

    const canRunExternalApiDirectly = isRoleAllowedForAction(actorRole, policy, "externalApi");
    if (canRunExternalApiDirectly) {
      return await executeExternalActionDirectly({
        deps,
        conversationKey,
        provider,
        repoPath: boundConversation.repoPath,
        actorId,
        actorRole,
        policy,
        actionName: action.name,
        actionSummary: action.summary,
        actionPayload: action.payload,
        sourceLabel: `manual ${PRIMARY_MENTION_ALIAS} action command`,
      });
    }

    return await createExternalActionApproval({
      deps,
      conversationKey,
      provider,
      repoPath: boundConversation.repoPath,
      actorId,
      actorRole,
      policy,
      actionName: action.name,
      actionSummary: action.summary,
      actionPayload: action.payload,
      sourceLabel: `manual ${PRIMARY_MENTION_ALIAS} action command`,
    });
  }

  if (subcommand === "unbind") {
    const binding = boundConversation;

    await resolveAuthorization(
      {
        action: "unbind",
        provider,
        conversationKey,
        context,
        requested: {
          projectId: projectIdFromMetadata(binding?.metadata),
          repoPath: binding?.repoPath,
        },
      },
      deps,
    );

    if (binding) {
      const policy = enforceProjectPolicyExistsForRepo(rolePolicyState, binding.repoPath);
      if (policy) {
        roleForActionOrThrow({
          policy,
          provider,
          context,
          action: "unbind",
          actionLabel: "unbind repository",
        });
      }
    }

    const removed = await deps.store.delete(conversationKey);
    if (removed) {
      await deps.history.clear(conversationKey);
    }
    return removed
      ? { text: `Removed binding for conversation key: ${conversationKey}` }
      : { text: `No binding found for conversation key: ${conversationKey}` };
  }

  const askIntent = inferWriteRequestIntent(subcommand, rest, trimmedArgs);
  const askPrompt = askIntent.prompt;

  if (!askPrompt) {
    if (subcommand === "ask") {
      throw new Error(`Usage: ${PRIMARY_MENTION_ALIAS} ask <prompt>`);
    }
    if (subcommand === "change" || subcommand === "update" || subcommand === "edit" || subcommand === "fix") {
      throw new Error(`Usage: ${PRIMARY_MENTION_ALIAS} ${subcommand} <prompt>`);
    }
    throw new Error("Ask prompt is empty.");
  }

  const binding = boundConversation;
  if (!binding) {
    throw new Error(noRepositoryBoundMessage());
  }

  const authorization = await resolveAuthorization(
    {
      action: "ask",
      provider,
      conversationKey,
      context,
      requested: {
        projectId: projectIdFromMetadata(binding.metadata),
        repoPath: binding.repoPath,
      },
    },
    deps,
  );

  enforceProjectAccessForRepo("ask", binding.repoPath, authorization.decision, conversationKey);

  const rolePolicyStateForAsk = await loadRolePolicyState(deps.config, binding.repoPath);

  if (!rolePolicyStateForAsk.enabled) {
    return await runAskPrompt(askPrompt, conversationKey, deps, {
      binding,
      actorLabel: actorId,
      configOverride: authorization.effectiveConfig,
    });
  }

  const policy = enforceProjectPolicyExistsForRepo(rolePolicyStateForAsk, binding.repoPath);
  if (!policy) {
    throw new Error(`No policy found for bound repository: ${binding.repoPath}`);
  }

  const actorRole = roleForActionOrThrow({
    policy,
    provider,
    context,
    action: "ask",
    actionLabel: "ask question",
  });

  const skillMatch = await resolveSkillMatchForAsk({
    config: applyProjectPolicyRuntimeDefaults(authorization.effectiveConfig, policy),
    deps,
    repoPath: binding.repoPath,
    conversationKey,
    askPrompt,
  });

  if (skillMatch.matched) {
    const actionPayload: Record<string, unknown> = {
      mode: "http",
      method: skillMatch.matched.route.http.method,
      url: skillMatch.matched.route.http.url,
      ...(skillMatch.matched.route.http.headers ? { headers: skillMatch.matched.route.http.headers } : {}),
      ...(skillMatch.matched.route.http.query ? { query: skillMatch.matched.route.http.query } : {}),
      ...(skillMatch.matched.route.response?.field
        ? { response: { field: skillMatch.matched.route.response.field } }
        : {}),
      input: {
        prompt: askPrompt,
        provider,
        conversationKey,
        requestedBy: actorId,
        requestedRole: actorRole,
      },
      metadata: {
        matchReason: skillMatch.matched.reason,
        ...(skillMatch.matched.regexCaptures && skillMatch.matched.regexCaptures.length > 0
          ? { regexCaptures: skillMatch.matched.regexCaptures }
          : {}),
      },
    };

    const canRunExternalApiDirectly = isRoleAllowedForAction(actorRole, policy, "externalApi");
    if (canRunExternalApiDirectly) {
      return await executeExternalActionDirectly({
        deps,
        conversationKey,
        provider,
        repoPath: binding.repoPath,
        actorId,
        actorRole,
        policy,
        actionName: skillMatch.matched.route.name,
        actionSummary: skillMatch.matched.route.description || askPrompt,
        actionPayload,
        sourceLabel: skillMatch.sourceLabel,
      });
    }

    return await createExternalActionApproval({
      deps,
      conversationKey,
      provider,
      repoPath: binding.repoPath,
      actorId,
      actorRole,
      policy,
      actionName: skillMatch.matched.route.name,
      actionSummary: skillMatch.matched.route.description || askPrompt,
      actionPayload,
      sourceLabel: skillMatch.sourceLabel,
    });
  }

  if (!askIntent.writeIntent) {
    return await runAskPrompt(askPrompt, conversationKey, deps, {
      binding,
      actorLabel: actorId,
      configOverride: applyProjectPolicyRuntimeDefaults(authorization.effectiveConfig, policy),
    });
  }

  const ticketRef = extractTicketReference(askPrompt);
  if (detectHeavyChange(askPrompt, policy) && policy.approval?.requireTicketForHeavyChange !== false && !ticketRef) {
    throw new Error(
      "Heavy change detected. Create a Jira/GitHub ticket first and include its reference (e.g. ABC-123 or #123) in your request.",
    );
  }

  const canChange = isRoleAllowedForAction(actorRole, policy, "change");
  if (!canChange) {
    const requiredRole = minRequiredRoleForAction(policy, "change");

    if (!isApprovalEnabled(policy)) {
      throw new Error(
        roleDeniedMessage({
          actionLabel: "request code changes",
          role: actorRole,
          requiredRole,
          suggestApproval: false,
        }),
      );
    }

    const request = await deps.approvals.create({
      conversationKey,
      provider,
      projectId: policy.projectId,
      repoPath: binding.repoPath,
      prompt: askPrompt,
      requestedBy: actorId,
      requestedRole: actorRole,
      requiredRole,
      ticketRef,
      requestType: "codex-change",
    });

    const approverRoleNames = approverRoles(policy).join(", ");

    return {
      text: [
        roleDeniedMessage({
          actionLabel: "request code changes",
          role: actorRole,
          requiredRole,
          suggestApproval: true,
        }),
        `Approval request created: ${request.id}`,
        `Approver roles: ${approverRoleNames}`,
        `Maintainer command: ${PRIMARY_MENTION_ALIAS} approve ${request.id}`,
      ].join("\n"),
    };
  }

  const writeConfig = applyProjectPolicyRuntimeDefaults(
    writeExecutionConfig(authorization.effectiveConfig, authorization.apiReadOnlyForced),
    policy,
  );

  return await runAskPrompt(askPrompt, conversationKey, deps, {
    binding,
    actorLabel: actorId,
    configOverride: writeConfig,
  });
}

export async function runGovern(
  args: string,
  context: ConversationKeyContext,
  deps: GovernDeps,
): Promise<{ text: string }> {
  try {
    return await executeGovernArgs(args, context, deps);
  } catch (error) {
    return { text: `Error: ${formatError(error)}` };
  }
}
