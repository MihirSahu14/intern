import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import ConvexClientProvider from "@/components/ConvexClientProvider";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "intern · community brain",
  description:
    "A community brain you can see, and interns that go find what it doesn't know yet.",
};

// Runs before first paint so a saved theme applies with no flash of the
// wrong one. Absent/invalid value leaves `data-theme` unset, which means
// "system" — globals.css's prefers-color-scheme rule already covers that.
// try/catch: private windows throw on localStorage access.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("intern.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

/**
 * A real `<script>` only runs on the initial HTML parse, which is exactly
 * what the no-flash trick needs. But React re-renders this on every
 * client-side navigation too (this is the root layout), and a `<script>`
 * written in JSX doesn't execute then — it would just warn. Flipping its
 * `type` on the client makes React treat re-renders as inert markup instead.
 */
function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <InlineScript html={THEME_SCRIPT} />
      </head>
      <body className="h-full overflow-hidden bg-bg text-fg">
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
