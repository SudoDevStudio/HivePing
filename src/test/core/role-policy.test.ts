import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyProjectPolicyRuntimeDefaults,
  detectHeavyChange,
  detectWriteIntent,
  extractTicketReference,
  hasTicketReference,
  isRoleAllowedForAction,
  loadProjectPolicies,
  minRequiredRoleForAction,
  normalizeMemberKeyForPolicy,
  parseProjectRole,
  removeProjectMemberRole,
  roleForPrincipal,
  setProjectMemberRole,
} from "../../core/role-policy.js";
import type { ProjectPolicy } from "../../types.js";

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function samplePolicy(repoPath: string): ProjectPolicy {
  return {
    version: 1,
    projectId: "account-service",
    repoPath,
    members: {
      "discord:123": "maintainer",
      "email:dev@company.com": "dev",
      "slack:username:user-two": "owner",
    },
    permissions: {
      ask: ["anyone"],
      status: ["anyone"],
      change: ["dev", "maintainer", "owner"],
      bind: ["owner"],
      unbind: ["maintainer", "owner"],
      approve: ["maintainer", "owner"],
      externalApi: ["owner"],
    },
    approval: {
      enabled: true,
      approverRoles: ["maintainer", "owner"],
      requireTicketForHeavyChange: true,
      heavyKeywords: ["large refactor", "database schema"],
    },
  };
}

test("parseProjectRole accepts known values only", () => {
  assert.equal(parseProjectRole("Owner"), "owner");
  assert.equal(parseProjectRole(" dev "), "dev");
  assert.equal(parseProjectRole("unknown"), undefined);
  assert.equal(parseProjectRole(42), undefined);
});

test("roleForPrincipal resolves direct principals, usernames, emails, and action gates", () => {
  const policy = samplePolicy("/tmp/repo");

  assert.equal(roleForPrincipal(policy, "discord", "123"), "maintainer");
  assert.equal(roleForPrincipal(policy, "discord", "discord:123"), "maintainer");
  assert.equal(roleForPrincipal(policy, "slack", "not-mapped", undefined, "user-two"), "owner");
  assert.equal(roleForPrincipal(policy, "discord", "not-mapped", "DEV@company.com"), "dev");
  assert.equal(roleForPrincipal(policy, "discord", "nobody"), "anyone");

  assert.equal(isRoleAllowedForAction("maintainer", policy, "change"), true);
  assert.equal(isRoleAllowedForAction("maintainer", policy, "bind"), false);
  assert.equal(minRequiredRoleForAction(policy, "bind"), "owner");
  assert.equal(isRoleAllowedForAction("owner", policy, "externalApi"), true);
  assert.equal(isRoleAllowedForAction("maintainer", policy, "externalApi"), false);
  assert.equal(minRequiredRoleForAction(policy, "externalApi"), "owner");
});

test("applyProjectPolicyRuntimeDefaults prefers project model/profile over global defaults", () => {
  const policy = {
    ...samplePolicy("/tmp/repo"),
    defaultModel: "gpt-5.4",
    defaultProfile: "review",
  };

  const merged = applyProjectPolicyRuntimeDefaults(
    {
      reasoningCommand: "codex",
      defaultModel: "gpt-5-mini",
      defaultProfile: "fast",
    },
    policy,
  );

  assert.equal(merged.reasoningCommand, "codex");
  assert.equal(merged.defaultModel, "gpt-5.4");
  assert.equal(merged.defaultProfile, "review");
});

test("ticket, write-intent, and heavy-change detection works", () => {
  const policy = samplePolicy("/tmp/repo");

  assert.equal(extractTicketReference("please handle ABC-123 first"), "ABC-123");
  assert.equal(extractTicketReference("tracked in #42"), "#42");
  assert.equal(
    extractTicketReference("https://github.com/openclaw/openclaw/issues/24"),
    "https://github.com/openclaw/openclaw/issues/24",
  );
  assert.equal(hasTicketReference("no ticket included"), false);

  assert.equal(detectWriteIntent("update route validation and add tests"), true);
  assert.equal(detectWriteIntent("summarize repository architecture"), false);

  assert.equal(detectHeavyChange("please do a large refactor", policy), true);
  assert.equal(detectHeavyChange("x".repeat(420), policy), true);
  assert.equal(detectHeavyChange("small docs tweak", policy), false);
});

