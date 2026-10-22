// Drizzle 표 구조 변경(마이그레이션) 설정.
// 실행: npm run db:generate (변경 기록 만들기) → npm run db:migrate (Neon에 적용)

import { defineConfig } from "drizzle-kit";

// 로컬에서는 .env의 DATABASE_URL을 읽는다 (값은 출력하지 않음)
try {
  process.loadEnvFile(".env");
} catch {
  // .env가 없으면 이미 설정된 환경변수를 그대로 쓴다
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: false,
});
