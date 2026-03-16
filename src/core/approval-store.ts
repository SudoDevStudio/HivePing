import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ApprovalFile, ApprovalRequest, ProjectRole } from "../types.js";

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function copyRequest(request: ApprovalRequest): ApprovalRequest {
  return {
    ...request,
    externalAction: request.externalAction
      ? {
          ...request.externalAction,
          payload: cloneJsonRecord(request.externalAction.payload),
        }
      : undefined,
  };
}

function normalizeLegacyWebhookAction(value: Record<string, unknown>): ApprovalRequest["externalAction"] | undefined {
  if (value.kind !== "issue.create") {
    return undefined;
  }

  const tracker = typeof value.tracker === "string" ? value.tracker.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const labels = Array.isArray(value.labels)
    ? value.labels
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0)
    : [];

  if (!tracker || !title || !description) {
    return undefined;
  }

  return {
    name: "issue.create",
    summary: `${tracker}: ${title}`,
    payload: {
      tracker,
      title,
      description,
      ...(labels.length > 0 ? { labels } : {}),
    },
  };
}

function normalizeExternalAction(raw: unknown): ApprovalRequest["externalAction"] | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const legacy = normalizeLegacyWebhookAction(value);
  if (legacy) {
    return legacy;
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) {
    return undefined;
  }

  const payloadRaw = value.payload;
  if (!payloadRaw || typeof payloadRaw !== "object" || Array.isArray(payloadRaw)) {
    return undefined;
  }

  const payload = cloneJsonRecord(payloadRaw as Record<string, unknown>);
  const summary = typeof value.summary === "string" && value.summary.trim().length > 0
    ? value.summary.trim()
    : undefined;

  return {
    name,
    payload,
    summary,
  };
}

function normalizeRequest(raw: unknown): ApprovalRequest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;

  if (
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.conversationKey !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.repoPath !== "string" ||
    typeof value.prompt !== "string" ||
    typeof value.requestedBy !== "string" ||
    typeof value.requestedRole !== "string" ||
    typeof value.requiredRole !== "string" ||
    typeof value.status !== "string"
  ) {
    return undefined;
  }

  if (value.status !== "pending" && value.status !== "approved" && value.status !== "rejected") {
    return undefined;
  }

  return {
    id: value.id,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    conversationKey: value.conversationKey,
    provider: value.provider,
    projectId: value.projectId,
    repoPath: value.repoPath,
    prompt: value.prompt,
    requestedBy: value.requestedBy,
    agentId: typeof value.agentId === "string" ? value.agentId : undefined,
    historyConversationKey:
      typeof value.historyConversationKey === "string" ? value.historyConversationKey : undefined,
    requestedRole: value.requestedRole as ProjectRole,
    requiredRole: value.requiredRole as ProjectRole,
    ticketRef: typeof value.ticketRef === "string" ? value.ticketRef : undefined,
    decisionBy: typeof value.decisionBy === "string" ? value.decisionBy : undefined,
    decisionReason: typeof value.decisionReason === "string" ? value.decisionReason : undefined,
    requestType:
      value.requestType === "codex-change"
        ? "codex-change"
        : value.requestType === "external-action" || value.requestType === "webhook-action"
          ? "external-action"
          : "codex-change",
    externalAction: normalizeExternalAction(value.externalAction ?? value.webhookAction),
  };
}

function requestId(): string {
  return `appr_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

export class ApprovalStore {
  private requests = new Map<string, ApprovalRequest>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk().finally(() => {
        this.loaded = true;
      });
    }

    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    let raw: string;

    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    let parsed: ApprovalFile | null = null;
    try {
      parsed = JSON.parse(raw) as ApprovalFile;
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object" || typeof parsed.requests !== "object" || !parsed.requests) {
      return;
    }

    for (const [id, value] of Object.entries(parsed.requests)) {
      const normalized = normalizeRequest({ id, ...value });
      if (!normalized) continue;
      this.requests.set(id, normalized);
    }
  }

  private async persist(): Promise<void> {
    const payload: ApprovalFile = {
      version: 1,
      requests: Object.fromEntries(
        Array.from(this.requests.entries()).map(([id, request]) => [id, copyRequest(request)]),
      ),
    };

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.filePath);
  }

  private queuePersist(): Promise<void> {
    const writePromise = this.writeChain.then(() => this.persist());
    this.writeChain = writePromise.catch(() => {});
    return writePromise;
  }

  async create(input: {
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
    requestType?: "codex-change" | "external-action";
    externalAction?: ApprovalRequest["externalAction"];
  }): Promise<ApprovalRequest> {
    await this.ensureLoaded();

    const now = new Date().toISOString();
    const id = requestId();

    const request: ApprovalRequest = {
      id,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      conversationKey: input.conversationKey,
      provider: input.provider,
      projectId: input.projectId,
      repoPath: input.repoPath,
      prompt: input.prompt,
      requestedBy: input.requestedBy,
      agentId: input.agentId,
      historyConversationKey: input.historyConversationKey,
      requestedRole: input.requestedRole,
      requiredRole: input.requiredRole,
      ticketRef: input.ticketRef,
      requestType: input.requestType || "codex-change",
      externalAction: normalizeExternalAction(input.externalAction),
    };

    this.requests.set(id, request);
    await this.queuePersist();
    return copyRequest(request);
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    await this.ensureLoaded();
    const request = this.requests.get(id);
    return request ? copyRequest(request) : undefined;
  }

  async listPending(conversationKey?: string): Promise<ApprovalRequest[]> {
    await this.ensureLoaded();
    return Array.from(this.requests.values())
      .filter((request) => request.status === "pending")
      .filter((request) => (conversationKey ? request.conversationKey === conversationKey : true))
      .map((request) => copyRequest(request));
  }

  async decide(input: {
    id: string;
    status: "approved" | "rejected";
    decisionBy: string;
    decisionReason?: string;
  }): Promise<ApprovalRequest | undefined> {
    await this.ensureLoaded();

    const request = this.requests.get(input.id);
    if (!request) {
      return undefined;
    }

    request.status = input.status;
    request.updatedAt = new Date().toISOString();
    request.decisionBy = input.decisionBy;
    if (typeof input.decisionReason === "string" && input.decisionReason.trim().length > 0) {
      request.decisionReason = input.decisionReason.trim();
    }

    this.requests.set(input.id, request);
    await this.queuePersist();
    return copyRequest(request);
  }
}
