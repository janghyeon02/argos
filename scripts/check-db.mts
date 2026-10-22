// Supabase(Postgres)에 실제로 연결되는지, 표가 만들어졌는지 확인한다.
// 접속 주소(DATABASE_URL)는 비밀 값이므로 화면에 출력하지 않는다.
// 실행: npm run check:db  (.env를 읽어 DATABASE_URL을 불러온다)

import postgres from "postgres";

// 오류 문구에 접속 주소가 섞여 나오지 않도록 가린다.
function hideSecrets(message: string, url: string): string {
  return message.split(url).join("[DATABASE_URL]").replace(/postgres(ql)?:\/\/\S+/gi, "[DATABASE_URL]");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim() ?? "";

  if (!url) {
    console.log("❌ DATABASE_URL이 비어 있습니다.");
    console.log("   Supabase 프로젝트의 Connect → Transaction pooler 주소를 .env의 DATABASE_URL= 뒤에 넣고 다시 실행하세요.");
    process.exitCode = 1;
    return;
  }

  if (!/^postgres(ql)?:\/\//i.test(url)) {
    console.log("❌ DATABASE_URL 형식이 다릅니다. postgresql:// 로 시작하는 접속 주소를 넣어 주세요.");
    process.exitCode = 1;
    return;
  }

  // Transaction pooler는 미리 준비된 쿼리를 지원하지 않아 끈다
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15 });
  const startedAt = Date.now();

  try {
    const [row] = await sql`SELECT version() AS version, current_database() AS database`;
    const elapsed = Date.now() - startedAt;
    const version = String(row.version).split(" ").slice(0, 2).join(" ");
    console.log("✅ 데이터베이스 연결 성공 (Supabase)");
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
    console.log("❌ 데이터베이스 연결 실패");
    console.log(`   원인: ${hideSecrets(message, url)}`);
    console.log("   접속 주소와 비밀번호가 맞는지, Supabase 프로젝트가 켜져 있는지 확인하세요.");
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
