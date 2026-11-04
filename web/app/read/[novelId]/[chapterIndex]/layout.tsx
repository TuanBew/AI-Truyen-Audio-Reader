import { Literata } from "next/font/google";

// Reading column font. It lives here, not in the root layout, so only the reader downloads it.
const literata = Literata({
  subsets: ["vietnamese", "latin"],
  variable: "--font-reading",
  display: "swap",
});

export default function ReaderLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className={`${literata.variable} min-h-[100dvh]`}>{children}</div>;
}
