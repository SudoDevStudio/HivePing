import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApprovalGrantStore } from "../../core/approval-grant-store.js";
import { ApprovalStore } from "../../core/approval-store.js";
import { BindingStore } from "../../core/binding-store.js";
import { HistoryStore } from "../../core/history-store.js";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("BindingStore persists bindings across instances", async () => {
  const dir = await makeTempDir("hiveping-bindings-");

  try {
    const filePath = path.join(dir, "bindings.json");
    const key = "discord:123:456";
    const expectedBinding = {
      repoPath: path.join(dir, "repo"),
      metadata: { projectId: "project-account", env: "test" },
      provider: "discord",
      updatedAt: "2026-03-11T00:00:00.000Z",
    };

    const store = new BindingStore(filePath);
    await store.set(key, expectedBinding);

    assert.deepEqual(await store.get(key), expectedBinding);

    const reloaded = new BindingStore(filePath);
    assert.deepEqual(await reloaded.get(key), expectedBinding);

    assert.equal(await reloaded.delete(key), true);
    assert.equal(await reloaded.get(key), undefined);

    const afterDelete = new BindingStore(filePath);
    assert.equal(await afterDelete.get(key), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("HistoryStore trims to max entries and persists clear", async () => {
  const dir = await makeTempDir("hiveping-history-");

  try {
    const filePath = path.join(dir, "history.json");
    const key = "slack:T1:C1";
    const store = new HistoryStore(filePath);

    await store.append({ conversationKey: key, role: "user", content: "one", maxEntries: 3 });
    await store.append({ conversationKey: key, role: "assistant", content: "two", maxEntries: 3 });
    await store.append({
      conversationKey: key,
      role: "user",
      content: "x".repeat(8_200),
      maxEntries: 3,
    });
    await store.append({ conversationKey: key, role: "assistant", content: "four", maxEntries: 3 });

    const recent = await store.recent(key, 10);

    assert.equal(recent.length, 3);
    assert.deepEqual(
      recent.map((entry) => entry.role),
      ["assistant", "user", "assistant"],
    );
    assert.equal(recent[0]?.content, "two");
    assert.match(recent[1]?.content ?? "", /\[truncated\]$/);
    assert.equal(recent[2]?.content, "four");

    await store.clear(key);
    assert.deepEqual(await store.recent(key, 10), []);

    const reloaded = new HistoryStore(filePath);
    assert.deepEqual(await reloaded.recent(key, 10), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ApprovalStore creates, lists, decides, and reloads requests", async () => {
  const dir = await makeTempDir("hiveping-approvals-");

  try {
    const filePath = path.join(dir, "approval-requests.json");
    const store = new ApprovalStore(filePath);

    const request = await store.create({
      conversationKey: "msteams:tenant-1:conversation-1",
      provider: "msteams",
      projectId: "account-service",
      repoPath: path.join(dir, "repo"),
      prompt: "update retry logic",
      requestedBy: "msteams:user-1",
      requestedRole: "dev",
      requiredRole: "maintainer",
      ticketRef: "ABC-123",
      requestType: "external-action",
      externalAction: {
        name: "issue.create",
        summary: "Retry policy bug",
        payload: {
          tracker: "github",
          title: "Retry policy bug",
          description: "Retries are not capped for 5xx responses",
          labels: ["bug", "backend"],
        },
      },
    });

    assert.match(request.id, /^appr_/);
    assert.equal(request.status, "pending");
    assert.equal(request.requestType, "external-action");
    assert.equal(request.externalAction?.name, "issue.create");

    const pending = await store.listPending("msteams:tenant-1:conversation-1");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.id, request.id);

    const decided = await store.decide({
      id: request.id,
      status: "approved",
      decisionBy: "msteams:lead-1",
      decisionReason: "looks good",
    });

    assert.equal(decided?.status, "approved");
    assert.equal(decided?.decisionBy, "msteams:lead-1");
    assert.equal(decided?.decisionReason, "looks good");

    const reloaded = new ApprovalStore(filePath);
    const reloadedRequest = await reloaded.get(request.id);

    assert.equal(reloadedRequest?.status, "approved");
    assert.equal(reloadedRequest?.decisionBy, "msteams:lead-1");
    assert.equal(reloadedRequest?.requestType, "external-action");
    assert.deepEqual((reloadedRequest?.externalAction?.payload.labels as string[]) ?? [], ["bug", "backend"]);
    assert.equal((await reloaded.listPending()).length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ApprovalStore normalizes legacy webhook-action records", async () => {
  const dir = await makeTempDir("hiveping-approvals-legacy-");

  try {
    const filePath = path.join(dir, "approval-requests.json");
    const payload = {
      version: 1,
      requests: {
        appr_legacy: {
          id: "appr_legacy",
          status: "pending",
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:00.000Z",
          conversationKey: "slack:default:C1",
          provider: "slack",
          projectId: "account-service",
          repoPath: "/workspace/account-service",
          prompt: "Create issue",
          requestedBy: "slack:U1",
          requestedRole: "dev",
          requiredRole: "maintainer",
          requestType: "webhook-action",
          webhookAction: {
            kind: "issue.create",
            tracker: "jira",
            title: "Retry bug",
            description: "Retries are not capped",
            labels: ["bug"],
          },
        },
      },
    };
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const store = new ApprovalStore(filePath);
    const request = await store.get("appr_legacy");

    assert.equal(request?.requestType, "external-action");
    assert.equal(request?.externalAction?.name, "issue.create");
    assert.equal(request?.externalAction?.summary, "jira: Retry bug");
    assert.deepEqual(request?.externalAction?.payload, {
      tracker: "jira",
      title: "Retry bug",
      description: "Retries are not capped",
      labels: ["bug"],
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ApprovalGrantStore consumes and revokes grants", async () => {
  const dir = await makeTempDir("hiveping-grants-");

  try {
    const filePath = path.join(dir, "approval-grants.json");
    const store = new ApprovalGrantStore(filePath);

    const grant = await store.create({
      projectId: "account-service",
      repoPath: "/workspace/account-service",
      actionName: "deployed.version",
      scope: "requester",
      grantedTo: "slack:U1",
      remainingUses: 2,
      createdBy: "slack:OWNER",
      sourceRequestId: "appr_123",
    });

    assert.match(grant.id, /^grant_/);

    const firstUse = await store.consumeMatching({
      repoPath: "/workspace/account-service",
      actionName: "deployed.version",
      requestedBy: "slack:U1",
    });
    assert.equal(firstUse?.remainingUses, 1);

    const secondUse = await store.consumeMatching({
      repoPath: "/workspace/account-service",
      actionName: "deployed.version",
      requestedBy: "slack:U1",
    });
    assert.equal(secondUse?.status, "exhausted");
    assert.equal(await store.consumeMatching({
      repoPath: "/workspace/account-service",
      actionName: "deployed.version",
      requestedBy: "slack:U1",
    }), undefined);

    const broadGrant = await store.create({
      projectId: "account-service",
      repoPath: "/workspace/account-service",
      actionName: "jira.issue.create",
      scope: "all",
      expiresAt: "2026-03-20T00:00:00.000Z",
      createdBy: "slack:OWNER",
      sourceRequestId: "appr_456",
    });

    const revoked = await store.revokeMatching({
      repoPath: "/workspace/account-service",
      actionName: "jira.issue.create",
      revokedBy: "slack:OWNER",
      revokedReason: "turning it off",
    });
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0]?.id, broadGrant.id);

    const reloaded = new ApprovalGrantStore(filePath);
    const reloadedGrant = await reloaded.get(broadGrant.id);
    assert.equal(reloadedGrant?.status, "revoked");
    assert.equal(reloadedGrant?.revokedBy, "slack:OWNER");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
