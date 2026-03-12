"use client";

import { useState } from "react";
import { Settings, Headphones } from "lucide-react";
import { useAppStore } from "@/lib/store";
import ChapterSidebar from "./ChapterSidebar";
import ReaderPanel from "./ReaderPanel";
import SettingsPanel from "./SettingsPanel";
import HomePage from "./HomePage";

export default function MainLayout() {
  const { view, setView, settingsPanelOpen, toggleSettingsPanel } = useAppStore();
  const [sidebarWidth] = useState(320);

  if (view === "home") {
    return <HomePage />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950">
      {/* ── Chapter Sidebar ──────────────────────────────── */}
      <aside
        className="flex-shrink-0 border-r border-gray-800 flex flex-col bg-gray-900 overflow-hidden"
        style={{ width: sidebarWidth }}
      >
        <ChapterSidebar />
      </aside>

      {/* ── Main content area ────────────────────────────── */}
      <main className="flex-1 overflow-hidden flex flex-col relative">
        {/* Top bar */}
        <header className="h-12 flex items-center justify-between px-4 border-b border-gray-800 bg-gray-900 flex-shrink-0">
          {/* Clickable logo → home */}
          <button
            onClick={() => setView("home")}
            className="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 transition-colors group"
            title="Về trang chủ"
          >
            <Headphones size={20} />
            <span className="font-semibold text-sm tracking-wide group-hover:underline underline-offset-2">
              AudioTruyen
            </span>
          </button>

          <button
            onClick={toggleSettingsPanel}
            className="p-1.5 rounded hover:bg-gray-700 transition-colors text-gray-400 hover:text-white"
            title="Cài đặt"
          >
            <Settings size={18} />
          </button>
        </header>

        {/* Reader takes remaining height */}
        <ReaderPanel />
      </main>

      {/* ── Settings Drawer (slide-in from right) ─────────── */}
      {settingsPanelOpen && (
        <div className="fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="flex-1 bg-black/50 backdrop-blur-sm"
            onClick={toggleSettingsPanel}
          />
          {/* Panel */}
          <div className="w-96 bg-gray-900 border-l border-gray-700 overflow-y-auto shadow-2xl">
            <SettingsPanel />
          </div>
        </div>
      )}
    </div>
  );
}
