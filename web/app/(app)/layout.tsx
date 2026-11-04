import Link from "next/link";
import { signOut } from "@/app/login/actions";

export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link href="/" className="font-semibold tracking-tight text-text">
            Thư viện
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="h-9 rounded-lg px-3 text-sm text-text-muted transition-colors hover:bg-surface-raised hover:text-text active:scale-[0.98]"
            >
              Đăng xuất
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </>
  );
}
