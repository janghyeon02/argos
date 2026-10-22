// Neon 데이터베이스 연결.
// Design Ref: §3.2 — Neon 연결 도구 + Drizzle ORM. 서버 쪽(화면 서버 코드, 처리 스크립트)에서만 쓴다.

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL이 비어 있습니다. .env 또는 배포 환경변수를 확인하세요.");
  }
  return drizzle(neon(url), { schema });
}

export type Db = ReturnType<typeof getDb>;
