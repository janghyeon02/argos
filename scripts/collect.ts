// 수집 실행: 출처 15곳에서 새 자료를 가져와 저장하고, 실행 기록(runs)을 남긴다.
// 실행: npm run collect                       (실제 저장)
//       npm run collect -- --dry-run          (저장하지 않고 읽기만)
//       npm run collect -- --as-of=2026-10-20T09:00:00+09:00   (그 시각까지 공개된 글만)

import { eq } from "drizzle-orm";
import { getDb } from "../lib/db/client";
import { runs } from "../lib/db/schema";
import { SOURCES } from "../lib/config/sources";
import { collect } from "../lib/pipeline/collect";

function readArgs(): { dryRun: boolean; asOf?: Date } {
  const args = process.argv.slice(2);
  const asOfArg = args.find((arg) => arg.startsWith("--as-of="))?.slice("--as-of=".length);
  const asOf = asOfArg ? new Date(asOfArg) : undefined;
  if (asOf && Number.isNaN(asOf.getTime())) throw new Error(`--as-of 시각 형식이 잘못되었습니다: ${asOfArg}`);
  return { dryRun: args.includes("--dry-run"), asOf };
}

async function main(): Promise<void> {
  const { dryRun, asOf } = readArgs();
  const db = getDb();
  const startedAt = new Date();

  console.log(`수집 시작${dryRun ? " (저장 안 함)" : ""}${asOf ? ` — 기준 시각 ${asOf.toISOString()}` : ""}\n`);

  const [run] = dryRun ? [undefined] : await db.insert(runs).values({ mode: "live", startedAt, asOf }).returning({ id: runs.id });

  try {
    const results = await collect({ db, asOf, dryRun, now: startedAt });
    const names = new Map(SOURCES.map((source) => [source.id, source.name]));

    for (const result of results) {
      const name = names.get(result.sourceId) ?? result.sourceId;
      if (result.error) console.log(`❌ ${name} — ${result.error}`);
      else if (result.skipped) console.log(`⏭  ${name} — 최근에 읽어서 건너뜀`);
      else console.log(`✅ ${name} — 읽음 ${result.fetched} / 새로 저장 ${result.inserted}`);
    }

    const counts = {
      sources: results.length,
      failedSources: results.filter((result) => result.error).length,
      skippedSources: results.filter((result) => result.skipped).length,
      fetched: results.reduce((sum, result) => sum + result.fetched, 0),
      inserted: results.reduce((sum, result) => sum + result.inserted, 0),
    };
    const durationMs = Date.now() - startedAt.getTime();
    console.log(
      `\n합계: 읽음 ${counts.fetched} / 새로 저장 ${counts.inserted} / 실패 출처 ${counts.failedSources} / 건너뜀 ${counts.skippedSources} — ${durationMs}ms`,
    );

    if (run) {
      // 출처 일부가 실패해도 실행 자체는 성공으로 본다 (DESIGN 10장)
      await db.update(runs).set({ finishedAt: new Date(), success: true, durationMs, counts }).where(eq(runs.id, run.id));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\n❌ 수집 실행 실패: ${message}`);
    if (run) {
      await db
        .update(runs)
        .set({ finishedAt: new Date(), success: false, durationMs: Date.now() - startedAt.getTime(), error: message })
        .where(eq(runs.id, run.id));
    }
    process.exitCode = 1;
  }
}

void main();
