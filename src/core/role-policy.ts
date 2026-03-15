import fs from "node:fs/promises";
import path from "node:path";
import type { PluginConfig } from "../types.js";
import type { ProjectPermissionAction, ProjectPolicy, ProjectRole } from "../types.js";

export const PROJECT_ROLES: readonly ProjectRole[] = ["anyone", "dev", "maintainer", "owner"];

type ProjectPolicyRecord = {
  filePath: string;
  raw: Record<string, unknown>;
  policy: ProjectPolicy;
};

const ROLE_RANK: Record<ProjectRole, number> = {
  anyone: 0,
  dev: 1,
  maintainer: 2,
  owner: 3,
};

const DEFAULT_PERMISSIONS: Record<ProjectPermissionAction, ProjectRole[]> = {
  ask: ["anyone"],
  status: ["anyone"],
  change: ["dev", "maintainer", "owner"],
  bind: ["maintainer", "owner"],
  unbind: ["maintainer", "owner"],
  approve: ["maintainer", "owner"],
  externalApi: ["owner"],
};

const DEFAULT_HEAVY_KEYWORDS = [
  "architecture",
  "breaking change",
  "data migration",
  "database schema",
  "end-to-end",
  "large refactor",
  "migration",
  "multi-file",
  "multiple files",
  "redesign",
  "rewrite",
];

type PolicyLoadOptions = {
  repoPathHint?: string;
};

type PolicyNormalizeContext = {
  policyDir?: string;
  filePath?: string;
  repoPathHint?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function parseProjectRole(value: unknown): ProjectRole | undefined {
  if (typeof value !== "string") return undefined;
  const lowered = value.trim().toLowerCase();
  if (lowered === "anyone" || lowered === "dev" || lowered === "maintainer" || lowered === "owner") {
    return lowered;
  }
  return undefined;
}

function asRoleList(value: unknown, fallback: ProjectRole[]): ProjectRole[] {
  const raw = Array.isArray(value) ? value : [];
  const roles = raw
    .map((item) => parseProjectRole(item))
    .filter((item): item is ProjectRole => Boolean(item));
  return roles.length > 0 ? roles : fallback;
}

function normalizeRepoPath(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
}

function normalizePrincipal(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const separator = trimmed.indexOf(":");
  if (separator <= 0) return trimmed;

  const provider = trimmed.slice(0, separator).toLowerCase();
  const rest = trimmed.slice(separator + 1);
  return `${provider}:${rest}`;
}

function normalizeEmail(rawEmail: string | undefined): string | undefined {
  if (!rawEmail) return undefined;
  const lowered = rawEmail.trim().toLowerCase();
  if (!lowered || !lowered.includes("@")) return undefined;
  return lowered;
}

function inferRepoPathFromPolicyDir(policyDir: string | undefined): string | undefined {
  if (!policyDir) return undefined;
  const resolvedDir = path.resolve(policyDir);
  const policiesDirName = path.basename(resolvedDir).toLowerCase();
  if (policiesDirName !== "policies") return undefined;
  const pluginDir = path.dirname(resolvedDir);
  const pluginDirName = path.basename(pluginDir);
  if (pluginDirName !== ".hiveping") return undefined;
  return path.dirname(pluginDir);
}

function inferRepoPathFromPolicyFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  return inferRepoPathFromPolicyDir(path.dirname(filePath));
}

function inferProjectId(repoPath: string | undefined, filePath: string | undefined): string | undefined {
  if (repoPath) {
    const base = path.basename(normalizeRepoPath(repoPath));
    if (base) {
      return base;
    }
  }

  if (!filePath) {
    return undefined;
  }

  const stem = path.basename(filePath, path.extname(filePath)).trim();
  return stem || undefined;
}

