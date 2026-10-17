'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Phase =
  | 'loading'
  | 'code'
  | 'idle'
  | 'recording'
  | 'preview'
  | 'sending'
  | 'sent';

const MAX_SECONDS = 10;

/**
 * نفضّل MP4 مباشرة (Safari + Chrome الحديث)، ثم WebM كخطة بديلة
 * (Firefox وبعض إصدارات Chrome القديمة).
 */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=h264',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMimeType(): string | null {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return null;
  for (const type of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* تجاهل الصيغة غير المدعومة */
    }
  }
  return '';
}

function friendlyError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'تم رفض إذن الكاميرا أو الميكروفون. اسمح بهما من إعدادات المتصفح لهذا الموقع ثم أعد المحاولة.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'لم نجد كاميرا أو ميكروفونًا متاحًا على هذا الجهاز.';
    case 'NotReadableError':
      return 'الكاميرا مستخدمة من تطبيق آخر. أغلق التطبيقات الأخرى ثم أعد المحاولة.';
    default:
      return 'تعذّر تشغيل الكاميرا. تأكد أنك تفتح الصفحة عبر https وبمتصفح حديث.';
  }
}

export default function Recorder() {
  /* ------------------------------ المراجع ------------------------------ */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startAtRef = useRef<number>(0);
  const mimeRef = useRef<string>('');
  const videoUrlRef = useRef<string | null>(null);

  /* ------------------------------ الحالات ------------------------------ */
  const [phase, setPhase] = useState<Phase>('loading');
  const [remaining, setRemaining] = useState(MAX_SECONDS);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [retakeAsk, setRetakeAsk] = useState(false);
  const [sending, setSending] = useState(false);

  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [serverReady, setServerReady] = useState<boolean | null>(null);

  /* --------------------------- أدوات مساعدة --------------------------- */
  const clearTimers = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timerRef.current = null;
    timeoutRef.current = null;
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const clearVideo = useCallback(() => {
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
    setVideoUrl(null);
    setVideoBlob(null);
    setDimensions(null);
  }, []);

  /* ---------------------- قراءة إعدادات الخادم أولًا ---------------------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      let cfg: { needsCode?: boolean; ready?: boolean } = {};
      try {
        const res = await fetch('/api/config', { cache: 'no-store' });
        cfg = (await res.json()) as typeof cfg;
      } catch {
        cfg = {};
      }
      if (!alive) return;

      setServerReady(cfg.ready !== false);
      setNeedsCode(Boolean(cfg.needsCode));

      if (!cfg.needsCode) {
        setPhase('idle');
        return;
      }

      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem('v10_code');
      } catch {
        saved = null;
      }
      if (saved) {
        const ok = await fetch('/api/verify-code', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: saved }),
        })
          .then((r) => r.ok)
          .catch(() => false);
        if (!alive) return;
        if (ok) {
          setCode(saved);
          setPhase('idle');
          return;
        }
      }
      setPhase('code');
    })();

    return () => {
      alive = false;
    };
  }, []);

  /* --------------------------- تنظيف عند الإغلاق --------------------------- */
  useEffect(() => {
    return () => {
      clearTimers();
      stopStream();
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    };
  }, [clearTimers, stopStream]);

  /* ----------------------------- إيقاف التسجيل ----------------------------- */
  const stopRecording = useCallback(() => {
    clearTimers();
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, [clearTimers]);

  /* ------------------------------ بدء التسجيل ------------------------------ */
  const startRecording = useCallback(async () => {
    setError(null);
    setRetakeAsk(false);
    setElapsed(0);
    setRemaining(MAX_SECONDS);
    clearVideo();

    const mime = pickMimeType();
    if (mime === null) {
      setError('متصفحك لا يدعم تسجيل الفيديو. استخدم Chrome أو Safari أو Firefox حديثًا.');
      return;
    }
    mimeRef.current = mime;

    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
    } catch (err) {
      setError(friendlyError(err));
      return;
    }

    streamRef.current = stream;
    const videoEl = videoRef.current;
    if (videoEl) {
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    }

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    if (settings.width && settings.height) {
      setDimensions({ width: settings.width, height: settings.height });
    }

    const options: MediaRecorderOptions = {
      videoBitsPerSecond: 2_500_000,
      audioBitsPerSecond: 96_000,
    };
    if (mime) options.mimeType = mime;

    let recorder: MediaRecorder | null = null;
    try {
      recorder = new MediaRecorder(stream, options);
    } catch {
      try {
        recorder = new MediaRecorder(stream, {
          videoBitsPerSecond: 2_500_000,
          audioBitsPerSecond: 96_000,
        });
      } catch {
        recorder = null;
      }
    }

    if (!recorder) {
      setError('تعذّر بدء التسجيل في هذا المتصفح.');
      stopStream();
      setPhase('idle');
      return;
    }

    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onerror = () => {
      clearTimers();
      setError('حدث خطأ أثناء التسجيل، أعد المحاولة.');
      stopStream();
      setPhase('idle');
    };

    recorder.onstop = () => {
      clearTimers();
      const actualMime = recorder?.mimeType || mimeRef.current || 'video/webm';
      const blob = new Blob(chunksRef.current, { type: actualMime });
      chunksRef.current = [];
      stopStream();

      const duration = Math.min(MAX_SECONDS, (performance.now() - startAtRef.current) / 1000);

      if (videoRef.current) {
        videoRef.current.srcObject = null;
        videoRef.current.muted = false;
      }

      if (blob.size === 0) {
        setError('لم يُسجَّل أي شيء، جرّب مرة أخرى.');
        setPhase('idle');
        return;
      }

      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      const url = URL.createObjectURL(blob);
      videoUrlRef.current = url;

      setVideoBlob(blob);
      setVideoUrl(url);
      setElapsed(duration);
      setPhase('preview');
    };

    startAtRef.current = performance.now();
    setPhase('recording');
    setRemaining(MAX_SECONDS);
    setElapsed(0);

    timerRef.current = setInterval(() => {
      const secs = (performance.now() - startAtRef.current) / 1000;
      setElapsed(secs);
      setRemaining(Math.max(0, MAX_SECONDS - secs));
    }, 100);

    // ⏱️ الإيقاف التلقائي بعد 10 ثوانٍ بالضبط
    timeoutRef.current = setTimeout(stopRecording, MAX_SECONDS * 1000);

    try {
      recorder.start(250); // دفعات كل ربع ثانية لتفادي فقدان البيانات
    } catch {
      clearTimers();
      stopStream();
      setError('تعذّر بدء التسجيل في هذا المتصفح.');
      setPhase('idle');
    }
  }, [clearTimers, clearVideo, stopRecording, stopStream]);

  /* ------------------------------ إعادة الضبط ------------------------------ */
  const resetToIdle = useCallback(() => {
    clearVideo();
    setElapsed(0);
    setRemaining(MAX_SECONDS);
    setRetakeAsk(false);
    setError(null);
    setPhase('idle');
  }, [clearVideo]);

  /* -------------------------------- الإرسال -------------------------------- */
  const sendVideo = useCallback(async () => {
    if (!videoBlob || sending) return;
    setSending(true);
    setError(null);

    try {
      const isMp4 = (videoBlob.type || '').includes('mp4');
      const form = new FormData();
      form.append('video', videoBlob, `video.${isMp4 ? 'mp4' : 'webm'}`);
      form.append('duration', String(elapsed.toFixed(2)));
      form.append(
        'meta',
        JSON.stringify({
          duration: Number(elapsed.toFixed(2)),
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          mime: videoBlob.type,
        })
      );

      const res = await fetch('/api/send', {
        method: 'POST',
        body: form,
        headers: code ? { 'x-access-code': code } : undefined,
      });

      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; messageId?: number | null }
        | null;

      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `فشل الإرسال (HTTP ${res.status})`);
      }

      setPhase('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل الإرسال، حاول مجددًا.');
      setPhase('preview');
    } finally {
      setSending(false);
    }
  }, [code, dimensions, elapsed, sending, videoBlob]);

  /* ------------------------------ رمز الدخول ------------------------------ */
  const submitCode = useCallback(async () => {
    setCodeError(null);
    try {
      const res = await fetch('/api/verify-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        setCodeError('رمز الدخول غير صحيح.');
        return;
      }
      try {
        sessionStorage.setItem('v10_code', code);
      } catch {
        /* تجاهل: بعض البيئات تمنع التخزين */
      }
      setPhase('idle');
    } catch {
      setCodeError('تعذّر التحقق الآن، حاول مجددًا.');
    }
  }, [code]);

  /* -------------------------------- الواجهة -------------------------------- */
  const progress = Math.min(1, elapsed / MAX_SECONDS);
  const secondsLeft = Math.max(0, Math.ceil(remaining));
  const showPreview = phase === 'preview' || phase === 'sending' || phase === 'sent';

  return (
    <div className="shell">
      <header className="head">
        <div className="brand">
          <span className="dot" aria-hidden="true" />
          <h1>عشر ثوانٍ</h1>
        </div>
        <p className="sub">سجّل مقطعك، وسيُرسل تلقائيًا إلى تلغرام.</p>
      </header>

      {serverReady === false && (
        <div className="banner warn">
          ⚠️ الخادم غير مهيأ: أضف <code>TELEGRAM_BOT_TOKEN</code> و <code>TELEGRAM_CHAT_ID</code> في
          متغيرات البيئة على Vercel ثم أعد النشر.
        </div>
      )}

      <div className="stage">
        <div className={`camera ${phase === 'recording' ? 'is-rec' : ''}`}>
          {/* معاينة الكاميرا المباشرة */}
          <video
            ref={videoRef}
            className="viewer"
            style={{ display: showPreview ? 'none' : 'block' }}
            playsInline
            muted
            autoPlay
          />

          {/* معاينة التسجيل */}
          {showPreview && videoUrl && (
            <video className="viewer" src={videoUrl} controls playsInline autoPlay loop />
          )}

          {phase === 'idle' && <div className="hint">ستُشغَّل الكاميرا عند الضغط على «ابدأ التسجيل»</div>}

          {phase === 'recording' && (
            <>
              <div className="recBadge">
                <span className="recDot" /> REC
              </div>
              <div className="countRing" aria-live="polite">
                {secondsLeft}
              </div>
              <div className="progressWrap">
                <div className="progressBar" style={{ width: `${progress * 100}%` }} />
              </div>
            </>
          )}

          {phase === 'sending' && (
            <div className="overlay">
              <span className="spinner" /> جارٍ الإرسال إلى تلغرام…
            </div>
          )}

          {phase === 'sent' && (
            <div className="overlay ok">
              <span>✅ تم الإرسال بنجاح</span>
              <span className="meta">تحقق من محادثة البوت في تلغرام</span>
            </div>
          )}
        </div>

        {error && <div className="banner err">{error}</div>}

        {phase === 'sent' ? (
          <div className="actions">
            <button className="btn primary" onClick={resetToIdle}>
              🔄 تسجيل فيديو جديد
            </button>
          </div>
        ) : phase === 'preview' || phase === 'sending' ? (
          <>
            <div className="actions">
              <button
                className="btn primary"
                disabled={!videoBlob || sending}
                onClick={sendVideo}
                aria-busy={sending}
              >
                {sending ? 'جارٍ الإرسال…' : '📤 إرسال إلى تلغرام'}
              </button>

              {retakeAsk ? (
                <button className="btn danger solid" disabled={sending} onClick={resetToIdle}>
                  تأكيد الحذف وإعادة التسجيل
                </button>
              ) : (
                <button className="btn ghost" disabled={sending} onClick={() => setRetakeAsk(true)}>
                  🎬 إعادة التسجيل
                </button>
              )}
            </div>

            {retakeAsk && !sending && (
              <div className="note">سيُحذف هذا المقطع نهائيًا ولن يُرسل — اضغط «تأكيد الحذف» للمتابعة.</div>
            )}
            <div className="note">
              المدة المسجّلة: {elapsed.toFixed(1)} ثانية
              {dimensions ? ` • ${dimensions.width}×${dimensions.height}` : ''}
            </div>
          </>
        ) : (
          <div className="actions">
            {phase === 'recording' ? (
              <button className="btn danger solid" onClick={stopRecording}>
                ⏹ إيقاف التسجيل الآن
              </button>
            ) : (
              <button
                className="btn primary"
                disabled={phase !== 'idle' || serverReady === false}
                onClick={startRecording}
              >
                ⏺ ابدأ التسجيل ({MAX_SECONDS} ثوانٍ)
              </button>
            )}
          </div>
        )}

        <p className="note foot">لا يُخزَّن الفيديو على الخادم — يمرّ مباشرةً إلى تلغرام.</p>
      </div>

      {phase === 'code' && (
        <div className="modal">
          <div className="modalCard">
            <h2>رمز الدخول</h2>
            <p>هذه الصفحة محمية. أدخل الرمز للمتابعة.</p>
            <input
              className="input"
              type="password"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCode();
              }}
              placeholder="••••••••"
            />
            {codeError && <div className="banner err small">{codeError}</div>}
            <button className="btn primary" onClick={submitCode} disabled={!code.trim()}>
              دخول
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
