import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "로그인 · 아르고스" };

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 shadow-sm">
        <div className="mb-8">
          <p className="text-xs font-semibold tracking-[0.2em] text-muted">GLOBAL RISK EARLY WARNING</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">아르고스</h1>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
