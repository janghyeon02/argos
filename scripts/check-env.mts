// .env에 아르고스에 필요한 키가 모두 들어 있는지 점검한다.
// Design Ref: §9 키 보관 위치 — 키 이름과 쓰는 곳은 DESIGN.md 9장 표와 같게 유지한다.
// 값은 절대 출력하지 않고 "값 있음 / 값 없음 / 줄 없음"만 보여준다.
// 실행: npm run check:env  (Node가 TypeScript를 바로 실행하도록 .mts 확장자 사용)

import { existsSync, readFileSync } from "node:fs";

type RequiredKey = {
  name: string;
  description: string;
  usedIn: string;
};

// DESIGN.md 9장에 정한 필수 키 (AI는 사용자 결정으로 Claude 대신 OpenAI 사용)
const REQUIRED_KEYS: RequiredKey[] = [
  { name: "OPENAI_API_KEY", description: "OpenAI API 키 (gpt-4o-mini)", usedIn: "GitHub Actions Secrets" },
  { name: "DATABASE_URL", description: "Neon 데이터베이스 접속 주소", usedIn: "GitHub Actions Secrets, Vercel" },
  { name: "TELEGRAM_BOT_TOKEN", description: "텔레그램 봇 토큰", usedIn: "GitHub Actions Secrets" },
  { name: "TELEGRAM_CHAT_ID", description: "알림을 받을 텔레그램 대화 ID", usedIn: "GitHub Actions Secrets" },
  { name: "SITE_URL", description: "알림 속 이슈 상세 링크용 사이트 주소", usedIn: "GitHub Actions Secrets" },
  { name: "SITE_PASSWORD", description: "웹 화면 비밀번호", usedIn: "Vercel" },
  { name: "SESSION_SECRET", description: "로그인 쿠키 서명 키", usedIn: "Vercel" },
];

// CLAUDE.md 규칙에 따라 작업 도구(CLI) 인증에 쓰는 키 — 앱 자체에는 쓰지 않는다.
const TOOL_KEYS = ["GITHUB_TOKEN", "SUPABASE_ACCESS_TOKEN", "VERCEL_TOKEN"];

const ENV_PATH = ".env";

// .env를 "키 → 값이 있는지" 형태로만 읽는다. 값 자체는 어디에도 담지 않는다.
function readKeyStatus(path: string): Map<string, boolean> {
  const status = new Map<string, boolean>();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).replace(/^export\s+/, "").trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    status.set(name, value.length > 0);
  }
  return status;
}

function main(): void {
  if (!existsSync(ENV_PATH)) {
    console.log("❌ .env 파일이 없습니다. 프로젝트 폴더에 .env를 만든 뒤 다시 실행하세요.");
    process.exitCode = 1;
    return;
  }

  const status = readKeyStatus(ENV_PATH);
  const missing: RequiredKey[] = [];

  console.log("아르고스 필수 키 점검 (DESIGN.md 9장)\n");
  for (const key of REQUIRED_KEYS) {
    const state = status.has(key.name) ? (status.get(key.name) ? "값 있음" : "값 없음") : "줄 없음";
    const mark = state === "값 있음" ? "✅" : "❌";
    console.log(`${mark} ${key.name} — ${state}  (${key.description} / ${key.usedIn})`);
    if (state !== "값 있음") missing.push(key);
  }

  // 브라우저에 노출되는 이름은 금지 (PRD 7번)
  const publicKeys = [...status.keys()].filter((name) => name.startsWith("NEXT_PUBLIC_"));
  if (publicKeys.length > 0) {
    console.log(`\n⚠️  NEXT_PUBLIC_으로 시작하는 키가 있습니다: ${publicKeys.join(", ")} — 비밀 값이면 이름을 바꾸세요.`);
  }

  const known = new Set([...REQUIRED_KEYS.map((key) => key.name), ...TOOL_KEYS]);
  const toolKeys = TOOL_KEYS.filter((name) => status.has(name));
  const otherKeys = [...status.keys()].filter((name) => !known.has(name) && !name.startsWith("NEXT_PUBLIC_"));
  if (toolKeys.length > 0) console.log(`\n참고: 작업 도구용 키 (CLAUDE.md) — ${toolKeys.join(", ")}`);
  if (otherKeys.length > 0) console.log(`참고: 설계에 없는 키 (지금은 쓰지 않음) — ${otherKeys.join(", ")}`);

  if (missing.length === 0) {
    console.log("\n모든 필수 키가 준비되었습니다.");
    return;
  }

  console.log(`\n필수 키 ${missing.length}개가 비어 있습니다. 아래 줄을 .env에 붙여 넣고 = 뒤에 값을 직접 채우세요.\n`);
  for (const key of missing) {
    if (!status.has(key.name)) console.log(`${key.name}=`);
  }
  process.exitCode = 1;
}

main();
