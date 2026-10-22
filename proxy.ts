// 비밀번호 1차 확인: 로그인 쿠키가 없거나 서명이 맞지 않으면 /login으로 보낸다.
// Design Ref: §9 보안 — 실제 확인은 각 화면의 서버 코드(requireSession)가 한 번 더 한다.

import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, SESSION_COOKIE } from "@/lib/auth";

export function proxy(request: NextRequest) {
  if (isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const login = new URL("/login", request.url);
  return NextResponse.redirect(login);
}

export const config = {
  // 로그인 화면과 Next.js 내부 파일·아이콘은 검사하지 않는다
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico).*)"],
};
