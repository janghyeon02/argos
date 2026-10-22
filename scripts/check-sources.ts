// 출처 15곳에 실제로 접속되는지 확인한다.
// Design Ref: §5 — 출처마다 응답 코드, RSS 여부, 글 수를 보여준다. 수집은 하지 않는다.
// 실행: npm run check:sources

import { RULES } from "../lib/config/rules";
import { SOURCES } from "../lib/config/sources";

const USER_AGENT = RULES.collection.userAgent;
const TIMEOUT_MS = RULES.collection.fetchTimeoutMs;

type UrlCheck = { url: string; ok: boolean; note: string };

async function checkUrl(url: string, method: "rss" | "page"): Promise<UrlCheck> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) return { url, ok: false, note: `응답 ${response.status}` };
    if (method === "rss") {
      const isFeed = /<rss|<feed|<rdf:RDF/i.test(body.slice(0, 2000));
      const items = (body.match(/<item[\s>]|<entry[\s>]/gi) ?? []).length;
      if (!isFeed) return { url, ok: false, note: "RSS 형식이 아님" };
      // 글이 하나도 없으면 실제 글 목록이 아닌 주소일 수 있다
      return { url, ok: items > 0, note: items > 0 ? `RSS, 글 ${items}개` : "RSS지만 글이 없음" };
    }
    return { url, ok: body.length > 1000, note: `페이지 ${Math.round(body.length / 1024)}KB` };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "시간 초과" : "접속 실패";
    return { url, ok: false, note: reason };
  }
}

async function main(): Promise<void> {
  const byTier = [1, 2, 3].map((tier) => `${tier}등급 ${SOURCES.filter((source) => source.tier === tier).length}곳`);
  console.log(`출처 ${SOURCES.length}곳 (${byTier.join(", ")}) 접속 확인\n`);

  let failed = 0;
  // 출처마다 동시에 확인한다
  const results = await Promise.all(
    SOURCES.map(async (source) => ({
      source,
      checks: await Promise.all(source.urls.map((url) => checkUrl(url, source.method))),
    })),
  );

  for (const { source, checks } of results) {
    const allOk = checks.every((check) => check.ok);
    if (!allOk) failed++;
    console.log(`${allOk ? "✅" : "❌"} [${source.tier}] ${source.name} (${source.id}) — ${checks.map((check) => check.note).join(" / ")}`);
  }

  console.log(failed === 0 ? "\n모든 출처에 접속됩니다." : `\n접속에 문제가 있는 출처 ${failed}곳 — 주소를 확인하거나 같은 등급의 다른 출처로 바꾸세요.`);
  if (failed > 0) process.exitCode = 1;
}

void main();
