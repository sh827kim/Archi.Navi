# Archi.Navi — npm 배포/설치 가이드

작성일: 2026-03-01  
대상: Archi.Navi 메인테이너 및 npm 패키지 사용자

---

## 1. 목표

- 개발자가 npm에서 패키지를 설치한 뒤 `anavi up`으로 웹 앱을 바로 실행할 수 있어야 한다.
- `anavi up` 실행 후 초기 진입은 워크스페이스 목록 화면(`/workspaces`)이어야 한다.
- 배포 단위는 아래 7개 패키지다.
  - `@archi-navi/shared`
  - `@archi-navi/db`
  - `@archi-navi/core`
  - `@archi-navi/inference`
  - `@archi-navi/ui`
  - `@archi-navi/web`
  - `@archi-navi/cli`

---

## 2. 사용자 설치/실행

```bash
npm install -g @archi-navi/cli @archi-navi/web
anavi up --port 3000
```

초기 화면에서 워크스페이스를 직접 생성한 뒤 사용한다.

기본 런타임 경로:
- `PGLITE_DATA_DIR=~/.archi-navi/data`
- `MIGRATIONS_FOLDER`는 설치된 `@archi-navi/db` 경로에서 자동 탐색

필요 시 덮어쓰기:

```bash
PGLITE_DATA_DIR="$HOME/.archi-navi/data" \
MIGRATIONS_FOLDER="/custom/path/to/migrations" \
anavi up --port 3000
```

---

## 3. 메인테이너 배포 절차

루트에서 실행:

```bash
# 1) pack 검증
pnpm release:pack:npm

# 2) publish dry-run
pnpm release:publish:npm:dry-run

# 3) 실제 publish
pnpm release:publish:npm
```

배포 스크립트:
- `scripts/release/pack-npm.sh`
- `scripts/release/publish-npm.sh`

publish 순서(의존성 순):
1. `@archi-navi/shared`
2. `@archi-navi/db`
3. `@archi-navi/core`
4. `@archi-navi/inference`
5. `@archi-navi/ui`
6. `@archi-navi/web`
7. `@archi-navi/cli`

---

## 4. 검증 체크리스트

1. `pnpm release:pack:npm` 결과로 `.release/tarballs/*.tgz`가 생성된다.
2. 패키지 tarball 내부 `package.json`의 내부 의존성이 `workspace:*`가 아닌 실제 버전(예: `0.1.0`)으로 치환된다.
3. `anavi up` 실행 시 마이그레이션이 정상 수행되고, `/workspaces` 목록 화면이 열린다.
4. 초기 화면 접속(`http://localhost:3000/workspaces`) 및 API 응답(`GET /api/workspaces`, `POST /api/workspaces`)이 정상이다.
