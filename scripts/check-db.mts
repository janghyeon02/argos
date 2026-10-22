// Neon Postgres에 실제로 연결되는지 확인한다.
// Design Ref: §3.2 — Neon 공식 연결 도구(@neondatabase/serverless)로 접속한다.
// 접속 주소(DATABASE_URL)는 비밀 값이므로 화면에 출력하지 않는다.
// 실행: npm run check:db  (.env를 읽어 DATABASE_URL을 불러온다)

import { neon } from "@neondatabase/serverless";

// 오류 문구에 접속 주소가 섞여 나오지 않도록 가린다.
function hideSecrets(message: string, url: string): string {
  return message.split(url).join("[DATABASE_URL]").replace(/postgres(ql)?:\/\/\S+/gi, "[DATABASE_URL]");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim() ?? "";

  if (!url) {
    console.log("❌ DATABASE_URL이 비어 있습니다.");
    console.log("   Neon 콘솔(https://console.neon.tech)에서 프로젝트를 만든 뒤,");
    console.log("   Connect 화면의 접속 주소를 .env의 DATABASE_URL= 뒤에 붙여 넣고 다시 실행하세요.");
    process.exitCode = 1;
    return;
  }

  if (!/^postgres(ql)?:\/\//i.test(url)) {
    console.log("❌ DATABASE_URL 형식이 다릅니다. postgresql:// 로 시작하는 Neon 접속 주소를 넣어 주세요.");
    process.exitCode = 1;
    return;
  }

  const sql = neon(url);
  const startedAt = Date.now();

  try {
    const [row] = await sql`SELECT version() AS version, current_database() AS database`;
    const elapsed = Date.now() - startedAt;
    const version = String(row.version).split(" ").slice(0, 2).join(" ");
    console.log("✅ Neon Postgres 연결 성공");
    console.log(`   데이터베이스: ${row.database}`);
    console.log(`   버전: ${version}`);
    console.log(`   응답 시간: ${elapsed}ms`);

    // 만들어진 표 목록 (DESIGN 8장 — npm run db:migrate 후 14개)
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`;
    console.log(`   표: ${tables.length}개${tables.length ? ` (${tables.map((t) => t.table_name).join(", ")})` : " — npm run db:migrate로 만드세요"}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("❌ Neon Postgres 연결 실패");
    console.log(`   원인: ${hideSecrets(message, url)}`);
    console.log("   접속 주소가 맞는지, Neon 프로젝트가 켜져 있는지 확인하세요.");
    process.exitCode = 1;
  }
}

await main();
