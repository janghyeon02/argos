// 과거 검증용 자료 묶음 만들기: GDELT(무료 뉴스 기록)에서 우리 출처 언론사의 과거 기사 목록을 가져온다.
// Design Ref: §7.5 — 자료 묶음에는 제목·공개 시각·출처·링크만 담는다 (원문 전문 없음, PRD 7번).
// 사후 정보 누출을 막기 위해 키워드로 찾지 않고, 언론사 주소 기준으로 시간대별 기사 목록을 통째로 가져온다.
// GDELT는 5초에 1번만 요청할 수 있어 오래 걸린다 (사례 하나에 10~25분).
// 실행: npm run backtest:fetch                 (모든 사례 + 평온 기간)
//       npm run backtest:fetch -- --case=svb-2023

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RULES } from "../lib/config/rules";

type CaseWindow = { key: string; window: { start: string; end: string } };
const casesFile = JSON.parse(readFileSync("data/backtest/cases.json", "utf8")) as { cases: CaseWindow[]; calm: CaseWindow };

/** 언론사 주소 → 출처 id (GDELT의 domain 값과 끝부분을 맞춘다) */
const DOMAIN_TO_SOURCE: Record<string, string> = {
  "bbc.co.uk": "bbc", "bbc.com": "bbc", "cnbc.com": "cnbc", "nytimes.com": "nyt", "bloomberg.com": "bloomberg",
  "theguardian.com": "guardian", "ft.com": "ft", "aljazeera.com": "aljazeera", "dw.com": "dw", "france24.com": "france24",
  "euronews.com": "euronews", "politico.eu": "politico_eu",
  "yna.co.kr": "yonhap", "hankyung.com": "hankyung", "mk.co.kr": "mk", "newsis.com": "newsis", "scmp.com": "scmp",
  "nikkei.com": "nikkei_asia", "straitstimes.com": "straits_times", "indiatimes.com": "economic_times", "taipeitimes.com": "taipei_times",
  "nhk.or.jp": "nhk", "asahi.com": "asahi", "edaily.co.kr": "edaily", "einfomax.co.kr": "einfomax",
  "tagesschau.de": "tagesschau", "handelsblatt.com": "handelsblatt", "faz.net": "faz", "lemonde.fr": "lemonde",
  "francetvinfo.fr": "franceinfo", "ansa.it": "ansa", "ilsole24ore.com": "sole24ore", "cbc.ca": "cbc", "abc.net.au": "abc_au",
  "federalreserve.gov": "fed", "ecb.europa.eu": "ecb", "bankofengland.co.uk": "boe", "whitehouse.gov": "whitehouse",
  "arabnews.com": "arab_news", "themoscowtimes.com": "moscow_times",
};

/**
 * 한 번에 묻는 언론사 묶음과 시간 간격(시간).
 * GDELT는 질문이 길면 거절해서 묶음당 4곳까지만 넣고, 기사가 많은 묶음은 간격을 좁힌다 (한 번에 최대 250건).
 * 요청 수를 줄이려고 조기경보에 가장 중요한 영어 주요 언론·국내 언론·공식 발표 위주로 고른다.
 */
const GROUPS: { hours: number; domains: string[] }[] = [
  { hours: 3, domains: ["bbc.co.uk", "cnbc.com", "nytimes.com", "bloomberg.com"] },
  { hours: 6, domains: ["theguardian.com", "ft.com", "aljazeera.com", "dw.com"] },
  { hours: 6, domains: ["yna.co.kr", "hankyung.com", "mk.co.kr", "newsis.com"] },
  { hours: 24, domains: ["federalreserve.gov", "ecb.europa.eu", "bankofengland.co.uk", "whitehouse.gov"] },
];

const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";
// GDELT 요청 간격 제한(5초에 1번)보다 넉넉하게 기다린다
const WAIT_MS = 12000;
const RATE_LIMIT_WAIT_MS = 60000;

