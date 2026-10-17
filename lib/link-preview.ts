import type { Metadata } from 'next';

/**
 * نستنتج عنوان الموقع الحقيقي من ترويسات الطلب (Vercel يوفّر x-forwarded-host)،
 * مع إمكانية تثبيته عبر متغير البيئة NEXT_PUBLIC_SITE_URL.
 * الروابط المطلقة ضرورية لأن واتساب/تلغرام/فيسبوك لا تقبل الروابط النسبية
 * في وسوم og:image و og:video.
 */
export function resolveBaseUrl(h: Headers): string {
  const envBase = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || '')
    .trim()
    .replace(/\/+$/, '');

  if (envBase) return envBase;

  const host = (h.get('x-forwarded-host') || h.get('host') || '')
    .split(',')[0]
    .trim();

  if (!host) return 'http://localhost:3000';

  const forwardedProto = (h.get('x-forwarded-proto') || '').split(',')[0].trim();
  const isLocal = host.startsWith('localhost') || host.startsWith('127.') || host.startsWith('0.0.0.0');
  const proto = forwardedProto || (isLocal ? 'http' : 'https');

  return `${proto}://${host}`;
}

export function safeOrigin(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

const TITLE = 'عشر ثوانٍ — فيديو إلى تلغرام';
const DESCRIPTION =
  'اضغط لتفتح الكاميرا الأمامية وتبدأ التسجيل فورًا لمدة 10 ثوانٍ، مع مونتاج مباشر وإرسال تلقائي إلى تلغرام.';

export function buildMetadata(h: Headers): Metadata {
  const origin = safeOrigin(resolveBaseUrl(h));

  const poster = `${origin}/og.jpg`;
  const poster9x16 = `${origin}/poster-9x16.jpg`;
  const video = `${origin}/preamble.mp4`;

  return {
    metadataBase: new URL(origin),
    title: TITLE,
    description: DESCRIPTION,

    // إيموجي ورابط الظهور الأولي
    applicationName: 'عشر ثوانٍ',
    robots: { index: false, follow: false },

    openGraph: {
      type: 'video.other',
      siteName: 'عشر ثوانٍ',
      title: TITLE,
      description: DESCRIPTION,
      url: `${origin}/`,
      locale: 'ar_DZ',
      images: [
        { url: poster, width: 1200, height: 630, alt: 'سيارة بورش — صورة المعاينة' },
        { url: poster9x16, width: 720, height: 1280, alt: 'سيارة بورش — صورة عمودية' },
      ],
      videos: [
        {
          url: video,
          secureUrl: video,
          type: 'video/mp4',
          width: 720,
          height: 1280,
        },
      ],
    },

    twitter: {
      card: 'summary_large_image',
      title: TITLE,
      description: DESCRIPTION,
      images: [poster],
    },

    other: {
      // تلغرام وواتساب يقرأان هذه الوسوم أيضًا
      'og:image:secure_url': poster,
      'og:video:type': 'video/mp4',
      'og:video:width': '720',
      'og:video:height': '1280',
      'video:duration': '10',
    },
  };
}
