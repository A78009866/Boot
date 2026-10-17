'use client';

import { useEffect, useState } from 'react';
import Recorder from './Recorder';

/**
 * صفحة الهبوط: تعرض الصورة كغلاف (مثل ريلز) مع زر تشغيل.
 * بمجرد الضغط نُحمّل الكاميرا ونبدأ التسجيل فورًا (tap-to-record، بلا خطوة ثانية).
 */
export default function HomeClient({
  posterUrl,
  ogImageUrl,
}: {
  posterUrl: string;
  ogImageUrl: string;
}) {
  const [started, setStarted] = useState(false);

  // نُسخّن فيديو المونتاج في الكاش فور فتح الصفحة حتى يبدأ بلا تأخير
  useEffect(() => {
    const img = new Image();
    img.src = ogImageUrl;
    fetch('/preamble.mp4', { cache: 'force-cache' }).catch(() => {});
  }, [ogImageUrl]);

  if (started) {
    return <Recorder autoStart fxVideoUrls={['/preamble.mp4', '/preamble.webm']} />;
  }

  return (
    <main className="gate">
      <div className="gateMedia">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={posterUrl} alt="معاينة" className="gatePoster" />
        <div className="gateVeil" />
      </div>

      <div className="gateContent">
        <div className="gateBadge">
          <span className="recDotSmall" /> 10 ثوانٍ فقط
        </div>

        <h1 className="gateTitle">سجّل الآن</h1>
        <p className="gateSub">ستفتح الكاميرا الأمامية وتبدأ التسجيل فورًا.</p>

        <button className="gatePlay" onClick={() => setStarted(true)} aria-label="ابدأ التسجيل">
          <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
            <path d="M8 5.2v13.6c0 .8.9 1.3 1.6.9l10.2-6.8a1 1 0 0 0 0-1.8L9.6 4.3C8.9 3.9 8 4.4 8 5.2Z" fill="currentColor" />
          </svg>
        </button>

        <span className="gateHint">اضغط للبدء</span>
      </div>

      <div className="gateFoot">الكاميرا لا تعمل إلا بعد ضغطك • الفيديو يُرسل إلى تلغرام</div>
    </main>
  );
}
