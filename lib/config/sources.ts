// 출처 목록(config/sources.json)을 읽고 형식을 검사한다.
// Design Ref: §5 출처 확인 결과 — 출처를 바꿀 때는 sources.json만 고친다.

import { z } from "zod";
import raw from "../../config/sources.json";

const SourceSchema = z.object({
  /** 데이터베이스 sources 표의 키 (영문 소문자·숫자·밑줄) */
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  /** 1: 공식 발표, 2: 국내외 주요 통신사·언론·연구기관, 3: 관점이 치우칠 수 있거나 규모가 작은 매체 */
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** rss: RSS 읽기, page: 목록 페이지 읽기 */
  method: z.enum(["rss", "page"]),
  /** 원문 언어 — PRD 6번: 영어·한국어, 그리고 OECD 주요국(G7) 현지어(일본어·독일어·프랑스어·이탈리아어) */
  language: z.enum(["en", "ko", "ja", "de", "fr", "it"]),
  /** 매체가 속한 나라·지역 — 현지에서 먼저 크게 다루는 이슈를 지역별로 보기 위해 */
  region: z.string().min(1),
  urls: z.array(z.url()).min(1),
  /** 접근 방식과 확인 결과 메모 */
  access: z.string(),
  /** 이 시간 안에는 다시 읽지 않는다 (페이지 읽기 출처에 부담을 주지 않기 위해) */
  minIntervalHours: z.number().positive().optional(),
});

const SourcesFileSchema = z
  .object({
    checkedAt: z.string(),
    sources: z.array(SourceSchema).min(1),
  })
  .refine((file) => new Set(file.sources.map((source) => source.id)).size === file.sources.length, {
    message: "출처 id가 중복되었습니다",
  });

export type Source = z.infer<typeof SourceSchema>;

/** 형식 검사를 통과한 출처 목록 */
export const SOURCES: Source[] = SourcesFileSchema.parse(raw).sources;

/** id로 출처 찾기 */
export function getSource(id: string): Source | undefined {
  return SOURCES.find((source) => source.id === id);
}
