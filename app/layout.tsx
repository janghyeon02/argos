import type { Metadata } from "next";
import { Noto_Sans_KR } from "next/font/google";
import { RULES } from "@/lib/config/rules";
import "./globals.css";

const notoKr = Noto_Sans_KR({
  variable: "--font-noto-kr",
  weight: ["400", "500", "700"],
  preload: false,
});

export const metadata: Metadata = {
  title: "아르고스",
  description: "글로벌 리스크 조기경보 AI 비서",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${notoKr.variable} h-full`}>
      <body className="flex min-h-full flex-col">
        {children}
        {/* 모든 화면에 면책 문구 (PRD Must② 규칙 11) */}
        <footer className="mt-auto border-t border-line px-4 py-6 text-center text-xs text-muted">
          {RULES.alert.disclaimer} · 아르고스는 공개 자료를 AI로 정리한 결과이며 사실 확인은 원문 링크에서 하세요.
        </footer>
      </body>
    </html>
  );
}
