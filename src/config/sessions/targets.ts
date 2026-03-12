import os from "node:os";
import path from "node:path";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveAgentSessionDirs } from "../../agents/session-dirs.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";

export type SessionStoreSelectionOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
};

export type SessionStoreTarget = {
  agentId: string;
  storePath: string;
};

function dedupeTargetsByStorePath(targets: SessionStoreTarget[]): SessionStoreTarget[] {
  const deduped = new Map<string, SessionStoreTarget>();
  for (const target of targets) {
    if (!deduped.has(target.storePath)) {
      deduped.set(target.storePath, target);
    }
  }
  return [...deduped.values()];
}

export async function resolveAllAgentSessionStoreTargets(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): Promise<SessionStoreTarget[]> {
  const configuredTargets = resolveSessionStoreTargets(cfg, { allAgents: true });
  const stateDir = resolveStateDir(params.env ?? process.env, os.homedir);
  const discoveredTargets = (await resolveAgentSessionDirs(stateDir)).map((sessionsDir) => ({
    agentId: normalizeAgentId(path.basename(path.dirname(sessionsDir))),
    storePath: path.join(sessionsDir, "sessions.json"),
  }));
  return dedupeTargetsByStorePath([...configuredTargets, ...discoveredTargets]);
}

export function resolveSessionStoreTargets(
  cfg: OpenClawConfig,
  opts: SessionStoreSelectionOptions,
): SessionStoreTarget[] {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const hasAgent = Boolean(opts.agent?.trim());
  const allAgents = opts.allAgents === true;
  if (hasAgent && allAgents) {
    throw new Error("--agent and --all-agents cannot be used together");
  }
  if (opts.store && (hasAgent || allAgents)) {
    throw new Error("--store cannot be combined with --agent or --all-agents");
  }

  if (opts.store) {
    return [
      {
        agentId: defaultAgentId,
        storePath: resolveStorePath(opts.store, { agentId: defaultAgentId }),
      },
    ];
  }

  if (allAgents) {
    const targets = listAgentIds(cfg).map((agentId) => ({
      agentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId }),
    }));
    return dedupeTargetsByStorePath(targets);
  }

  if (hasAgent) {
    const knownAgents = listAgentIds(cfg);
    const requested = normalizeAgentId(opts.agent ?? "");
    if (!knownAgents.includes(requested)) {
      throw new Error(
        `Unknown agent id "${opts.agent}". Use "openclaw agents list" to see configured agents.`,
      );
    }
    return [
      {
        agentId: requested,
        storePath: resolveStorePath(cfg.session?.store, { agentId: requested }),
      },
    ];
  }

  return [
    {
      agentId: defaultAgentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId: defaultAgentId }),
    },
  ];
}
