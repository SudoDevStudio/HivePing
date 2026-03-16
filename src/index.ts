import path from "node:path";
import { ApprovalGrantStore } from "./core/approval-grant-store.js";
import { ApprovalStore } from "./core/approval-store.js";
import { BindingStore } from "./core/binding-store.js";
import { primaryStoragePath } from "./core/branding.js";
import { HistoryStore } from "./core/history-store.js";
import { loadManagedRuntimeConfigSync } from "./core/runtime-config.js";
import { registerMentionHook } from "./hooks/mention.js";
import type { PluginConfig } from "./types.js";

function resolvePluginConfig(api: any): PluginConfig {
  const config = (api?.pluginConfig || api?.config || {}) as PluginConfig;
  return config;
}

function resolvePathFromConfig(api: any, configuredPath: string | undefined, fallbackRelativePath: string): string {
  const trimmed = configuredPath?.trim();
  const finalPath = trimmed && trimmed.length > 0 ? trimmed : fallbackRelativePath;

  if (typeof api?.resolvePath === "function") {
    return api.resolvePath(finalPath);
  }

  return path.resolve(finalPath);
}

function resolveStoragePathFromConfig(
  api: any,
  configuredPath: string | undefined,
  fileName: string,
): string {
  const trimmed = configuredPath?.trim();
  if (trimmed && trimmed.length > 0) {
    return resolvePathFromConfig(api, trimmed, trimmed);
  }
  return resolvePathFromConfig(api, undefined, primaryStoragePath(fileName));
}

function resolveOptionalPathFromConfig(api: any, configuredPath: string | undefined): string | undefined {
  const trimmed = configuredPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (typeof api?.resolvePath === "function") {
    return api.resolvePath(trimmed);
  }
  return path.resolve(trimmed);
}

export default function register(api: any): void {
  const baseConfig = resolvePluginConfig(api);

  const runtimeConfigFile = resolveStoragePathFromConfig(api, baseConfig.runtimeConfigFile, "runtime-config.json");

  const runtimeOverrides = loadManagedRuntimeConfigSync(runtimeConfigFile);
  const mergedConfig: PluginConfig = {
    ...baseConfig,
    ...runtimeOverrides,
    runtimeConfigFile,
  };

  const config: PluginConfig = {
    ...mergedConfig,
    rolePolicyDir: resolveOptionalPathFromConfig(api, mergedConfig.rolePolicyDir),
    approvalRequestsFile: resolveStoragePathFromConfig(api, mergedConfig.approvalRequestsFile, "approval-requests.json"),
  };

  const store = new BindingStore(resolveStoragePathFromConfig(api, baseConfig.bindingsFile, "bindings.json"));
  const approvals = new ApprovalStore(
    config.approvalRequestsFile || resolveStoragePathFromConfig(api, undefined, "approval-requests.json"),
  );
  const grants = new ApprovalGrantStore(resolveStoragePathFromConfig(api, undefined, "approval-grants.json"));
  const history = new HistoryStore(resolveStoragePathFromConfig(api, undefined, "history.json"));

  const deps = {
    config,
    store,
    approvals,
    grants,
    history,
    approvalsFilePath: config.approvalRequestsFile,
    historyMaxMessages: 30,
  };

  registerMentionHook(api, deps);
}
