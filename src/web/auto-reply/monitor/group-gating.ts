import { resolveAgentSkillsFilter, resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { hasControlCommand } from "../../../auto-reply/command-detection.js";
import { parseActivationCommand } from "../../../auto-reply/group-activation.js";
import { recordPendingHistoryEntryIfEnabled } from "../../../auto-reply/reply/history.js";
import {
  listSkillCommandsForWorkspace,
  resolveSkillCommandInvocation,
} from "../../../auto-reply/skill-commands.js";
import { resolveMentionGatingWithBypass } from "../../../channels/mention-gating.js";
import type { loadConfig } from "../../../config/config.js";
import { resolveDmGroupAccessWithCommandGate } from "../../../security/dm-policy-shared.js";
import { normalizeE164 } from "../../../utils.js";
import { resolveWhatsAppAccount } from "../../accounts.js";
import type { MentionConfig } from "../mentions.js";
import { buildMentionConfig, debugMention, resolveOwnerList } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { stripMentionsForCommand } from "./commands.js";
import { resolveGroupActivationFor, resolveGroupPolicyFor } from "./group-activation.js";
import { noteGroupMember } from "./group-members.js";

export type GroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  id?: string;
  senderJid?: string;
};

type ApplyGroupGatingParams = {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  conversationId: string;
  groupHistoryKey: string;
  agentId: string;
  sessionKey: string;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryLimit: number;
  groupMemberNames: Map<string, Map<string, string>>;
  logVerbose: (msg: string) => void;
  replyLogger: { debug: (obj: unknown, msg: string) => void };
};

function isOwnerSender(baseMentionConfig: MentionConfig, msg: WebInboundMsg) {
  const sender = normalizeE164(msg.senderE164 ?? "");
  if (!sender) {
    return false;
  }
  const owners = resolveOwnerList(baseMentionConfig, msg.selfE164 ?? undefined);
  return owners.includes(sender);
}

function resolveWhatsAppGroupCommandAuthorized(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  hasControlCommand: boolean;
}) {
  const senderE164 = normalizeE164(params.msg.senderE164 ?? "");
  if (!senderE164) {
    return false;
  }
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.msg.accountId,
  });
  const configuredAllowFrom = account.allowFrom ?? [];
  const configuredGroupAllowFrom =
    account.groupAllowFrom ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined);
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup: true,
    dmPolicy: account.dmPolicy ?? "pairing",
    groupPolicy: account.groupPolicy ?? "allowlist",
    allowFrom: configuredAllowFrom,
    groupAllowFrom: configuredGroupAllowFrom,
    // Group command authorization must rely on configured access only.
    storeAllowFrom: [],
    isSenderAllowed: (allowEntries) => {
      if (allowEntries.includes("*")) {
        return true;
      }
      const normalizedEntries = allowEntries
        .map((entry) => normalizeE164(String(entry)))
        .filter((entry): entry is string => Boolean(entry));
      return normalizedEntries.includes(senderE164);
    },
    command: {
      useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
      allowTextCommands: true,
      hasControlCommand: params.hasControlCommand,
    },
  });
  return access.commandAuthorized;
}

function hasSkillControlCommand(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  commandBody: string;
}) {
  const trimmed = params.commandBody.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const skillCommands = listSkillCommandsForWorkspace({
    workspaceDir,
    cfg: params.cfg,
    skillFilter: resolveAgentSkillsFilter(params.cfg, params.agentId),
  });
  if (skillCommands.length === 0) {
    return false;
  }
  return (
    resolveSkillCommandInvocation({
      commandBodyNormalized: trimmed,
      skillCommands,
    }) !== null
  );
}

