#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function fail(message) {
  throw new Error(message);
}

function runGit(args, options = {}) {
  const stdout = execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return stdout.trim();
}

function runGitAllowFailure(args, options = {}) {
  try {
    return {
      ok: true,
      stdout: runGit(args, options),
    };
  } catch (error) {
    return {
      ok: false,
      error,
    };
  }
}

function parseArgs(argv) {
  const options = {
    branchKey: "",
    dryRun: false,
    fallbackSourceRef: "",
    originRemote: "origin",
    push: false,
    syncPrefix: "sync",
    tagPattern: "v*",
    targetTag: "",
    upstreamMainRef: "",
    upstreamRemote: "upstream",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--branch-key":
        options.branchKey = argv[++index] ?? "";
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--fallback-source-ref":
        options.fallbackSourceRef = argv[++index] ?? "";
        break;
      case "--origin-remote":
        options.originRemote = argv[++index] ?? "";
        break;
      case "--push":
        options.push = true;
        break;
      case "--sync-prefix":
        options.syncPrefix = argv[++index] ?? "";
        break;
      case "--tag-pattern":
        options.tagPattern = argv[++index] ?? "";
        break;
      case "--target-tag":
        options.targetTag = argv[++index] ?? "";
        break;
      case "--upstream-main-ref":
        options.upstreamMainRef = argv[++index] ?? "";
        break;
      case "--upstream-remote":
        options.upstreamRemote = argv[++index] ?? "";
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  if (!options.branchKey) {
    fail("Missing required --branch-key");
  }
  if (!options.originRemote) {
    fail("Missing --origin-remote");
  }
  if (!options.upstreamRemote) {
    fail("Missing --upstream-remote");
  }
  if (!options.syncPrefix) {
    fail("Missing --sync-prefix");
  }
  if (!options.tagPattern) {
    fail("Missing --tag-pattern");
  }
  if (!options.upstreamMainRef) {
    options.upstreamMainRef = `refs/remotes/${options.upstreamRemote}/main`;
  }
  if (!options.fallbackSourceRef) {
    options.fallbackSourceRef = `refs/remotes/${options.originRemote}/${options.branchKey}`;
  }

  return options;
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function normalizeOpenClawVersion(raw) {
  return raw
    .trim()
    .replace(/^v/, "")
    .replace(/\.beta\./g, "-beta.");
}

function parseOpenClawVersion(raw) {
  const normalized = normalizeOpenClawVersion(raw);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return null;
  }

  const [, major, minor, patch, suffix = ""] = match;
  const revision = suffix && /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : null;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease: suffix && revision == null ? suffix.split(".").filter(Boolean) : null,
    revision,
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    const leftIsNumeric = /^\d+$/.test(leftPart);
    const rightIsNumeric = /^\d+$/.test(rightPart);
    if (leftIsNumeric && rightIsNumeric) {
      const diff = Number.parseInt(leftPart, 10) - Number.parseInt(rightPart, 10);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
      continue;
    }
    if (leftIsNumeric !== rightIsNumeric) {
      return leftIsNumeric ? -1 : 1;
    }
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

function releaseRank(version) {
  if (version.prerelease?.length) {
    return 0;
  }
  if (version.revision != null) {
    return 2;
  }
  return 1;
}

function compareOpenClawVersions(leftRaw, rightRaw) {
  const left = parseOpenClawVersion(leftRaw);
  const right = parseOpenClawVersion(rightRaw);
  if (!left || !right) {
    return leftRaw.localeCompare(rightRaw);
  }
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }

  const leftRank = releaseRank(left);
  const rightRank = releaseRank(right);
  if (leftRank !== rightRank) {
    return leftRank < rightRank ? -1 : 1;
  }

  if (left.revision != null && right.revision != null && left.revision !== right.revision) {
    return left.revision < right.revision ? -1 : 1;
  }

  if (left.prerelease || right.prerelease) {
    return comparePrereleaseIdentifiers(left.prerelease ?? [], right.prerelease ?? []);
  }

  return 0;
}

function sortVersionsDescending(values) {
  return [...values].toSorted((left, right) => compareOpenClawVersions(right, left));
}

function fetchOriginRemote(remote) {
  log(`Fetching ${remote} branches`);
  runGit(["fetch", "--prune", remote, `+refs/heads/*:refs/remotes/${remote}/*`]);
}

function fetchUpstreamRemote(remote) {
  log(`Fetching ${remote} branches and namespaced tags`);
  runGit([
    "fetch",
    "--prune",
    remote,
    `+refs/heads/*:refs/remotes/${remote}/*`,
    "+refs/tags/*:refs/tags/upstream/*",
  ]);
}

function resolveTargetTag(options) {
  const tagNamespacePattern = `refs/tags/upstream/${options.tagPattern}`;
  if (options.targetTag) {
    const tagRef = `refs/tags/upstream/${options.targetTag}`;
    if (!refExists(tagRef)) {
      fail(`Requested upstream tag ${options.targetTag} was not found at ${tagRef}`);
    }
    log(`Using requested upstream tag ${options.targetTag}`);
    return {
      tag: options.targetTag,
      tagRef,
    };
  }

  const tags = runGit([
    "for-each-ref",
    "--merged",
    options.upstreamMainRef,
    "--format=%(refname:strip=3)",
    tagNamespacePattern,
  ])
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (tags.length === 0) {
    fail(`No tags matching '${options.tagPattern}' are merged into ${options.upstreamMainRef}`);
  }

  const [tag] = sortVersionsDescending(tags);
  log(`Resolved latest upstream tag ${tag}`);
  return {
    tag,
    tagRef: `refs/tags/upstream/${tag}`,
  };
}

function remoteBranchExists(originRemote, targetBranch) {
  return runGitAllowFailure(["ls-remote", "--exit-code", "--heads", originRemote, targetBranch]).ok;
}

function refExists(ref) {
  return runGitAllowFailure(["rev-parse", "--verify", "--quiet", ref]).ok;
}

function resolveLatestSyncSourceRef(options) {
  const pattern = `refs/remotes/${options.originRemote}/${options.syncPrefix}/${options.branchKey}-v*`;
  const refs = runGit(["for-each-ref", "--format=%(refname)", pattern])
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const prefix = `refs/remotes/${options.originRemote}/${options.syncPrefix}/${options.branchKey}-`;
  const latestRef = [...refs].toSorted((left, right) => {
    const leftVersion = left.startsWith(prefix) ? left.slice(prefix.length) : left;
    const rightVersion = right.startsWith(prefix) ? right.slice(prefix.length) : right;
    return compareOpenClawVersions(rightVersion, leftVersion);
  })[0];

  if (latestRef) {
    log(`Using latest sync source ref ${latestRef}`);
    return latestRef;
  }

  if (refExists(options.fallbackSourceRef)) {
    log(`Using fallback source ref ${options.fallbackSourceRef}`);
    return options.fallbackSourceRef;
  }

  fail(
    `Unable to resolve source ref. No existing sync branch matched ${pattern} and fallback ref ${options.fallbackSourceRef} was missing.`,
  );
}

function collectReplayCommits(targetTagRef, sourceRef) {
  const revList = runGit([
    "rev-list",
    "--reverse",
    "--right-only",
    "--cherry-pick",
    `${targetTagRef}...${sourceRef}`,
  ]);
  const shas = revList
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const commits = [];
  for (const sha of shas) {
    const parentLine = runGit(["rev-list", "--parents", "-n", "1", sha]);
    const parentCount = parentLine.split(" ").length - 1;
    if (parentCount > 1) {
      fail(`Commit ${sha} is a merge commit. This sync flow only supports linear commit stacks.`);
    }
    const subject = runGit(["show", "-s", "--format=%s", sha]);
    commits.push({ sha, subject });
  }
  return commits;
}

function extractSyncSourceTag(sourceRef, options) {
  const prefix = `refs/remotes/${options.originRemote}/${options.syncPrefix}/${options.branchKey}-`;
  if (!sourceRef.startsWith(prefix)) {
    return null;
  }
  return sourceRef.slice(prefix.length);
}

function checkoutTargetBranch(targetTagRef, targetBranch) {
  runGit(["switch", "--detach", targetTagRef]);
  runGit(["switch", "-C", targetBranch]);
}

function cherryPickCommits(commits) {
  for (const commit of commits) {
    log(`Cherry-picking ${commit.sha} ${commit.subject}`);
    runGit(["cherry-pick", "-x", commit.sha], { stdio: ["ignore", "inherit", "inherit"] });
  }
}

function pushBranch(originRemote, targetBranch) {
  log(`Pushing ${targetBranch} to ${originRemote}`);
  runGit(["push", originRemote, `HEAD:refs/heads/${targetBranch}`], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  fetchOriginRemote(options.originRemote);
  fetchUpstreamRemote(options.upstreamRemote);

  const { tag: targetTag, tagRef: targetTagRef } = resolveTargetTag(options);
  const targetBranch = `${options.syncPrefix}/${options.branchKey}-${targetTag}`;
  if (remoteBranchExists(options.originRemote, targetBranch)) {
    const result = {
      status: "noop_existing_branch",
      sourceRef: null,
      targetBranch,
      targetTag,
      commits: [],
      pushed: false,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const sourceRef = resolveLatestSyncSourceRef(options);
  const sourceTag = extractSyncSourceTag(sourceRef, options);
  if (sourceTag && compareOpenClawVersions(targetTag, sourceTag) < 0) {
    fail(
      `Target tag ${targetTag} is older than source sync branch ${sourceTag}. Syncing older tags from a newer sync branch is not supported.`,
    );
  }
  const commits = collectReplayCommits(targetTagRef, sourceRef);
  if (commits.length === 0) {
    const result = {
      status: "noop_no_commits",
      sourceRef,
      targetBranch,
      targetTag,
      commits,
      pushed: false,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (options.dryRun) {
    const result = {
      status: "dry_run",
      sourceRef,
      targetBranch,
      targetTag,
      commits,
      pushed: false,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  checkoutTargetBranch(targetTagRef, targetBranch);
  cherryPickCommits(commits);

  if (options.push) {
    pushBranch(options.originRemote, targetBranch);
  }

  const result = {
    status: "created",
    sourceRef,
    targetBranch,
    targetTag,
    commits,
    pushed: options.push,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
  }
  process.exit(1);
}
