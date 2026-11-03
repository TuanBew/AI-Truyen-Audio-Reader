"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "@phosphor-icons/react/dist/ssr/Check";
import { List } from "@phosphor-icons/react/dist/ssr/List";
import { SpeakerHigh } from "@phosphor-icons/react/dist/ssr/SpeakerHigh";
import { X } from "@phosphor-icons/react/dist/ssr/X";
import type { TocPage } from "@/lib/data/novel";

type Props = {
  novelId: string;
  currentIndex: number;
  // TOC page that holds the current chapter; fetched the first time the drawer opens.
  initialPage: number;
};

type View = { status: "idle" | "loading" | "ready" | "error"; page: number; toc: TocPage | null; error: string | null };

const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";
const LOAD_ERROR = "Không tải được mục lục. Thử lại sau ít phút.";
const iconButton = `inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-raised hover:text-text active:scale-[0.98] ${FOCUS_RING}`;
const pageButton = `inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm text-text transition-colors hover:border-border-strong hover:bg-surface-raised active:scale-[0.98] disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-transparent ${FOCUS_RING}`;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

// Native <dialog> on the left edge. Escape and a click on the backdrop close it; T toggles it.
export function TocDrawer({ novelId, currentIndex, initialPage }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);
  const loadedOnce = useRef(false);
  const latestRequest = useRef(0);
  const [view, setView] = useState<View>({ status: "idle", page: initialPage, toc: null, error: null });

  const load = useCallback(
    async (page: number) => {
      const id = ++latestRequest.current;
      setView((v) => ({ ...v, status: "loading", page, error: null }));
      let next: View;
      try {
        const res = await fetch(`/api/novels/${novelId}/toc?page=${page}`, { headers: { Accept: "application/json" } });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const message = (body as { error?: unknown } | null)?.error;
          next = { status: "error", page, toc: null, error: typeof message === "string" ? message : LOAD_ERROR };
        } else {
          next = { status: "ready", page, toc: body as TocPage, error: null };
        }
      } catch {
        next = { status: "error", page, toc: null, error: LOAD_ERROR };
      }
      if (id === latestRequest.current) setView(next);
    },
    [novelId],
  );

  const toggle = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialog.open) {
      dialog.close();
      return;
    }
    dialog.showModal();
    if (!loadedOnce.current) {
      loadedOnce.current = true;
      void load(initialPage);
    }
  }, [initialPage, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "t" || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (e.defaultPrevented || isTyping(e.target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  // Bring the current chapter into view once its page is on screen.
  const showingCurrentPage = view.status === "ready" && view.toc?.items.some((i) => i.index === currentIndex);
  useEffect(() => {
    if (showingCurrentPage) currentRef.current?.scrollIntoView({ block: "center" });
  }, [showingCurrentPage]);

  const { toc } = view;
  const loading = view.status === "loading";

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label="Mục lục"
        aria-keyshortcuts="T"
        title="Mục lục (T)"
        className={iconButton}
      >
        <List size={22} aria-hidden="true" />
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby="toc-drawer-title"
        onClick={(e) => {
          // The backdrop belongs to the dialog element, and the dialog has no padding, so a click whose target is
          // the dialog itself landed on the backdrop.
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-dvh w-[min(24rem,90vw)] max-w-none flex-col border-r border-border bg-surface p-0 text-text open:flex backdrop:bg-[color-mix(in_srgb,var(--text)_40%,transparent)]"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border pl-4 pr-2">
          <h2 id="toc-drawer-title" className="font-semibold tracking-tight">
            Mục lục
          </h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Đóng mục lục"
            className={iconButton}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={loading}>
          {view.status === "error" ? (
            <div role="alert" className="space-y-3 p-4">
              <p className="text-text">{view.error}</p>
              <button type="button" onClick={() => void load(view.page)} className={pageButton}>
                Thử lại
              </button>
            </div>
          ) : toc ? (
            <ol className={`divide-y divide-border ${loading ? "opacity-60" : ""}`}>
              {toc.items.map((item) => {
                const current = item.index === currentIndex;
                return (
                  <li key={item.id} ref={current ? currentRef : undefined}>
                    <Link
                      href={`/read/${novelId}/${item.index}`}
                      aria-current={current ? "page" : undefined}
                      onClick={() => dialogRef.current?.close()}
                      className={`flex items-center gap-3 border-l-2 px-3 py-2.5 transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus)] ${
                        current ? "border-accent bg-surface-raised" : "border-transparent"
                      }`}
                    >
                      <span className="w-10 shrink-0 text-right text-sm tabular-nums text-text-muted">{item.index}</span>
                      <span
                        className={`min-w-0 flex-1 truncate ${current ? "font-medium text-text" : item.listened ? "text-text-muted" : "text-text"}`}
                      >
                        {item.title}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5 text-text-muted">
                        {item.isNew ? (
                          <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-contrast">
                            Mới
                          </span>
                        ) : null}
                        {item.audioReady ? (
                          <span title="Âm thanh sẵn sàng" className="inline-flex">
                            <SpeakerHigh size={16} aria-hidden="true" className="text-accent" />
                            <span className="sr-only">Âm thanh sẵn sàng</span>
                          </span>
                        ) : null}
                        {item.listened ? (
                          <span title="Đã nghe" className="inline-flex">
                            <Check size={16} aria-hidden="true" />
                            <span className="sr-only">Đã nghe</span>
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p role="status" className="p-4 text-text-muted">
              Đang tải mục lục…
            </p>
          )}
        </div>

        {toc && toc.pageCount > 1 ? (
          <nav aria-label="Phân trang mục lục" className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-3">
            <button
              type="button"
              disabled={loading || toc.page <= 1}
              onClick={() => void load(toc.page - 1)}
              className={pageButton}
            >
              Trang trước
            </button>
            <span className="text-sm tabular-nums text-text-muted">
              Trang {toc.page}/{toc.pageCount}
            </span>
            <button
              type="button"
              disabled={loading || toc.page >= toc.pageCount}
              onClick={() => void load(toc.page + 1)}
              className={pageButton}
            >
              Trang sau
            </button>
          </nav>
        ) : null}
      </dialog>
    </>
  );
}