function recordPendingGroupHistoryEntry(params: {
  msg: WebInboundMsg;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupHistoryKey: string;
  groupHistoryLimit: number;
}) {
  const sender =
    params.msg.senderName && params.msg.senderE164
      ? `${params.msg.senderName} (${params.msg.senderE164})`
      : (params.msg.senderName ?? params.msg.senderE164 ?? "Unknown");
  recordPendingHistoryEntryIfEnabled({
    historyMap: params.groupHistories,
    historyKey: params.groupHistoryKey,
    limit: params.groupHistoryLimit,
    entry: {
      sender,
      body: params.msg.body,
      timestamp: params.msg.timestamp,
      id: params.msg.id,
      senderJid: params.msg.senderJid,
    },
  });
}

function skipGroupMessageAndStoreHistory(params: ApplyGroupGatingParams, verboseMessage: string) {
  params.logVerbose(verboseMessage);
  recordPendingGroupHistoryEntry({
    msg: params.msg,
    groupHistories: params.groupHistories,
    groupHistoryKey: params.groupHistoryKey,
    groupHistoryLimit: params.groupHistoryLimit,
  });
  return { shouldProcess: false } as const;
}

export function applyGroupGating(params: ApplyGroupGatingParams) {
  const groupPolicy = resolveGroupPolicyFor(params.cfg, params.conversationId);
  if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
    params.logVerbose(`Skipping group message ${params.conversationId} (not in allowlist)`);
    return { shouldProcess: false };
  }

  noteGroupMember(
    params.groupMemberNames,
    params.groupHistoryKey,
    params.msg.senderE164,
    params.msg.senderName,
  );

  const mentionConfig = buildMentionConfig(params.cfg, params.agentId);
  const commandBody = stripMentionsForCommand(
    params.msg.body,
    mentionConfig.mentionRegexes,
    params.msg.selfE164,
  );
  const activationCommand = parseActivationCommand(commandBody);
  const owner = isOwnerSender(params.baseMentionConfig, params.msg);
  const hasControlCommandInBody =
    hasControlCommand(commandBody, params.cfg) ||
    hasSkillControlCommand({
      cfg: params.cfg,
      agentId: params.agentId,
      commandBody,
    });

  if (activationCommand.hasCommand && !owner) {
    return skipGroupMessageAndStoreHistory(
      params,
      `Ignoring /activation from non-owner in group ${params.conversationId}`,
    );
  }

  const mentionDebug = debugMention(params.msg, mentionConfig, params.authDir);
  params.replyLogger.debug(
    {
      conversationId: params.conversationId,
      wasMentioned: mentionDebug.wasMentioned,
      ...mentionDebug.details,
    },
    "group mention debug",
  );
  const wasMentioned = mentionDebug.wasMentioned;
  const activation = resolveGroupActivationFor({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: params.conversationId,
  });
  const requireMention = activation !== "always";
  const selfJid = params.msg.selfJid?.replace(/:\\d+/, "");
  const replySenderJid = params.msg.replyToSenderJid?.replace(/:\\d+/, "");
  const selfE164 = params.msg.selfE164 ? normalizeE164(params.msg.selfE164) : null;
  const replySenderE164 = params.msg.replyToSenderE164
    ? normalizeE164(params.msg.replyToSenderE164)
    : null;
  const implicitMention = Boolean(
    (selfJid && replySenderJid && selfJid === replySenderJid) ||
    (selfE164 && replySenderE164 && selfE164 === replySenderE164),
  );
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup: true,
    requireMention,
    canDetectMention: true,
    wasMentioned,
    implicitMention,
    hasAnyMention: (params.msg.mentionedJids?.length ?? 0) > 0,
    allowTextCommands: true,
    hasControlCommand: hasControlCommandInBody,
    commandAuthorized: hasControlCommandInBody
      ? resolveWhatsAppGroupCommandAuthorized({
          cfg: params.cfg,
          msg: params.msg,
          hasControlCommand: hasControlCommandInBody,
        })
      : false,
  });
  params.msg.wasMentioned = mentionGate.effectiveWasMentioned;
  if (requireMention && mentionGate.shouldSkip) {
    return skipGroupMessageAndStoreHistory(
      params,
      `Group message stored for context (no mention detected) in ${params.conversationId}: ${params.msg.body}`,
    );
  }

  return { shouldProcess: true };
}
