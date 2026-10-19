"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "./actions";

const initialState: SignInState = { error: null, email: "" };

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(signIn, initialState);

  return (
    <form action={formAction} className="grid gap-5" noValidate>
      <input type="hidden" name="next" value={next} />
      <div className="grid gap-2">
        <label htmlFor="email" className="text-sm font-medium text-text">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.email}
          className="h-11 rounded-lg border border-border bg-surface-raised px-3 text-text outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        />
      </div>
      <div className="grid gap-2">
        <label htmlFor="password" className="text-sm font-medium text-text">
          Mật khẩu
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-describedby={state.error ? "login-error" : undefined}
          className="h-11 rounded-lg border border-border bg-surface-raised px-3 text-text outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        />
        {state.error ? (
          <p id="login-error" role="alert" className="text-sm text-text">
            {state.error}
          </p>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="h-11 rounded-lg bg-accent px-4 font-medium text-accent-contrast transition-transform active:scale-[0.98] disabled:opacity-70"
      >
        {pending ? "Đang đăng nhập" : "Đăng nhập"}
      </button>
    </form>
  );
}
