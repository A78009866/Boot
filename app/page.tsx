import HomeClient from '@/components/HomeClient';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return <HomeClient posterUrl="/poster-9x16.jpg" ogImageUrl="/og.jpg" />;
}
