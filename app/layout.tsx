import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Reverie · AI 互动影游",
  description: "Reverie —— AI 互动影游平台，你的每个选择都会改写剧情",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
