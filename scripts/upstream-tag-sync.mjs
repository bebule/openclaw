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
  return typeof stdout === "string" ? stdout.trim() : "";
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
    baseBranch: "main",
    dryRun: false,
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
      case "--base-branch":
        options.baseBranch = argv[++index] ?? "";
        break;
      case "--dry-run":
        options.dryRun = true;
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

  if (!options.baseBranch) {
    fail("Missing required --base-branch");
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

function splitLines(stdout) {
  return stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
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

  const tags = splitLines(
    runGit([
      "for-each-ref",
      "--merged",
      options.upstreamMainRef,
      "--format=%(refname:strip=3)",
      tagNamespacePattern,
    ]),
  );

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

function resolveBaseRef(options) {
  const baseRef = `refs/remotes/${options.originRemote}/${options.baseBranch}`;
  if (!refExists(baseRef)) {
    fail(`Base branch ${options.baseBranch} was not found at ${baseRef}`);
  }
  return baseRef;
}

function resolveTargetBranch(options, targetTag) {
  return `${options.syncPrefix}/${targetTag}`;
}

function isAncestor(leftRef, rightRef) {
  return runGitAllowFailure(["merge-base", "--is-ancestor", leftRef, rightRef], {
    stdio: ["ignore", "ignore", "ignore"],
  }).ok;
}

function collectLocalCommitSummary(targetTagRef, baseRef, limit = 50) {
  const revList = runGit([
    "rev-list",
    "--reverse",
    "--right-only",
    "--cherry-pick",
    `${targetTagRef}...${baseRef}`,
  ]);
  const shas = splitLines(revList);
  const commits = shas.slice(0, limit).map((sha) => {
    const parentLine = runGit(["rev-list", "--parents", "-n", "1", sha]);
    const parentCount = parentLine.split(" ").length - 1;
    const subject = runGit(["show", "-s", "--format=%s", sha]);
    return {
      sha,
      subject,
      isMerge: parentCount > 1,
    };
  });
  return {
    count: shas.length,
    commits,
  };
}

function checkoutTargetBranch(baseRef, targetBranch) {
  runGit(["switch", "--detach", baseRef]);
  runGit(["switch", "-C", targetBranch]);
}

function mergeTargetTag(targetTagRef) {
  return runGitAllowFailure(["merge", "--no-ff", "--no-edit", targetTagRef], {
    stdio: ["ignore", "inherit", "inherit"],
  }).ok;
}

function collectFileLocalCommitSummary(targetTagRef, baseRef, path, limit = 5) {
  const logOutput = runGitAllowFailure([
    "log",
    "--format=%H%x09%s",
    `${targetTagRef}..${baseRef}`,
    "--",
    path,
  ]);
  if (!logOutput.ok || !logOutput.stdout) {
    return {
      count: 0,
      commits: [],
    };
  }

  const allCommits = splitLines(logOutput.stdout).map((line) => {
    const [sha, subject = ""] = line.split("\t");
    return { sha, subject };
  });
  return {
    count: allCommits.length,
    commits: allCommits.slice(0, limit),
  };
}

function collectConflictFiles(targetTagRef, baseRef) {
  const conflictOutput = runGitAllowFailure(["diff", "--name-only", "--diff-filter=U"]);
  if (!conflictOutput.ok || !conflictOutput.stdout) {
    return [];
  }

  return splitLines(conflictOutput.stdout).map((path) => {
    const localCommitSummary = collectFileLocalCommitSummary(targetTagRef, baseRef, path);
    return {
      path,
      localCommitCount: localCommitSummary.count,
      localCommits: localCommitSummary.commits,
    };
  });
}

function pushBranch(originRemote, targetBranch) {
  log(`Pushing ${targetBranch} to ${originRemote}`);
  runGit(["push", originRemote, `HEAD:refs/heads/${targetBranch}`], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  fetchOriginRemote(options.originRemote);
  fetchUpstreamRemote(options.upstreamRemote);

  const { tag: targetTag, tagRef: targetTagRef } = resolveTargetTag(options);
  const baseRef = resolveBaseRef(options);
  const targetBranch = resolveTargetBranch(options, targetTag);
  const localCommitSummary = collectLocalCommitSummary(targetTagRef, baseRef);

  if (remoteBranchExists(options.originRemote, targetBranch)) {
    printResult({
      status: "noop_existing_branch",
      baseRef,
      targetBranch,
      targetTag,
      localCommitCount: localCommitSummary.count,
      localCommits: localCommitSummary.commits,
      conflictFiles: [],
      pushed: false,
    });
    return;
  }

  if (isAncestor(targetTagRef, baseRef)) {
    printResult({
      status: "noop_up_to_date",
      baseRef,
      targetBranch,
      targetTag,
      localCommitCount: localCommitSummary.count,
      localCommits: localCommitSummary.commits,
      conflictFiles: [],
      pushed: false,
    });
    return;
  }

  if (options.dryRun) {
    printResult({
      status: "dry_run",
      baseRef,
      targetBranch,
      targetTag,
      localCommitCount: localCommitSummary.count,
      localCommits: localCommitSummary.commits,
      conflictFiles: [],
      pushed: false,
    });
    return;
  }

  checkoutTargetBranch(baseRef, targetBranch);
  if (!mergeTargetTag(targetTagRef)) {
    printResult({
      status: "merge_conflict",
      baseRef,
      targetBranch,
      targetTag,
      localCommitCount: localCommitSummary.count,
      localCommits: localCommitSummary.commits,
      conflictFiles: collectConflictFiles(targetTagRef, baseRef),
      pushed: false,
    });
    return;
  }

  if (options.push) {
    pushBranch(options.originRemote, targetBranch);
  }

  printResult({
    status: "created",
    baseRef,
    targetBranch,
    targetTag,
    localCommitCount: localCommitSummary.count,
    localCommits: localCommitSummary.commits,
    conflictFiles: [],
    pushed: options.push,
  });
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
