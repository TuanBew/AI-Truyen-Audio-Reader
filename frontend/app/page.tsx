"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

// Lazy import to avoid SSR issues with Zustand persist
const MainLayout = dynamic(() => import("@/components/MainLayout"), { ssr: false });

export default function Home() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen text-gray-400">
        Đang tải AudioTruyen…
      </div>
    }>
      <MainLayout />
    </Suspense>
  );
}