function normalizePolicy(raw: unknown, context: PolicyNormalizeContext = {}): ProjectPolicy | undefined {
  const record = asRecord(raw);
  const repoPath =
    asString(record.repoPath) ||
    asString(context.repoPathHint) ||
    inferRepoPathFromPolicyDir(context.policyDir) ||
    inferRepoPathFromPolicyFile(context.filePath);
  const projectId = asString(record.projectId) || inferProjectId(repoPath, context.filePath);
  if (!projectId || !repoPath) {
    return undefined;
  }

  const permissionsRaw = asRecord(record.permissions);
  const permissions: Partial<Record<ProjectPermissionAction, ProjectRole[]>> = {
    ask: asRoleList(permissionsRaw.ask, DEFAULT_PERMISSIONS.ask),
    status: asRoleList(permissionsRaw.status, DEFAULT_PERMISSIONS.status),
    change: asRoleList(permissionsRaw.change, DEFAULT_PERMISSIONS.change),
    bind: asRoleList(permissionsRaw.bind, DEFAULT_PERMISSIONS.bind),
    unbind: asRoleList(permissionsRaw.unbind, DEFAULT_PERMISSIONS.unbind),
    approve: asRoleList(permissionsRaw.approve, DEFAULT_PERMISSIONS.approve),
    externalApi: asRoleList(permissionsRaw.externalApi, DEFAULT_PERMISSIONS.externalApi),
  };

  const membersRecord = asRecord(record.members);
  const members: Record<string, ProjectRole> = {};
  for (const [principal, roleRaw] of Object.entries(membersRecord)) {
    const role = parseProjectRole(roleRaw);
    if (!role) continue;
    members[normalizePrincipal(principal)] = role;
  }

  const approvalRaw = asRecord(record.approval);
  const requireTicketForHeavyChange = approvalRaw.requireTicketForHeavyChange;
  const enabled = approvalRaw.enabled;
  const defaultModel = asString(record.defaultModel);
  const defaultProfile = asString(record.defaultProfile);

  return {
    version: 1,
    projectId,
    repoPath: normalizeRepoPath(repoPath),
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultProfile ? { defaultProfile } : {}),
    members,
    permissions,
    approval: {
      enabled: typeof enabled === "boolean" ? enabled : true,
      approverRoles: asRoleList(approvalRaw.approverRoles, DEFAULT_PERMISSIONS.approve),
      requireTicketForHeavyChange:
        typeof requireTicketForHeavyChange === "boolean" ? requireTicketForHeavyChange : true,
      heavyKeywords: Array.isArray(approvalRaw.heavyKeywords)
        ? approvalRaw.heavyKeywords
            .map((item) => asString(item))
            .filter((item): item is string => Boolean(item))
        : DEFAULT_HEAVY_KEYWORDS,
    },
  };
}

async function loadProjectPolicyRecords(
  policyDir: string,
  options: PolicyLoadOptions = {},
): Promise<ProjectPolicyRecord[]> {
  const resolvedDir = path.resolve(policyDir);

  let entries: string[];
  try {
    const dirEntries = await fs.readdir(resolvedDir, { withFileTypes: true });
    entries = dirEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(resolvedDir, entry.name));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: ProjectPolicyRecord[] = [];

  for (const filePath of entries) {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const rawRecord = asRecord(parsed);
    const policy = normalizePolicy(rawRecord, {
      policyDir: resolvedDir,
      filePath,
      repoPathHint: options.repoPathHint,
    });
    if (policy) {
      records.push({
        filePath,
        raw: rawRecord,
        policy,
      });
    }
  }

  return records;
}

export async function loadProjectPolicies(
  policyDir: string,
  options: PolicyLoadOptions = {},
): Promise<ProjectPolicy[]> {
  const records = await loadProjectPolicyRecords(policyDir, options);
  return records.map((record) => record.policy);
}

export function resolvePolicyByRepoPath(
  policies: readonly ProjectPolicy[],
  repoPath: string,
): ProjectPolicy | undefined {
  const normalized = normalizeRepoPath(repoPath);
  return policies.find((policy) => normalizeRepoPath(policy.repoPath) === normalized);
}

