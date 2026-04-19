import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // 스키마 파일 경로 (개별 파일 지정 — index.ts의 .js import 이슈 우회)
  schema: ['./src/schema/core.ts', './src/schema/evidence.ts', './src/schema/rollup.ts', './src/schema/domain.ts', './src/schema/code.ts', './src/schema/audit.ts', './src/schema/layers.ts', './src/schema/proof.ts', './src/schema/domainSemantic.ts'],
  // 마이그레이션 파일 출력 경로
  out: './src/migrations',
  // DB 드라이버 (PostgreSQL / embedded-postgres 공통)
  dialect: 'postgresql',
  driver: 'pg',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://archi_navi:archi_navi@127.0.0.1:54329/archi_navi',
  },
  verbose: true,
  strict: true,
});
