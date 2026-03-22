#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat >&2 <<'EOF'
Usage:
  OPENCLAW_CONFIG_DIR=/path/to/state scripts/docker-host-model-auth.sh <subcommand> [args...]

Subcommands:
  login        Run `openclaw models auth login` against the bind-mounted Docker state
  setup-token  Run `openclaw models auth setup-token` against the bind-mounted Docker state
  paste-token  Run `openclaw models auth paste-token` against the bind-mounted Docker state
  add          Run `openclaw models auth add` against the bind-mounted Docker state

Environment:
  OPENCLAW_CONFIG_DIR             Host path mounted into the Docker container as /home/node/.openclaw
  OPENCLAW_WORKSPACE_DIR          Optional host workspace path mounted into /home/node/.openclaw/workspace
  OPENCLAW_DOCKER_AUTH_AGENT_ID   Agent id to target (default: configured default agent, fallback: main)
EOF
  exit 2
}

resolve_default_agent_id() {
  local raw=""

  if ! raw="$(
    OPENCLAW_STATE_DIR="${state_dir}" OPENCLAW_CONFIG_PATH="${config_path}" \
      pnpm openclaw agents list --json 2>/dev/null
  )"; then
    printf '%s' "main"
    return 0
  fi

  if ! printf '%s' "${raw}" | node -e '
    const fs = require("node:fs");
    const DEFAULT_AGENT_ID = "main";

    try {
      const raw = fs.readFileSync(0, "utf8");
      const list = JSON.parse(raw);
      if (!Array.isArray(list) || list.length === 0) {
        process.stdout.write(DEFAULT_AGENT_ID);
        process.exit(0);
      }
      const chosen = list.find((entry) => entry?.isDefault)?.id ?? list[0]?.id;
      process.stdout.write(typeof chosen === "string" && chosen.trim() ? chosen.trim() : DEFAULT_AGENT_ID);
    } catch {
      process.stdout.write(DEFAULT_AGENT_ID);
    }
  '; then
    printf '%s' "main"
  fi
}

if [[ $# -lt 1 ]]; then
  usage
fi

if [[ -z "${OPENCLAW_CONFIG_DIR:-}" ]]; then
  echo "OPENCLAW_CONFIG_DIR is required." >&2
  exit 1
fi

subcommand="$1"
shift

case "$subcommand" in
  add | login | paste-token | setup-token) ;;
  *) usage ;;
esac

state_dir="$(cd "${OPENCLAW_CONFIG_DIR}" && pwd)"
config_path="${OPENCLAW_CONFIG_PATH:-${state_dir}/openclaw.json}"
agent_id="${OPENCLAW_DOCKER_AUTH_AGENT_ID:-$(resolve_default_agent_id)}"
agent_dir="${state_dir}/agents/${agent_id}/agent"
workspace_dir_default="${state_dir}/workspace"
if [[ "${agent_id}" != "main" ]]; then
  workspace_dir_default="${state_dir}/workspace-${agent_id}"
fi

export OPENCLAW_STATE_DIR="${state_dir}"
export OPENCLAW_CONFIG_PATH="${config_path}"
export OPENCLAW_DOCKER_AUTH_AGENT_ID="${agent_id}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${workspace_dir_default}}"
# Keep helper-targeted auth writes inside the bind-mounted config dir even if the caller
# already exported agent-dir overrides for a different OpenClaw state directory.
export OPENCLAW_AGENT_DIR="${agent_dir}"
export PI_CODING_AGENT_DIR="${agent_dir}"

cd "${REPO_ROOT}"
exec pnpm openclaw models auth --agent "${agent_id}" "${subcommand}" "$@"
