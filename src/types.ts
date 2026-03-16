export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicyMode = "untrusted" | "on-request" | "never";
export type SkillRoutingMode = "rules" | "agent";
export type ApprovalGrantScope = "requester" | "all";

export type AgentProfile = {
  id: string;
  aliases?: string[];
  mentionIds?: string[];
  allowedChannels?: string[];
  repoPath: string;
  homeConversationKey: string;
};

export type PluginConfig = {
  openclawCommand?: string;
  codexCommand?: string;
  reasoningCommand?: string;
  reasoningArgs?: string[];
  reasoningToolName?: string;
  bindingsFile?: string;
  runtimeConfigFile?: string;
  allowedRoots?: string[];
  mentionHookEnabled?: boolean;
  mentionAliases?: string[];
  agents?: AgentProfile[];
  defaultSandbox?: SandboxMode;
  defaultApprovalPolicy?: ApprovalPolicyMode;
  defaultModel?: string;
  defaultProfile?: string;
  organizationName?: string;
  configApiUrl?: string;
  configApiToken?: string;
  configApiTimeoutMs?: number;
  rolePolicyEnabled?: boolean;
  rolePolicyDir?: string;
  skillsFile?: string;
  skillsMode?: SkillRoutingMode;
  approvalRequestsFile?: string;
  changeSandbox?: "workspace-write" | "danger-full-access";
  changeApprovalPolicy?: ApprovalPolicyMode;
  actionWebhookUrl?: string;
  actionWebhookToken?: string;
  actionWebhookTimeoutMs?: number;
};

export type GovernAction = "bind" | "ask" | "status" | "unbind";

export type BindingMetadata = Record<string, string>;

export type ConversationBinding = {
  repoPath: string;
  metadata?: BindingMetadata;
  provider: string;
  updatedAt: string;
};

export type BindingFile = {
  version: 1;
  bindings: Record<string, ConversationBinding>;
};

export type ConversationKeyContext = {
  channel?: string;
  channelId?: string;
  from?: string;
  to?: string;
  accountId?: string;
  messageThreadId?: string | number;
  conversationId?: string;
  userDisplayName?: string;
  userUsername?: string;
  userEmail?: string;
};

export type ProjectRole = "anyone" | "dev" | "maintainer" | "owner";
export type ProjectPermissionAction =
  | "ask"
  | "status"
  | "change"
  | "bind"
  | "unbind"
  | "approve"
  | "externalApi";

export type ProjectPolicy = {
  version: 1;
  projectId: string;
  repoPath: string;
  defaultModel?: string;
  defaultProfile?: string;
  members?: Record<string, ProjectRole>;
  permissions?: Partial<Record<ProjectPermissionAction, ProjectRole[]>>;
  approval?: {
    enabled?: boolean;
    approverRoles?: ProjectRole[];
    requireTicketForHeavyChange?: boolean;
    heavyKeywords?: string[];
  };
};

export type ApprovalRequest = {
  id: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
  conversationKey: string;
  provider: string;
  projectId: string;
  repoPath: string;
  prompt: string;
  requestedBy: string;
  agentId?: string;
  historyConversationKey?: string;
  requestedRole: ProjectRole;
  requiredRole: ProjectRole;
  ticketRef?: string;
  decisionBy?: string;
  decisionReason?: string;
  requestType?: "codex-change" | "external-action" | "webhook-action";
  externalAction?: {
    name: string;
    payload: Record<string, unknown>;
    summary?: string;
  };
};

export type ApprovalFile = {
  version: 1;
  requests: Record<string, ApprovalRequest>;
};

export type ApprovalGrant = {
  id: string;
  status: "active" | "revoked" | "exhausted";
  createdAt: string;
  updatedAt: string;
  projectId: string;
  repoPath: string;
  actionName: string;
  agentId?: string;
  scope: ApprovalGrantScope;
  grantedTo?: string;
  remainingUses?: number;
  expiresAt?: string;
  sourceRequestId?: string;
  createdBy: string;
  revokedAt?: string;
  revokedBy?: string;
  revokedReason?: string;
};

export type ApprovalGrantFile = {
  version: 1;
  grants: Record<string, ApprovalGrant>;
};
