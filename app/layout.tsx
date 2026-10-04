import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'KnightClub Chess — Play with friends',
  description: 'A private, zero-database place to play a thoughtful game of chess with friends.',
  applicationName: 'KnightClub',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'KnightClub' },
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    apple: '/icon-192.png',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f4f0' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1512' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// Runs before hydration so a dark-mode reload never flashes the light palette.
// It reads the same local preference key the app persists.
const THEME_BOOTSTRAP = `(function(){try{var raw=localStorage.getItem('knightclub:v2:preferences');var theme=raw?JSON.parse(raw).theme:'system';var dark=theme==='dark'||(theme!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var root=document.documentElement;var color=dark?'#0e1512':'#f3f4f0';root.dataset.theme=dark?'dark':'light';root.style.colorScheme=dark?'dark':'light';var metas=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<metas.length;i+=1){metas[i].setAttribute('content',color);}}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Rendered as the first node in the streamed body so the theme is set before the app paints. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {children}
      </body>
    </html>
  );
}
