"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CircleNotch } from "@phosphor-icons/react/dist/ssr/CircleNotch";
import { FastForward } from "@phosphor-icons/react/dist/ssr/FastForward";
import { Keyboard } from "@phosphor-icons/react/dist/ssr/Keyboard";
import { Pause } from "@phosphor-icons/react/dist/ssr/Pause";
import { Play } from "@phosphor-icons/react/dist/ssr/Play";
import { Rewind } from "@phosphor-icons/react/dist/ssr/Rewind";
import { SkipBack } from "@phosphor-icons/react/dist/ssr/SkipBack";
import { SkipForward } from "@phosphor-icons/react/dist/ssr/SkipForward";
import { SpeakerHigh } from "@phosphor-icons/react/dist/ssr/SpeakerHigh";
import { generationState } from "@/lib/audio/generation";
import { bannerMessage } from "@/lib/player/banner";
import { PlayerController } from "@/lib/player/controller";
import { keyAction } from "@/lib/player/keys";
import { createPlayerStore } from "@/lib/player/store";
import { estimateDurationMs, formatClock, timelineRanges } from "@/lib/player/timeline";
import type { AudioSnapshot } from "@/lib/types";
import { ensureChapterAudio, prefetchAfter, readAudioSnapshot, retrySynthesis } from "./actions";
import { FollowPill } from "./follow-pill";
import { TOGGLE_TOC_EVENT } from "./toc-event";

type Props = {
  chapterId: string;
  novelId: string;
  chapterIndex: number;
  snapshot: AudioSnapshot;
  // Server clock at render: the first client render must give the same banner as the server's.
  nowMs: number;
  initialSegment: number | null;
  textChars: number;
  prevHref: string | null;
  nextHref: string | null;
  // Arrived by auto-advance (?autoplay=1): start playing on mount.
  autoplay: boolean;
};

const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]";
const iconButton = `inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-raised hover:text-text active:scale-[0.98] ${FOCUS_RING}`;
const iconOff = "inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-text-muted opacity-40";
const smallButton = `inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm text-text transition-colors hover:border-border-strong hover:bg-surface-raised active:scale-[0.98] ${FOCUS_RING}`;

const SHORTCUTS: [string, string][] = [
  ["Space", "Phát hoặc tạm dừng"],
  ["← →", "Đoạn trước, đoạn sau"],
  ["Shift + ← →", "Chương trước, chương sau"],
  ["[ ]", "Chậm hơn, nhanh hơn"],
  ["T", "Mục lục"],
  ["?", "Bảng phím tắt"],
];

function workerAgoMin(lastSeen: string | null, nowMs: number): number | null {
  const seen = lastSeen === null ? Number.NaN : Date.parse(lastSeen);
  return Number.isNaN(seen) ? null : Math.max(0, Math.floor((nowMs - seen) / 60_000));
}

function formatRate(rate: number): string {
  return `${String(rate).replace(".", ",")}×`;
}

