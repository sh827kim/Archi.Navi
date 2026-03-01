/**
 * 루트 레이아웃
 * Next.js 16 App Router — ThemeProvider + Toaster
 */
import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { Toaster } from 'sonner';
import { CommandPalette } from '@/components/command-palette';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Archi.Navi',
    template: '%s | Archi.Navi',
  },
  description: 'MSA 아키텍처 내비게이션 — 서비스 간 의존 관계를 수집, 추론, 시각화합니다',
  icons: {
    icon: '/favicon.ico',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body className="font-sans antialiased overflow-hidden">
        <ThemeProvider>
          {children}
          <CommandPalette />
          <Toaster
            position="bottom-right"
            toastOptions={{
              className: 'glass-panel',
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
