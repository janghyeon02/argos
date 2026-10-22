// 화면 서버 코드에서 로그인 여부를 확인한다 (proxy.ts 다음의 실제 확인).
// cookies()를 읽으므로 이 함수를 부르는 컴포넌트는 <Suspense> 안에 둔다 (Next.js 16 cacheComponents 규칙).

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { isValidSession, SESSION_COOKIE } from "./auth";

export async function requireSession(): Promise<void> {
  // 요청이 들어왔을 때만 확인한다 (만료 확인에 현재 시각을 쓰므로 미리 그려 둘 수 없다)
  await connection();
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!isValidSession(value)) redirect("/login");
}
