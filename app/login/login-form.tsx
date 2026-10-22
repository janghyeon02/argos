"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <label htmlFor="password" className="text-sm font-medium text-muted">
        비밀번호
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        autoFocus
        className="h-11 rounded-lg border border-line bg-surface px-3 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      <button
        type="submit"
        disabled={pending}
        className="h-11 rounded-lg bg-ink font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "확인 중…" : "들어가기"}
      </button>
      {state.error && (
        <p role="alert" className="text-sm text-severe">
          {state.error}
        </p>
      )}
    </form>
  );
}
