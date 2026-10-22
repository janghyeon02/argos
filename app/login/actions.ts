"use server";

// 비밀번호 확인 서버 액션.
// Design Ref: §9 — 같은 접속 주소에서 5번 틀리면 15분 동안 막는다.

import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSessionValue, isCorrectPassword, SESSION_COOKIE, SESSION_DAYS } from "@/lib/auth";
import { RULES } from "@/lib/config/rules";
import { getDb } from "@/lib/db/client";
import { loginAttempts } from "@/lib/db/schema";

export type LoginState = { error?: string };

async function clientIp(): Promise<string> {
  const list = await headers();
  return list.get("x-forwarded-for")?.split(",")[0]?.trim() || list.get("x-real-ip") || "unknown";
}

export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  const ip = await clientIp();
  const db = getDb();
  const now = new Date();

  const [attempt] = await db.select().from(loginAttempts).where(eq(loginAttempts.ip, ip));
  if (attempt?.lockedUntil && attempt.lockedUntil > now) {
    const minutes = Math.ceil((attempt.lockedUntil.getTime() - now.getTime()) / 60_000);
    return { error: `비밀번호를 여러 번 틀려 잠겼습니다. ${minutes}분 뒤 다시 시도하세요.` };
  }

  if (!isCorrectPassword(password)) {
    const failed = (attempt?.failedCount ?? 0) + 1;
    const lock = failed >= RULES.login.maxFailedAttempts;
    const values = {
      failedCount: lock ? 0 : failed,
      lockedUntil: lock ? new Date(now.getTime() + RULES.login.lockMinutes * 60_000) : null,
      updatedAt: now,
    };
    await db
      .insert(loginAttempts)
      .values({ ip, ...values })
      .onConflictDoUpdate({ target: loginAttempts.ip, set: values });
    return {
      error: lock
        ? `비밀번호를 ${RULES.login.maxFailedAttempts}번 틀려 ${RULES.login.lockMinutes}분 동안 잠겼습니다.`
        : `비밀번호가 다릅니다. (${failed}/${RULES.login.maxFailedAttempts})`,
    };
  }

  if (attempt) await db.delete(loginAttempts).where(eq(loginAttempts.ip, ip));
  (await cookies()).set(SESSION_COOKIE, createSessionValue(now), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
  redirect("/");
}
