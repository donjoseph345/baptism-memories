import Gallery from '@/components/gallery';
import GuestJoinForm from '@/components/guest-join-form';

export default async function EventPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ key?: string }> }) {
  const { slug } = await params;
  const { key } = await searchParams;
  if (key) return <Gallery slug={slug} guestToken={key} accessMode="legacy" />;
  return <GuestJoinForm slug={slug} />;
}

