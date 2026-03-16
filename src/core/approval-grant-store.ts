import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ApprovalGrant, ApprovalGrantFile, ApprovalGrantScope } from "../types.js";

function copyGrant(grant: ApprovalGrant): ApprovalGrant {
  return { ...grant };
}

function normalizeIsoDate(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeScope(value: unknown): ApprovalGrantScope | undefined {
  return value === "requester" || value === "all" ? value : undefined;
}

function normalizeGrant(raw: unknown): ApprovalGrant | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const scope = normalizeScope(value.scope);
  if (
    typeof value.id !== "string" ||
    typeof value.status !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.repoPath !== "string" ||
    typeof value.actionName !== "string" ||
    typeof value.createdBy !== "string" ||
    !scope
  ) {
    return undefined;
  }

  if (value.status !== "active" && value.status !== "revoked" && value.status !== "exhausted") {
    return undefined;
  }

  const remainingUses = Number(value.remainingUses);
  const normalizedRemainingUses =
    Number.isFinite(remainingUses) && remainingUses >= 0 ? Math.floor(remainingUses) : undefined;

  return {
    id: value.id,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    projectId: value.projectId,
    repoPath: value.repoPath,
    actionName: value.actionName,
    agentId: typeof value.agentId === "string" ? value.agentId : undefined,
    scope,
    grantedTo: typeof value.grantedTo === "string" ? value.grantedTo : undefined,
    remainingUses: normalizedRemainingUses,
    expiresAt: normalizeIsoDate(value.expiresAt),
    sourceRequestId: typeof value.sourceRequestId === "string" ? value.sourceRequestId : undefined,
    createdBy: value.createdBy,
    revokedAt: normalizeIsoDate(value.revokedAt),
    revokedBy: typeof value.revokedBy === "string" ? value.revokedBy : undefined,
    revokedReason: typeof value.revokedReason === "string" ? value.revokedReason : undefined,
  };
}