test("normalizeMemberKeyForPolicy normalizes mention, email, and provider prefixes", () => {
  assert.equal(normalizeMemberKeyForPolicy("discord", "<@123456>"), "discord:123456");
  assert.equal(normalizeMemberKeyForPolicy("msteams", "Engineer@Company.com"), "email:engineer@company.com");
  assert.equal(normalizeMemberKeyForPolicy("slack", "slack:U123ABC"), "slack:U123ABC");
});

test("setProjectMemberRole and removeProjectMemberRole persist changes", async () => {
  const dir = await makeTempDir("hiveping-policy-");

  try {
    const repoPath = path.join(dir, "account-service");
    const policyDir = path.join(dir, "policies");
    const policyPath = path.join(policyDir, "account-service.json");

    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(policyDir, { recursive: true });
    await fs.writeFile(policyPath, `${JSON.stringify(samplePolicy(repoPath), null, 2)}\n`, "utf8");

    const setResult = await setProjectMemberRole({
      policyDir,
      repoPath,
      provider: "discord",
      memberKey: "<@999>",
      role: "dev",
    });

    assert.equal(setResult.normalizedMemberKey, "discord:999");

    const policiesAfterSet = await loadProjectPolicies(policyDir);
    assert.equal(policiesAfterSet[0]?.members?.["discord:999"], "dev");

    const removeResult = await removeProjectMemberRole({
      policyDir,
      repoPath,
      provider: "discord",
      memberKey: "<@999>",
    });

    assert.equal(removeResult.removed, true);

    const policiesAfterRemove = await loadProjectPolicies(policyDir);
    assert.equal(policiesAfterRemove[0]?.members?.["discord:999"], undefined);

    const removeMissing = await removeProjectMemberRole({
      policyDir,
      repoPath,
      provider: "discord",
      memberKey: "<@999>",
    });

    assert.equal(removeMissing.removed, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectPolicies infers repoPath and projectId from default policy directory", async () => {
  const dir = await makeTempDir("hiveping-policy-defaults-");

  try {
    const repoPath = path.join(dir, "account-service");
    const policyDir = path.join(repoPath, ".hiveping", "policies");
    const policyPath = path.join(policyDir, "approval.json");

    await fs.mkdir(policyDir, { recursive: true });
    await fs.writeFile(
      policyPath,
      `${JSON.stringify(
        {
          version: 1,
          members: {
            "discord:123": "owner",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const policies = await loadProjectPolicies(policyDir);
    assert.equal(policies.length, 1);
    assert.equal(policies[0]?.repoPath, repoPath);
    assert.equal(policies[0]?.projectId, "account-service");
    assert.equal(policies[0]?.members?.["discord:123"], "owner");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadProjectPolicies parses optional project reasoning defaults", async () => {
  const dir = await makeTempDir("hiveping-policy-model-defaults-");

  try {
    const repoPath = path.join(dir, "account-service");
    const policyDir = path.join(repoPath, ".hiveping", "policies");
    const policyPath = path.join(policyDir, "account-service.json");

    await fs.mkdir(policyDir, { recursive: true });
    await fs.writeFile(
      policyPath,
      `${JSON.stringify(
        {
          version: 1,
          defaultModel: "gpt-5.4",
          defaultProfile: "dev",
          members: {
            "discord:123": "owner",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const policies = await loadProjectPolicies(policyDir);
    assert.equal(policies.length, 1);
    assert.equal(policies[0]?.defaultModel, "gpt-5.4");
    assert.equal(policies[0]?.defaultProfile, "dev");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("setProjectMemberRole works when policy omits projectId and repoPath", async () => {
  const dir = await makeTempDir("hiveping-policy-member-set-");

  try {
    const repoPath = path.join(dir, "account-service");
    const policyDir = path.join(repoPath, ".hiveping", "policies");
    const policyPath = path.join(policyDir, "approval.json");

    await fs.mkdir(policyDir, { recursive: true });
    await fs.writeFile(
      policyPath,
      `${JSON.stringify(
        {
          version: 1,
          members: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await setProjectMemberRole({
      policyDir,
      repoPath,
      provider: "discord",
      memberKey: "<@222>",
      role: "maintainer",
    });

    const policiesAfterSet = await loadProjectPolicies(policyDir);
    assert.equal(policiesAfterSet[0]?.repoPath, repoPath);
    assert.equal(policiesAfterSet[0]?.projectId, "account-service");
    assert.equal(policiesAfterSet[0]?.members?.["discord:222"], "maintainer");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
