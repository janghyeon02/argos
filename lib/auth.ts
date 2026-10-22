// 화면 비밀번호 로그인용 쿠키 서명·확인.
// Design Ref: §9 보안 — proxy.ts가 1차로, 각 화면 서버 코드가 다시 쿠키 서명을 확인한다.
// 쿠키 값은 "만료시각.서명" 형태이고, 서명은 SESSION_SECRET으로 만든 HMAC이다. 브라우저 스크립트는 읽을 수 없다(httpOnly).

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "argos_session";
/** 로그인 유지 기간 */
export const SESSION_DAYS = 7;

function secret(): string {
  const value = process.env.SESSION_SECRET?.trim();
  if (!value) throw new Error("SESSION_SECRET이 비어 있습니다. .env 또는 배포 환경변수를 확인하세요.");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 새 로그인 쿠키 값을 만든다 */
export function createSessionValue(now: Date = new Date()): string {
  const expires = String(now.getTime() + SESSION_DAYS * 86_400_000);
  return `${expires}.${sign(expires)}`;
}

/** 쿠키 값의 서명과 만료를 확인한다 */
export function isValidSession(value: string | undefined, now: Date = new Date()): boolean {
  if (!value) return false;
  const [expires, signature] = value.split(".");
  if (!expires || !signature || !safeEqual(signature, sign(expires))) return false;
  return Number(expires) > now.getTime();
}

/** 입력한 비밀번호가 SITE_PASSWORD와 같은지 (걸리는 시간으로 정답을 짐작할 수 없게 비교) */
export function isCorrectPassword(input: string): boolean {
  const expected = process.env.SITE_PASSWORD?.trim();
  if (!expected) throw new Error("SITE_PASSWORD가 비어 있습니다. .env 또는 배포 환경변수를 확인하세요.");
  // 길이가 달라도 같은 시간이 걸리도록 서명끼리 비교한다
  return safeEqual(sign(`pw:${input}`), sign(`pw:${expected}`));
}