export function resolvePolicyByProjectId(
  policies: readonly ProjectPolicy[],
  projectId: string,
): ProjectPolicy | undefined {
  const normalized = projectId.trim().toLowerCase();
  return policies.find((policy) => policy.projectId.trim().toLowerCase() === normalized);
}

export function roleForPrincipal(
  policy: ProjectPolicy | undefined,
  provider: string,
  rawPrincipal: string | undefined,
  rawEmail?: string,
  rawUsername?: string,
): ProjectRole {
  if (!policy || !policy.members || Object.keys(policy.members).length === 0) {
    return "anyone";
  }

  const candidates = Array.from(
    new Set([
      ...principalCandidates(provider, rawPrincipal),
      ...usernameCandidates(provider, rawUsername),
      ...emailCandidates(provider, rawEmail),
    ]),
  );

  const members = policy.members;

  for (const candidate of candidates) {
    const role = members[candidate];
    if (role) return role;
  }

  const caseInsensitiveMap = new Map<string, ProjectRole>();
  for (const [principal, role] of Object.entries(members)) {
    caseInsensitiveMap.set(principal.toLowerCase(), role);
  }

  for (const candidate of candidates) {
    const role = caseInsensitiveMap.get(candidate.toLowerCase());
    if (role) return role;
  }

  return "anyone";
}

function normalizeEmailMemberKey(rawMember: string): string | undefined {
  const trimmed = rawMember.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.toLowerCase().startsWith("email:")) {
    const normalized = normalizeEmail(trimmed.slice("email:".length));
    return normalized ? `email:${normalized}` : undefined;
  }

  const normalized = normalizeEmail(trimmed);
  return normalized ? `email:${normalized}` : undefined;
}

function normalizeMentionToken(rawMember: string): string {
  const trimmed = rawMember.trim();
  const mentionMatch = trimmed.match(/^<@!?([^>]+)>$/);
  return mentionMatch?.[1]?.trim() || trimmed;
}

export function normalizeMemberKeyForPolicy(provider: string, rawMember: string): string {
  const normalizedProvider = provider.trim().toLowerCase() || "unknown";
  const mentionNormalized = normalizeMentionToken(rawMember);
  const emailKey = normalizeEmailMemberKey(mentionNormalized);

  if (emailKey) {
    return emailKey;
  }

  if (!mentionNormalized) {
    throw new Error("Member key is empty.");
  }

  if (mentionNormalized.includes(":")) {
    return normalizePrincipal(mentionNormalized);
  }

  return normalizePrincipal(`${normalizedProvider}:${mentionNormalized}`);
}

async function resolvePolicyRecordByRepoPath(
  policyDir: string,
  repoPath: string,
): Promise<ProjectPolicyRecord | undefined> {
  const records = await loadProjectPolicyRecords(policyDir, { repoPathHint: repoPath });
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  return records.find((record) => normalizeRepoPath(record.policy.repoPath) === normalizedRepoPath);
}