export type BundleArticle = { title: string; url: string; seenAt: string; domain: string; language: string; sourceId: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = (date: Date) => date.toISOString().replace(/[-:T]/g, "").slice(0, 14);

function sourceFor(domain: string): string | null {
  const match = Object.keys(DOMAIN_TO_SOURCE).find((key) => domain === key || domain.endsWith(`.${key}`));
  return match ? DOMAIN_TO_SOURCE[match] : null;
}

async function query(domains: string[], start: Date, end: Date): Promise<{ items: BundleArticle[]; capped: boolean }> {
  const q = `(${domains.map((domain) => `domain:${domain}`).join(" OR ")})`;
  const url = `${GDELT}?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=250&format=json&sort=dateasc&startdatetime=${stamp(start)}&enddatetime=${stamp(end)}`;
  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await fetch(url, { headers: { "User-Agent": RULES.collection.userAgent }, signal: AbortSignal.timeout(60000) }).catch(() => null);
    const text = response ? await response.text() : "";
    if (response?.ok && text.trim().startsWith("{")) {
      const data = JSON.parse(text) as { articles?: { title: string; url: string; seendate: string; domain: string; language: string }[] };
      const items = (data.articles ?? []).flatMap((article) => {
        const sourceId = sourceFor(article.domain);
        if (!sourceId) return [];
        const s = article.seendate; // 20241203T131500Z
        const seenAt = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
        return [{ title: article.title.trim(), url: article.url, seenAt, domain: article.domain, language: article.language, sourceId }];
      });
      return { items, capped: (data.articles ?? []).length >= 250 };
    }
    if (text.includes("too short or too long")) throw new Error("GDELT가 질문이 너무 길다고 거절했습니다 (묶음의 언론사 수를 줄이세요)");
    // 요청 간격 제한에 걸리면 1분 기다렸다가 다시 묻는다
    await sleep(RATE_LIMIT_WAIT_MS);
  }
  throw new Error(`GDELT 응답 실패 (${stamp(start)}~${stamp(end)})`);
}

async function fetchCase(entry: CaseWindow): Promise<void> {
  const dir = path.join("data/backtest", entry.key);
  const file = path.join(dir, "articles.json");
  if (existsSync(file)) {
    console.log(`⏭  ${entry.key} — 이미 있음 (다시 받으려면 ${file}를 trash-can으로 옮기세요)`);
    return;
  }
  const start = new Date(entry.window.start);
  const end = new Date(entry.window.end);
  const byUrl = new Map<string, BundleArticle>();
  let calls = 0;
  let capped = 0;

  for (const group of GROUPS) {
    for (let from = start.getTime(); from < end.getTime(); from += group.hours * 3_600_000) {
      const to = new Date(Math.min(from + group.hours * 3_600_000, end.getTime()));
      const result = await query(group.domains, new Date(from), to);
      calls++;
      if (result.capped) capped++;
      for (const item of result.items) if (!byUrl.has(item.url)) byUrl.set(item.url, item);
      if (calls % 20 === 0) console.log(`  … ${entry.key}: 요청 ${calls}번, 기사 ${byUrl.size}건`);
      await sleep(WAIT_MS);
    }
  }

  const items = [...byUrl.values()].sort((a, b) => a.seenAt.localeCompare(b.seenAt));
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ key: entry.key, fetchedAt: new Date().toISOString(), source: "GDELT DOC 2.0", calls, cappedCalls: capped, articles: items }, null, 1));
  const bySource = Object.entries(items.reduce<Record<string, number>>((acc, item) => ((acc[item.sourceId] = (acc[item.sourceId] ?? 0) + 1), acc), {}))
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id} ${n}`)
    .join(", ");
  console.log(`✅ ${entry.key} — 기사 ${items.length}건 (요청 ${calls}번, 250건 한도에 닿은 요청 ${capped}번)\n   출처별: ${bySource}`);
}

async function main(): Promise<void> {
  const only = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
  const all = [...casesFile.cases, casesFile.calm];
  const targets = only ? all.filter((entry) => entry.key === only) : all;
  if (targets.length === 0) throw new Error(`사례를 찾지 못했습니다: ${only}`);
  for (const entry of targets) await fetchCase(entry);
}

main().catch((error) => {
  console.log(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