function grantId(): string {
  return `grant_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeActionName(actionName: string): string {
  return actionName.trim().toLowerCase();
}

function isExpired(grant: ApprovalGrant, now = Date.now()): boolean {
  if (!grant.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(grant.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function isActiveGrant(grant: ApprovalGrant, now = Date.now()): boolean {
  if (grant.status !== "active") {
    return false;
  }
  if (typeof grant.remainingUses === "number" && grant.remainingUses <= 0) {
    return false;
  }
  return !isExpired(grant, now);
}

export class ApprovalGrantStore {
  private grants = new Map<string, ApprovalGrant>();
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

    let parsed: ApprovalGrantFile | null = null;
    try {
      parsed = JSON.parse(raw) as ApprovalGrantFile;
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object" || typeof parsed.grants !== "object" || !parsed.grants) {
      return;
    }

    for (const [id, value] of Object.entries(parsed.grants)) {
      const normalized = normalizeGrant({ id, ...value });
      if (!normalized) continue;
      this.grants.set(id, normalized);
    }
  }

  private async persist(): Promise<void> {
    const payload: ApprovalGrantFile = {
      version: 1,
      grants: Object.fromEntries(Array.from(this.grants.entries()).map(([id, grant]) => [id, copyGrant(grant)])),
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
  }): Promise<ApprovalGrant> {
    await this.ensureLoaded();

    const now = new Date().toISOString();
    const grant: ApprovalGrant = {
      id: grantId(),
      status: "active",
      createdAt: now,
      updatedAt: now,
      projectId: input.projectId,
      repoPath: input.repoPath,
      actionName: normalizeActionName(input.actionName),
      agentId: input.agentId,
      scope: input.scope,
      grantedTo: input.scope === "requester" ? input.grantedTo : undefined,
      remainingUses:
        typeof input.remainingUses === "number" && Number.isFinite(input.remainingUses)
          ? Math.max(1, Math.floor(input.remainingUses))
          : undefined,
      expiresAt: input.expiresAt,
      sourceRequestId: input.sourceRequestId,
      createdBy: input.createdBy,
    };

    this.grants.set(grant.id, grant);
    await this.queuePersist();
    return copyGrant(grant);
  }

  async get(id: string): Promise<ApprovalGrant | undefined> {
    await this.ensureLoaded();
    const grant = this.grants.get(id);
    return grant ? copyGrant(grant) : undefined;
  }

  async listActive(filters?: {
    repoPath?: string;
    actionName?: string;
    agentId?: string;
  }): Promise<ApprovalGrant[]> {
    await this.ensureLoaded();

    return Array.from(this.grants.values())
      .filter((grant) => isActiveGrant(grant))
      .filter((grant) => (filters?.repoPath ? grant.repoPath === filters.repoPath : true))
      .filter((grant) =>
        filters?.actionName ? grant.actionName === normalizeActionName(filters.actionName) : true,
      )
      .filter((grant) => (typeof filters?.agentId === "string" ? grant.agentId === filters.agentId : true))
      .map((grant) => copyGrant(grant));
  }

  async consumeMatching(input: {
    repoPath: string;
    actionName: string;
    requestedBy: string;
    agentId?: string;
  }): Promise<ApprovalGrant | undefined> {
    await this.ensureLoaded();

    const actionName = normalizeActionName(input.actionName);
    const now = Date.now();
    const candidates = Array.from(this.grants.values())
      .filter((grant) => grant.repoPath === input.repoPath)
      .filter((grant) => grant.actionName === actionName)
      .filter((grant) => (grant.agentId ? grant.agentId === input.agentId : true))
      .filter((grant) => (grant.scope === "requester" ? grant.grantedTo === input.requestedBy : true))
      .filter((grant) => isActiveGrant(grant, now))
      .sort((left, right) => {
        if (left.scope !== right.scope) {
          return left.scope === "requester" ? -1 : 1;
        }
        if (Boolean(left.agentId) !== Boolean(right.agentId)) {
          return left.agentId ? -1 : 1;
        }
        return left.createdAt.localeCompare(right.createdAt);
      });

    const grant = candidates[0];
    if (!grant) {
      return undefined;
    }

    if (typeof grant.remainingUses === "number") {
      grant.remainingUses = Math.max(0, grant.remainingUses - 1);
      if (grant.remainingUses === 0) {
        grant.status = "exhausted";
      }
    }
    grant.updatedAt = new Date().toISOString();

    await this.queuePersist();
    return copyGrant(grant);
  }

  async revokeById(input: {
    id: string;
    revokedBy: string;
    revokedReason?: string;
  }): Promise<ApprovalGrant | undefined> {
    await this.ensureLoaded();
    const grant = this.grants.get(input.id);
    if (!grant) {
      return undefined;
    }
    grant.status = "revoked";
    grant.updatedAt = new Date().toISOString();
    grant.revokedAt = grant.updatedAt;
    grant.revokedBy = input.revokedBy;
    if (input.revokedReason?.trim()) {
      grant.revokedReason = input.revokedReason.trim();
    }
    await this.queuePersist();
    return copyGrant(grant);
  }

  async revokeMatching(input: {
    repoPath?: string;
    actionName?: string;
    sourceRequestId?: string;
    agentId?: string;
    scope?: ApprovalGrantScope;
    grantedTo?: string;
    revokedBy: string;
    revokedReason?: string;
  }): Promise<ApprovalGrant[]> {
    await this.ensureLoaded();

    const normalizedActionName = input.actionName ? normalizeActionName(input.actionName) : undefined;
    const revoked: ApprovalGrant[] = [];

    for (const grant of this.grants.values()) {
      if (!isActiveGrant(grant)) {
        continue;
      }
      if (input.repoPath && grant.repoPath !== input.repoPath) {
        continue;
      }
      if (normalizedActionName && grant.actionName !== normalizedActionName) {
        continue;
      }
      if (input.sourceRequestId && grant.sourceRequestId !== input.sourceRequestId) {
        continue;
      }
      if (typeof input.agentId === "string" && grant.agentId !== input.agentId) {
        continue;
      }
      if (input.scope && grant.scope !== input.scope) {
        continue;
      }
      if (input.grantedTo && grant.grantedTo !== input.grantedTo) {
        continue;
      }

      grant.status = "revoked";
      grant.updatedAt = new Date().toISOString();
      grant.revokedAt = grant.updatedAt;
      grant.revokedBy = input.revokedBy;
      if (input.revokedReason?.trim()) {
        grant.revokedReason = input.revokedReason.trim();
      }
      revoked.push(copyGrant(grant));
    }

    if (revoked.length > 0) {
      await this.queuePersist();
    }
    return revoked;
  }
}
