import type { Metadata } from 'next'
import { Source_Sans_3 } from 'next/font/google'
import './globals.css'

// A clean, neutral sans that reads well in a dense support-operator UI.
// Genuinely free (SIL license), Google's catalog lists it as "Source Sans 3".
const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  variable: '--font-source-sans',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Watchtower',
  robots: 'noindex,nofollow',
}

// Runs before first paint so the stored theme is applied without a flash of the
// default one. Kept in sync with components/ThemeToggle.tsx.
const THEME_SCRIPT = `try{var t=localStorage.getItem('wtch-theme');document.documentElement.dataset.theme=t==='light'?'light':'dark'}catch(e){document.documentElement.dataset.theme='dark'}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={sourceSans.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