// The docked bar, the generation banner and the shortcuts dialog. The reading column itself stays server-rendered:
// the controller finds its segments in the DOM. The bar is fixed and sized in CSS, so it takes no part in layout (CLS)
// and exists in the server HTML before this island hydrates.
export function Player(props: Props) {
  const router = useRouter();
  const [store] = useState(() =>
    createPlayerStore({
      gen: generationState(props.snapshot, props.nowMs),
      workerAgoMin: workerAgoMin(props.snapshot.workerLastSeen, props.nowMs),
    }),
  );
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  // Set by the effect below; read only in event handlers, never during render.
  const ctl = useRef<PlayerController | null>(null);
  const helpRef = useRef<HTMLDialogElement>(null);

  // One controller per chapter: the page re-rendering with a fresher snapshot must not tear playback down, so the
  // effect depends on the chapter only and takes the props of that first render.
  useEffect(() => {
    const p = props;
    const controller = new PlayerController({
      chapterId: p.chapterId,
      novelId: p.novelId,
      chapterIndex: p.chapterIndex,
      snapshot: p.snapshot,
      initialSegment: p.initialSegment,
      store,
      actions: { ensureChapterAudio, readAudioSnapshot, retrySynthesis, prefetchAfter },
      // App Router client navigation, so the user's activation carries over and the next chapter may play at once.
      nextHref: p.nextHref ? `${p.nextHref}?autoplay=1` : null,
      navigate: (href) => router.push(href),
    });
    ctl.current = controller;
    if (p.autoplay) {
      controller.play(); // a rejection (no activation) leaves the play button with TEXT_AUTOPLAY
      // So that a reload of this page does not start playing again.
      const url = new URL(window.location.href);
      if (url.searchParams.has("autoplay")) {
        url.searchParams.delete("autoplay");
        window.history.replaceState(window.history.state, "", url);
      }
    }
    return () => {
      controller.destroy();
      ctl.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.chapterId, store]);

  // The single keyboard listener of the reader (the TOC drawer listens for TOGGLE_TOC_EVENT instead of a key).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const action = keyAction({
        key: e.key,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        targetTag: target?.tagName ?? "",
        targetEditable: target?.isContentEditable ?? false,
      });
      if (action === null) return;

      const help = helpRef.current;
      if (action === "help" && help?.open) {
        help.close();
        e.preventDefault();
        return;
      }
      // A modal is open (the TOC drawer or the help): only T still reaches the TOC.
      const modalOpen = document.querySelector("dialog[open]") !== null;
      if (modalOpen && !(action === "toc" && !help?.open)) return;
      if (e.repeat && (action === "toggle" || action === "toc" || action === "help")) {
        e.preventDefault();
        return;
      }

      e.preventDefault();
      switch (action) {
        case "toggle":
          ctl.current?.toggle();
          break;
        case "prevSeg":
          ctl.current?.stepSegment(-1);
          break;
        case "nextSeg":
          ctl.current?.stepSegment(1);
          break;
        case "prevChapter":
          if (props.prevHref) router.push(props.prevHref);
          break;
        case "nextChapter":
          if (props.nextHref) router.push(props.nextHref);
          break;
        case "slower":
          ctl.current?.nudgeRate(-1);
          break;
        case "faster":
          ctl.current?.nudgeRate(1);
          break;
        case "toc":
          window.dispatchEvent(new Event(TOGGLE_TOC_EVENT));
          break;
        case "help":
          helpRef.current?.showModal();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, props.prevHref, props.nextHref]);

  const estimate = useMemo(() => estimateDurationMs(props.textChars), [props.textChars]);
  const { totalMs, generatedMs } = timelineRanges(state.gen, state.bufferedEndMs, estimate);
  const ready = state.gen.kind === "ready";
  const banner = bannerMessage(state);
  const busy = state.loading && !state.playing;

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)]">
      {!state.follow && state.currentSeg !== null ? <FollowPill onClick={() => ctl.current?.followNow()} /> : null}

      {banner ? (
        <div
          role={banner.alert ? "alert" : "status"}
          className="mx-auto flex max-w-3xl items-center justify-between gap-3 border-b border-border px-4 py-2 text-sm text-text"
        >
          <p className="min-w-0 flex-1">{banner.text}</p>
          {banner.retry ? (
            <button type="button" onClick={() => ctl.current?.retry()} className={smallButton}>
              Thử lại
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mx-auto max-w-3xl px-3 pb-2 pt-1 sm:px-4">
        <div className="flex items-center gap-2">
          <span className="w-11 shrink-0 text-right text-xs tabular-nums text-text-muted">
            {formatClock(state.positionMs)}
          </span>
          <Timeline
            ctl={ctl}
            positionMs={state.positionMs}
            totalMs={totalMs}
            generatedMs={generatedMs}
          />
          <span className="w-11 shrink-0 text-xs tabular-nums text-text-muted">
            {ready ? "" : "~"}
            {formatClock(totalMs)}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {props.prevHref ? (
            <Link href={props.prevHref} aria-label="Chương trước" title="Chương trước" className={iconButton}>
              <SkipBack size={20} aria-hidden="true" />
            </Link>
          ) : (
            <span aria-hidden="true" className={iconOff}>
              <SkipBack size={20} />
            </span>
          )}
          <button
            type="button"
            onClick={() => ctl.current?.stepSegment(-1)}
            aria-label="Đoạn trước"
            title="Đoạn trước (←)"
            className={iconButton}
          >
            <Rewind size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => ctl.current?.toggle()}
            aria-label={state.playing ? "Tạm dừng" : busy ? "Đang chờ âm thanh, bấm để huỷ" : "Phát"}
            title={state.playing ? "Tạm dừng (Space)" : "Phát (Space)"}
            aria-busy={busy}
            className={`inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-accent text-accent-contrast transition-opacity hover:opacity-90 active:scale-[0.98] ${FOCUS_RING}`}
          >
            {state.playing ? (
              <Pause size={24} weight="fill" aria-hidden="true" />
            ) : busy ? (
              <CircleNotch size={24} className="animate-spin" aria-hidden="true" />
            ) : (
              <Play size={24} weight="fill" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => ctl.current?.stepSegment(1)}
            aria-label="Đoạn sau"
            title="Đoạn sau (→)"
            className={iconButton}
          >
            <FastForward size={20} aria-hidden="true" />
          </button>
          {props.nextHref ? (
            <Link href={props.nextHref} aria-label="Chương sau" title="Chương sau" className={iconButton}>
              <SkipForward size={20} aria-hidden="true" />
            </Link>
          ) : (
            <span aria-hidden="true" className={iconOff}>
              <SkipForward size={20} />
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => ctl.current?.cycleRate()}
              aria-label={`Tốc độ ${formatRate(state.rate)}, bấm để đổi`}
              title="Tốc độ phát ([ ])"
              className={`inline-flex h-10 min-w-12 items-center justify-center rounded-lg px-2 text-sm tabular-nums text-text transition-colors hover:bg-surface-raised active:scale-[0.98] ${FOCUS_RING}`}
            >
              {formatRate(state.rate)}
            </button>
            <label className="hidden items-center gap-1.5 text-text-muted sm:flex">
              <SpeakerHigh size={18} aria-hidden="true" />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={state.volume}
                onChange={(e) => ctl.current?.setVolume(Number(e.target.value))}
                aria-label="Âm lượng"
                className={`h-6 w-20 accent-[var(--accent)] ${FOCUS_RING}`}
              />
            </label>
            <button
              type="button"
              onClick={() => helpRef.current?.showModal()}
              aria-label="Phím tắt"
              title="Phím tắt (?)"
              className={`${iconButton} max-sm:hidden`}
            >
              <Keyboard size={20} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <dialog
        ref={helpRef}
        aria-labelledby="shortcuts-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        className="m-auto w-[min(26rem,92vw)] rounded-xl border border-border bg-surface p-0 text-text backdrop:bg-[color-mix(in_srgb,var(--text)_40%,transparent)]"
      >
        <div className="p-5">
          <h2 id="shortcuts-title" className="mb-3 font-semibold tracking-tight">
            Phím tắt
          </h2>
          <dl className="space-y-2 text-sm">
            {SHORTCUTS.map(([keys, label]) => (
              <div key={keys} className="flex items-center justify-between gap-4">
                <dt className="text-text-muted">{label}</dt>
                <dd>
                  <kbd className="rounded border border-border-strong bg-surface-raised px-2 py-0.5 font-sans text-xs">
                    {keys}
                  </kbd>
                </dd>
              </div>
            ))}
          </dl>
          <button type="button" onClick={() => helpRef.current?.close()} className={`${smallButton} mt-5`}>
            Đóng
          </button>
        </div>
      </dialog>
    </div>
  );
}

type TimelineProps = {
  ctl: React.RefObject<PlayerController | null>;
  positionMs: number;
  totalMs: number;
  generatedMs: number;
};

// Solid = generated, striped = still to come, accent = played. Hover shows the sentence under the pointer; a click
// seeks, but only inside the generated range.
function Timeline({ ctl, positionMs, totalMs, generatedMs }: TimelineProps) {
  const [hover, setHover] = useState<{ pct: number; time: string; text: string | null } | null>(null);
  const total = Math.max(totalMs, 1);
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / total) * 100))}%`;

  const locate = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
    return { ratio, ms: ratio * total };
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Vị trí phát"
      aria-valuemin={0}
      aria-valuemax={Math.round(total / 1000)}
      aria-valuenow={Math.min(Math.round(positionMs / 1000), Math.round(total / 1000))}
      aria-valuetext={`${formatClock(positionMs)} trên ${formatClock(totalMs)}`}
      onPointerMove={(e) => {
        const { ratio, ms } = locate(e);
        const inside = ms <= generatedMs;
        const seg = inside ? ctl.current?.segmentAtMs(ms) : null;
        setHover({
          pct: ratio * 100,
          time: formatClock(ms),
          text: seg !== null && seg !== undefined ? (ctl.current?.segmentText(seg) ?? null) : null,
        });
      }}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => {
        const { ms } = locate(e);
        if (ms <= generatedMs) ctl.current?.seekToMs(ms);
      }}
      className={`group relative flex h-8 min-w-0 flex-1 cursor-pointer items-center ${FOCUS_RING} rounded`}
    >
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className="absolute inset-y-0 right-0 [background-image:repeating-linear-gradient(135deg,var(--border-strong)_0_4px,transparent_4px_8px)]"
          style={{ left: pct(generatedMs) }}
        />
        <div className="absolute inset-y-0 left-0 bg-border-strong" style={{ width: pct(generatedMs) }} />
        <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: pct(positionMs) }} />
      </div>
      {hover ? (
        <div
          className="pointer-events-none absolute bottom-full z-10 mb-1 w-max max-w-[min(20rem,80vw)] -translate-x-1/2 rounded-lg border border-border-strong bg-surface-raised px-3 py-1.5 text-xs text-text shadow-sm"
          style={{ left: `clamp(7rem, ${hover.pct}%, calc(100% - 7rem))` }}
        >
          <span className="tabular-nums text-text-muted">{hover.time}</span>
          {hover.text ? <p className="mt-0.5 [text-wrap:pretty]">{hover.text}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