async function writeProjectPolicyRecord(
  filePath: string,
  record: Record<string, unknown>,
  options: PolicyLoadOptions = {},
): Promise<ProjectPolicy> {
  const policy = normalizePolicy(record, {
    policyDir: path.dirname(filePath),
    filePath,
    repoPathHint: options.repoPathHint,
  });
  if (!policy) {
    throw new Error(`Policy file is invalid and cannot be written: ${filePath}`);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return policy;
}

export async function setProjectMemberRole(params: {
  policyDir: string;
  repoPath: string;
  provider: string;
  memberKey: string;
  role: ProjectRole;
}): Promise<{ policy: ProjectPolicy; normalizedMemberKey: string }> {
  const policyRecord = await resolvePolicyRecordByRepoPath(params.policyDir, params.repoPath);
  if (!policyRecord) {
    throw new Error(`No project policy found for repository: ${params.repoPath}`);
  }

  const normalizedMemberKey = normalizeMemberKeyForPolicy(params.provider, params.memberKey);
  const members = asRecord(policyRecord.raw.members);
  members[normalizedMemberKey] = params.role;
  policyRecord.raw.members = members;

  const policy = await writeProjectPolicyRecord(policyRecord.filePath, policyRecord.raw, {
    repoPathHint: params.repoPath,
  });
  return { policy, normalizedMemberKey };
}

export async function removeProjectMemberRole(params: {
  policyDir: string;
  repoPath: string;
  provider: string;
  memberKey: string;
}): Promise<{ policy: ProjectPolicy; normalizedMemberKey: string; removed: boolean }> {
  const policyRecord = await resolvePolicyRecordByRepoPath(params.policyDir, params.repoPath);
  if (!policyRecord) {
    throw new Error(`No project policy found for repository: ${params.repoPath}`);
  }

  const normalizedMemberKey = normalizeMemberKeyForPolicy(params.provider, params.memberKey);
  const members = asRecord(policyRecord.raw.members);
  const removed = Object.prototype.hasOwnProperty.call(members, normalizedMemberKey);

  if (removed) {
    delete members[normalizedMemberKey];
  }

  policyRecord.raw.members = members;
  const policy = await writeProjectPolicyRecord(policyRecord.filePath, policyRecord.raw, {
    repoPathHint: params.repoPath,
  });
  return { policy, normalizedMemberKey, removed };
}

export function applyProjectPolicyRuntimeDefaults(
  config: PluginConfig,
  policy: ProjectPolicy | undefined,
): PluginConfig {
  if (!policy) {
    return config;
  }

  return {
    ...config,
    ...(policy.defaultModel ? { defaultModel: policy.defaultModel } : {}),
    ...(policy.defaultProfile ? { defaultProfile: policy.defaultProfile } : {}),
  };
}

export function allowedRolesForAction(
  policy: ProjectPolicy | undefined,
  action: ProjectPermissionAction,
): ProjectRole[] {
  if (!policy?.permissions?.[action] || policy.permissions[action]!.length === 0) {
    return [...DEFAULT_PERMISSIONS[action]];
  }
  return [...policy.permissions[action]!];
}

export function minRequiredRoleForAction(
  policy: ProjectPolicy | undefined,
  action: ProjectPermissionAction,
): ProjectRole {
  const roles = allowedRolesForAction(policy, action);
  if (roles.includes("anyone")) return "anyone";

  let minRole: ProjectRole = "owner";
  for (const role of roles) {
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
      minRole = role;
    }
  }
  return minRole;
}

export function isRoleAllowedForAction(
  role: ProjectRole,
  policy: ProjectPolicy | undefined,
  action: ProjectPermissionAction,
): boolean {
  const allowedRoles = allowedRolesForAction(policy, action);

  if (allowedRoles.includes("anyone")) {
    return true;
  }

  return allowedRoles.some((allowedRole) => ROLE_RANK[role] >= ROLE_RANK[allowedRole]);
}

export function approverRoles(policy: ProjectPolicy | undefined): ProjectRole[] {
  if (policy?.approval?.approverRoles && policy.approval.approverRoles.length > 0) {
    return [...policy.approval.approverRoles];
  }
  return [...DEFAULT_PERMISSIONS.approve];
}

