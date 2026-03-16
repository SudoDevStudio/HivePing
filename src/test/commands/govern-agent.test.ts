import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApprovalGrantStore } from "../../core/approval-grant-store.js";
import { ApprovalStore } from "../../core/approval-store.js";
import { BindingStore } from "../../core/binding-store.js";
import { HistoryStore } from "../../core/history-store.js";
import { runGovern, type GovernDeps } from "../../commands/govern.js";
import type { AgentProfile, ConversationBinding, ConversationKeyContext, PluginConfig } from "../../types.js";

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

function sharedSlackContext(senderId = "U_REQUESTER"): ConversationKeyContext {
  return {
    channelId: "slack",
    from: senderId,
    to: "channel:C_SHARED",
    conversationId: "channel:C_SHARED",
    accountId: "T_DEFAULT",
  };
}

function fixedBinding(repoPath: string): ConversationBinding {
  return {
    repoPath,
    provider: "slack",
    updatedAt: "2026-03-15T00:00:00.000Z",
    metadata: {
      agentId: "fe",
    },
  };
}

function agentProfile(repoPath: string): AgentProfile {
  return {
    id: "fe",
    aliases: ["@hiveping1"],
    repoPath,
    homeConversationKey: "slack:T_DEFAULT:C_FE",
  };
}

test("runGovern status uses fixed agent binding and home history context", async () => {
  const dir = await makeTempDir("hiveping-govern-agent-status-");

  try {
    const repoPath = path.join(dir, "frontend-app");
    await fs.mkdir(repoPath, { recursive: true });

    const deps = createDeps(dir, {
      rolePolicyEnabled: false,
    });

    const result = await runGovern("status", sharedSlackContext(), deps, {
      agentProfile: agentProfile(repoPath),
      fixedBinding: fixedBinding(repoPath),
      historyConversationKey: "slack:T_DEFAULT:C_FE",
    });

    assert.match(result.text, /Binding status:/);
    assert.match(result.text, /Agent: fe/);
    assert.match(result.text, /History key: slack:T_DEFAULT:C_FE/);
    assert.match(result.text, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runGovern blocks bind in agent-bound mode", async () => {
  const dir = await makeTempDir("hiveping-govern-agent-bind-");

  try {
    const repoPath = path.join(dir, "frontend-app");
    await fs.mkdir(repoPath, { recursive: true });

    const deps = createDeps(dir);
    const result = await runGovern(`bind ${repoPath}`, sharedSlackContext(), deps, {
      agentProfile: agentProfile(repoPath),
      fixedBinding: fixedBinding(repoPath),
      historyConversationKey: "slack:T_DEFAULT:C_FE",
    });

    assert.match(result.text, /fixed repository binding/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runGovern stores agent and home history key on approval requests", async () => {
  const dir = await makeTempDir("hiveping-govern-agent-approval-");

  try {
    const repoPath = path.join(dir, "frontend-app");
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

    const deps = createDeps(dir, {
      rolePolicyEnabled: true,
    });

    const result = await runGovern("update the hero CTA copy", sharedSlackContext(), deps, {
      agentProfile: agentProfile(repoPath),
      fixedBinding: fixedBinding(repoPath),
      historyConversationKey: "slack:T_DEFAULT:C_FE",
    });

    assert.match(result.text, /Approval request created:/);

    const pending = await deps.approvals.listPending("slack:T_DEFAULT:C_SHARED");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.agentId, "fe");
    assert.equal(pending[0]?.historyConversationKey, "slack:T_DEFAULT:C_FE");
    assert.equal(pending[0]?.repoPath, repoPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
