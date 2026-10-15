import { signOut } from "./login/actions";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-text">Thư viện</h1>
      <p className="mt-3 text-text-muted">Đang đăng nhập với {user?.email}. Chưa có truyện nào trong thư viện.</p>
      <form action={signOut} className="mt-8">
        <button type="submit" className="h-10 rounded-lg border border-border px-4 text-text transition-transform active:scale-[0.98]">
          Đăng xuất
        </button>
      </form>
    </main>
  );
}
