// Supabase(Postgres) 데이터베이스 연결.
// 사용자 결정: 저장소를 Neon 대신 Supabase로 쓴다. Supabase의 Transaction pooler 주소(포트 6543)로 접속한다.
// 서버 쪽(화면 서버 코드, 처리 스크립트)에서만 쓴다.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

function createDb(url: string) {
  // Transaction pooler는 미리 준비된 쿼리(prepared statement)를 지원하지 않아 끈다
  const client = postgres(url, { prepare: false, max: 5 });
  return { client, db: drizzle({ client, schema }) };
}

let connection: ReturnType<typeof createDb> | null = null;

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL이 비어 있습니다. .env 또는 배포 환경변수를 확인하세요.");
  }
  connection ??= createDb(url);
  return connection.db;
}

/** 처리 스크립트가 끝날 때 연결을 닫는다 (닫지 않으면 스크립트가 끝나지 않는다) */
export async function closeDb(): Promise<void> {
  if (!connection) return;
  await connection.client.end({ timeout: 5 });
  connection = null;
}

export type Db = ReturnType<typeof getDb>;
