import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runGovern, type GovernDeps } from "../../commands/govern.js";
import { ApprovalGrantStore } from "../../core/approval-grant-store.js";
import { ApprovalStore } from "../../core/approval-store.js";
import { BindingStore } from "../../core/binding-store.js";
import { HistoryStore } from "../../core/history-store.js";
import type { ConversationKeyContext, PluginConfig } from "../../types.js";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createDeps(root: string, config: PluginConfig = {}): GovernDeps {
  return {
    config,
    store: new BindingStore(path.join(root, "bindings.json")),
    approvals: new ApprovalStore(path.join(root, "approvals.json")),
    grants: new ApprovalGrantStore(path.join(root, "grants.json")),
    history: new HistoryStore(path.join(root, "history.json")),
    historyMaxMessages: 20,
  };
}

function slackContext(senderId: string): ConversationKeyContext {
  return {
    channelId: "slack",
    from: senderId,
    to: "channel:C_SHARED",
    conversationId: "channel:C_SHARED",
    accountId: "T_DEFAULT",
  };
}

async function writePolicy(repoPath: string): Promise<void> {
  const policyDir = path.join(repoPath, ".hiveping", "policies");
  await fs.mkdir(policyDir, { recursive: true });
  await fs.writeFile(
    path.join(policyDir, "frontend-app.json"),
    `${JSON.stringify(
      {
        version: 1,
        projectId: "frontend-app",
        repoPath,
        members: {
          "slack:U_REQUESTER": "anyone",
          "slack:U_OWNER": "owner",
        },
        permissions: {
          ask: ["anyone"],
          status: ["anyone"],
          change: ["owner"],
          bind: ["owner"],
          unbind: ["owner"],
          approve: ["owner"],
          externalApi: ["owner"],
        },
        approval: {
          enabled: true,
          approverRoles: ["owner"],
          requireTicketForHeavyChange: false,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("external-action approvals can create reusable grants and later be revoked", async () => {
  const dir = await makeTempDir("hiveping-govern-grants-");
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response("0.1.2", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as typeof globalThis.fetch;

  try {
    const repoPath = path.join(dir, "frontend-app");
    await fs.mkdir(repoPath, { recursive: true });
    await writePolicy(repoPath);

    const deps = createDeps(dir, {
      rolePolicyEnabled: true,
    });

    await deps.store.set("slack:T_DEFAULT:C_SHARED", {
      repoPath,
      provider: "slack",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    const requestResult = await runGovern(
      'action deployed.version {"mode":"http","method":"GET","url":"https://hooks.example.com/version"}',
      slackContext("U_REQUESTER"),
      deps,
    );
    assert.match(requestResult.text, /Approval request created:/);
    const requestId = requestResult.text.match(/Approval request created:\s+(appr_[^\n]+)/)?.[1];
    assert.ok(requestId);

    const approveResult = await runGovern(
      `approve ${requestId} --future 2 --scope requester`,
      slackContext("U_OWNER"),
      deps,
    );
    assert.match(approveResult.text, /Approved request/);
    assert.match(approveResult.text, /Reusable approval granted:/);

    const activeGrants = await deps.grants.listActive({ repoPath });
    assert.equal(activeGrants.length, 1);
    assert.equal(activeGrants[0]?.actionName, "deployed.version");
    assert.equal(activeGrants[0]?.grantedTo, "slack:U_REQUESTER");
    const grantId = activeGrants[0]?.id;
    assert.ok(grantId);

    const listResult = await runGovern("grants", slackContext("U_OWNER"), deps);
    assert.match(listResult.text, new RegExp(grantId!));
    assert.match(listResult.text, /remaining uses: 2/);

    const directRunResult = await runGovern(
      'action deployed.version {"mode":"http","method":"GET","url":"https://hooks.example.com/version"}',
      slackContext("U_REQUESTER"),
      deps,
    );
    assert.match(directRunResult.text, /External action executed directly:/);
    assert.match(directRunResult.text, new RegExp(`Reusable approval: ${grantId}`));

    const postUseGrant = await deps.grants.get(grantId!);
    assert.equal(postUseGrant?.remainingUses, 1);

    const revokeResult = await runGovern(`revoke ${grantId}`, slackContext("U_OWNER"), deps);
    assert.match(revokeResult.text, /Revoked reusable approval/);
    assert.equal((await deps.grants.listActive({ repoPath })).length, 0);

    const nextRequest = await runGovern(
      'action deployed.version {"mode":"http","method":"GET","url":"https://hooks.example.com/version"}',
      slackContext("U_REQUESTER"),
      deps,
    );
    assert.match(nextRequest.text, /Approval request created:/);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
