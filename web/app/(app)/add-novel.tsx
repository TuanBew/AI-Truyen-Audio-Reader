"use client";

import { useActionState, useState } from "react";
import { addNovel, type AddNovelState } from "./actions";

const initial: AddNovelState = { error: null, ok: false };

export function AddNovel() {
  const [url, setUrl] = useState("");
  // The action clears the field itself on success; on an error React's form reset would otherwise wipe the typed link.
  const [state, formAction, pending] = useActionState(async (prev: AddNovelState, formData: FormData) => {
    const next = await addNovel(prev, formData);
    if (next.ok) setUrl("");
    return next;
  }, initial);

  return (
    <form action={formAction} className="max-w-xl">
      <label htmlFor="novel-url" className="block text-sm font-medium text-text">
        Thêm truyện
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="novel-url"
          name="url"
          type="text"
          inputMode="url"
          autoComplete="off"
          required
          placeholder="https://truyenfull.live/ten-truyen/"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-describedby="novel-url-status"
          className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
        />
        <button
          type="submit"
          disabled={pending}
          className="h-10 shrink-0 rounded-lg bg-accent px-4 text-sm font-medium text-accent-contrast transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          {pending ? "Đang thêm…" : "Thêm"}
        </button>
      </div>
      <p id="novel-url-status" role="status" className="mt-2 min-h-5 text-sm text-text-muted">
        {state.error ?? (state.ok ? "Đã thêm vào hàng chờ. Worker sẽ tải mục lục khi đang bật." : "")}
      </p>
    </form>
  );
}
