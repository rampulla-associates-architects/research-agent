import type { Metadata, Viewport } from "next";
import "./globals.css";

const assetNames = [
  "add", "close", "cloud", "code", "delete", "document", "edit", "graph", "link", "list", "menu", "money", "more",
  "mount", "polygon", "raw", "revert", "save", "search", "sync", "table", "unmount", "wrap"
];
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const assetVariables = assetNames.map((name) => `--asset-${name}:url("${basePath}/assets/${name}.svg");`).join("");

export const metadata: Metadata = {
  title: "Staten Island Map"
};

export const viewport: Viewport = {
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  width: "device-width"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <style>{`:root{${assetVariables}}`}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
