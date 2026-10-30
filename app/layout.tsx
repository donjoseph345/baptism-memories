import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Baptism Memories — Every moment, together', description: 'A shared photo album for the little moments that become family memories.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