export function principalCandidates(provider: string, rawPrincipal: string | undefined): string[] {
  const normalizedProvider = provider.trim().toLowerCase() || "unknown";
  const raw = (rawPrincipal || "").trim();
  if (!raw) {
    return [`${normalizedProvider}:unknown`, "unknown"];
  }

  const candidates = new Set<string>();
  candidates.add(raw);
  candidates.add(normalizePrincipal(raw));

  if (!raw.toLowerCase().startsWith(`${normalizedProvider}:`)) {
    candidates.add(`${normalizedProvider}:${raw}`);
  }

  const withoutProvider = raw.toLowerCase().startsWith(`${normalizedProvider}:`)
    ? raw.slice(normalizedProvider.length + 1)
    : raw;

  candidates.add(withoutProvider);
  candidates.add(`${normalizedProvider}:${withoutProvider}`);

  if (withoutProvider.toLowerCase().startsWith("user:")) {
    const token = withoutProvider.slice("user:".length).trim();
    if (token) {
      candidates.add(token);
      candidates.add(`${normalizedProvider}:${token}`);
    }
  }

  const parts = withoutProvider.split(":").filter((item) => item.length > 0);
  const trailing = parts.length > 0 ? parts[parts.length - 1] : "";
  if (trailing) {
    candidates.add(trailing);
    candidates.add(`${normalizedProvider}:${trailing}`);
  }

  return Array.from(candidates)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => normalizePrincipal(value));
}

export function emailCandidates(provider: string, rawEmail: string | undefined): string[] {
  const normalizedProvider = provider.trim().toLowerCase() || "unknown";
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return [];
  }

  const candidates = new Set<string>();
  candidates.add(email);
  candidates.add(`email:${email}`);
  candidates.add(`${normalizedProvider}:${email}`);
  candidates.add(`${normalizedProvider}:email:${email}`);

  return Array.from(candidates)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => normalizePrincipal(value));
}

export function usernameCandidates(provider: string, rawUsername: string | undefined): string[] {
  const normalizedProvider = provider.trim().toLowerCase() || "unknown";
  const username = rawUsername?.trim();
  if (!username) {
    return [];
  }

  const compact = username.startsWith("@") ? username.slice(1).trim() : username;
  if (!compact) {
    return [];
  }

  const candidates = new Set<string>();
  candidates.add(compact);
  candidates.add(`username:${compact}`);
  candidates.add(`${normalizedProvider}:${compact}`);
  candidates.add(`${normalizedProvider}:username:${compact}`);

  if (compact.includes(":")) {
    candidates.add(compact);
  }

  return Array.from(candidates)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => normalizePrincipal(value));
}

export function extractTicketReference(prompt: string): string | undefined {
  const jiraMatch = prompt.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/);
  if (jiraMatch?.[0]) {
    return jiraMatch[0];
  }

  const githubIssueMatch = prompt.match(/#\d+/);
  if (githubIssueMatch?.[0]) {
    return githubIssueMatch[0];
  }

  const issueUrlMatch = prompt.match(/https?:\/\/\S*(?:\/issues\/\d+|\/pull\/\d+)\S*/i);
  if (issueUrlMatch?.[0]) {
    return issueUrlMatch[0];
  }

  const jiraUrlMatch = prompt.match(/https?:\/\/\S*jira\S*/i);
  if (jiraUrlMatch?.[0]) {
    return jiraUrlMatch[0];
  }

  return undefined;
}

export function hasTicketReference(prompt: string): boolean {
  return Boolean(extractTicketReference(prompt));
}

export function detectWriteIntent(prompt: string): boolean {
  const writeVerbPattern =
    /\b(add|apply|change|create|delete|edit|fix|implement|improve|modify|patch|refactor|remove|rename|rewrite|update)\b/i;
  return writeVerbPattern.test(prompt);
}

export function detectHeavyChange(prompt: string, policy: ProjectPolicy | undefined): boolean {
  const lowered = prompt.toLowerCase();

  const keywords =
    policy?.approval?.heavyKeywords && policy.approval.heavyKeywords.length > 0
      ? policy.approval.heavyKeywords
      : DEFAULT_HEAVY_KEYWORDS;

  if (keywords.some((keyword) => lowered.includes(keyword.toLowerCase()))) {
    return true;
  }

  if (/\b(entire|whole|all files|across the repo|across repository)\b/i.test(prompt)) {
    return true;
  }

  return prompt.length >= 420;
}

export function isApprovalEnabled(policy: ProjectPolicy | undefined): boolean {
  if (!policy) return false;
  return policy.approval?.enabled !== false;
}
