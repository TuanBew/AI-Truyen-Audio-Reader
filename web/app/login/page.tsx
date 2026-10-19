import type { Metadata } from "next";
import { safeNextPath } from "@/lib/auth/paths";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Đăng nhập · AudioTruyen" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="grid min-h-[100dvh] place-items-center px-4">
      <section className="w-full max-w-sm">
        <p className="text-sm text-text-muted">AudioTruyen</p>
        <h1 className="mt-1 mb-8 text-3xl font-semibold tracking-tight text-text">Đăng nhập</h1>
        <LoginForm next={safeNextPath(next)} />
      </section>
    </main>
  );
}
