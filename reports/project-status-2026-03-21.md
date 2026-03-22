# 프로젝트 상태 보고서 (2026-03-21)

## 요약

현재 브랜치 `codex/stable-v2026.3.12-local`은 `v2026.3.12` 이후 인증 설정 쓰기 경합 완화와 Docker 기반 모델 인증 흐름 보강에 집중한 상태다. 핵심 변화는 auth profile 및 `openclaw.json` 업데이트에 대한 락 보호, Docker host 측 모델 인증 헬퍼 추가, `BRAVE_API_KEY` 전달 지원, 인증 쓰기 실패 원인 보존 강화, 그리고 GitHub Copilot 로그인 흐름의 `--agent` 포워딩 및 agent targeting 정합성 보강이다.

## 브랜치 상태

- 브랜치: `codex/stable-v2026.3.12-local`
- 워킹트리: dirty
- 추적된 수정 파일:
  - `.vscode/settings.json`
  - `docs/install/docker.md`
  - `scripts/docker-host-model-auth.sh`
  - `src/cli/models-cli.test.ts`
  - `src/cli/models-cli.ts`
  - `src/commands/models/auth.test.ts`
  - `src/commands/models/auth.ts`
  - `src/providers/github-copilot-auth.ts`
- 추적되지 않은 파일:
  - `reports/project-status-2026-03-21.md`
  - `src/providers/github-copilot-auth.test.ts`
- `v2026.3.12` 이후 커밋 스택:
  1. `5f6e8025b0` Auth: lock auth-profile writes across setup flows
  2. `8864f85c95` Models: serialize auth and config updates
  3. `48e351e2b1` Docker: add host-side model auth helper
  4. `37d2f4b299` Docker: pass Brave API key through compose env
  5. `087723c225` Models: fix docker auth helper targeting
  6. `56636e27f5` Auth: preserve profile write errors

## 기능 변경

- auth profile 쓰기와 `openclaw.json` 업데이트가 락으로 보호되어 동시 쓰기 경쟁 가능성이 줄어들었다.
- `models auth` 흐름은 에이전트 타기팅이 더 정밀해졌고, Docker host 측 인증 헬퍼를 사용하도록 확장되었다.
- `models auth login-github-copilot`도 상위 `--agent` 전달을 받고, GitHub Copilot 토큰을 선택된 에이전트의 auth store에 잠금 기반 경로로 저장하도록 보강되었다.
- Docker compose 환경이 `BRAVE_API_KEY`를 전달하도록 보강되었다.
- 인증 정보 쓰기 실패 시 원인(cause) 보존이 개선되어 디버깅 가능성이 높아졌다.

## 현재 수정 사항

- Docker host auth helper는 `OPENCLAW_WORKSPACE_DIR`가 없을 때 non-default agent의 기본 workspace 경로로 fallback 하도록 수정되었다.
- Docker host auth helper는 하드코딩된 `main` 대신 설정된 기본 에이전트를 우선 사용하고, lookup 실패 시에만 `main`으로 안전하게 fallback 한다.
- helper는 `OPENCLAW_DOCKER_AUTH_AGENT_ID` 및 `OPENCLAW_WORKSPACE_DIR`의 명시적 override를 유지하면서도, `OPENCLAW_AGENT_DIR` / `PI_CODING_AGENT_DIR`는 항상 `OPENCLAW_CONFIG_DIR` 내부의 대상 agent 경로로 재바인딩한다.
- `models auth` 경로는 ambient `OPENCLAW_AGENT_DIR` / `PI_CODING_AGENT_DIR` 리다이렉트를 기본적으로 무시하고, Docker helper가 같은 agent를 명시적으로 타기팅한 경우에만 그 override를 허용한다.
- 기본 에이전트에도 `--agent`를 명시한 경우, 해당 명시값이 env redirect보다 우선한다.
- `models auth login-github-copilot`은 상속된 `--agent`를 전달하고, 대상 agent dir을 동일한 규칙으로 해석하며, auth profile 쓰기에는 locked helper를 사용한다.

## 검증

- 최종 로컬 수정 이후 재검증:
  - `pnpm test src/commands/models/auth.test.ts src/cli/models-cli.test.ts src/providers/github-copilot-auth.test.ts`: 통과 (3 files, 22 tests)
  - `bash -n scripts/docker-host-model-auth.sh`: 통과
  - `pnpm exec oxfmt --check docs/install/docker.md reports/project-status-2026-03-21.md scripts/docker-host-model-auth.sh src/cli/models-cli.ts src/cli/models-cli.test.ts src/commands/models/auth.ts src/commands/models/auth.test.ts src/providers/github-copilot-auth.ts src/providers/github-copilot-auth.test.ts`: 통과
  - `git diff --check`: 통과
  - `pnpm build`: 통과
- 세션 초반 선행 검증:
  - `src/commands/models/auth.test.ts`
  - `src/commands/models/shared.test.ts`
  - `src/commands/auth-choice.apply.plugin-provider.test.ts`
  - `src/commands/onboard-auth.credentials.test.ts`
  - `pnpm openclaw agents list --json`
  - `pnpm build`
  - 당시 기준 모두 통과
- 주의:
  - 최신 로컬 수정 이후에는 전체 `pnpm check`, `pnpm test`를 다시 돌리지는 않았다.

## 잔여 리스크

- `src/commands/configure.wizard.ts` 및 `src/wizard/onboarding.ts` 계열의 broader config 저장 경로는 아직 locked helper로 완전히 수렴하지 않았다. 운영자 주도 setup 흐름이라 즉시성은 낮지만, stale in-memory config가 direct `writeConfigFile(...)`로 덮어쓰는 위험은 후속으로 남아 있다.
- `src/commands/models/shared.ts` 주변 락 경합 및 재시도 동작에 대한 집중 커버리지가 아직 부족하다.
- `src/commands/auth-profile-write.ts`의 실패 전파가 메인 onboarding / model-auth 호출부까지 올바르게 유지되는지에 대한 집중 커버리지가 아직 부족하다.
- GitHub Copilot 로그인 경로는 unit test로는 커버되지만, 실제 device-flow와 Docker helper 조합에 대한 end-to-end 검증은 아직 없다.
- `.vscode/settings.json`은 로컬 에디터 설정으로 보이며 제품 변경과 분리해 다루는 것이 적절하다.

## 권장 다음 단계

1. `src/commands/configure.wizard.ts`와 `src/wizard/onboarding.ts`의 direct config save 경로를 locked helper로 수렴시키는 follow-up patch를 분리한다.
2. `src/commands/models/shared.ts`의 락 경합 및 재시도 시나리오, `src/commands/auth-profile-write.ts`의 failure propagation 시나리오에 대한 테스트를 보강한다.
3. GitHub Copilot 로그인 경로에 대해 Docker helper 환경을 포함한 통합 검증 또는 최소 broader `pnpm check`/adjacent test 재실행을 추가한다.
4. 문서/로컬 설정 변경(`docs/install/docker.md`, `.vscode/settings.json`)은 제품 로직 변경과 분리해서 검토한다.
