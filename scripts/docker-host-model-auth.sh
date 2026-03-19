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
  OPENCLAW_DOCKER_AUTH_AGENT_ID   Agent id to target (default: main)
EOF
  exit 2
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
agent_id="${OPENCLAW_DOCKER_AUTH_AGENT_ID:-main}"
agent_dir="${state_dir}/agents/${agent_id}/agent"

export OPENCLAW_STATE_DIR="${state_dir}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${state_dir}/openclaw.json}"
export OPENCLAW_DOCKER_AUTH_AGENT_ID="${agent_id}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${state_dir}/workspace}"
export OPENCLAW_AGENT_DIR="${OPENCLAW_AGENT_DIR:-${agent_dir}}"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-${OPENCLAW_AGENT_DIR}}"

cd "${REPO_ROOT}"
exec pnpm openclaw models auth --agent "${agent_id}" "${subcommand}" "$@"
