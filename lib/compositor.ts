/**
 * طبقة التركيب (Composition) بين الكاميرا الأمامية وفيديو المونتاج.
 *
 * الناتج: canvas بمقاس 720×1280 (9:16) يحتوي الكاميرا + فيديو السيارة فوقها
 * بمزج overlay، مع خلط صوت الميكروفون بصوت فيديو المونتاج.
 * ثم نحوّل الكانفس إلى MediaStream جاهزًا للتسجيل عبر MediaRecorder.
 */

export type Composition = {
  canvas: HTMLCanvasElement;
  stream: MediaStream;
  /** أوقف كل شيء: حلقة الرسم، الفيديوهات، وخلاط الصوت */
  stop: () => void;
  /** أبعاد دفق الكاميرا الفعلية */
  cameraSize: { width: number; height: number };
};

const OUT_W = 720;
const OUT_H = 1280;

/**
 * طريقة التركيب:
 *  - 'pip'   : فيديو المونتاج خلفية كاملة + الكاميرا في بطاقة مستديرة (الافتراضي، أوضح)
 *  - 'blend' : الكاميرا خلفية + فيديو المونتاج مُمزوج فوقها (تأثير شبح/دبل إكسبوشر)
 */
type Layout = 'pip' | 'blend';

const LAYOUT: Layout = 'pip';
const FX_OPACITY = 0.62; // تُستخدم في وضع blend فقط

// إعدادات بطاقة الكاميرا في وضع pip (نسب من المقاس الكلي)
const PIP_WIDTH_RATIO = 0.46;
const PIP_BOTTOM_RATIO = 0.06;
const PIP_RADIUS = 34;
const PIP_BORDER = 5;

/** يرسم الفيديو داخل الكانفس بمقاس الغلاف (cover) دون تشويه */
function drawCover(
  ctx: CanvasRenderingContext2D,
  source: HTMLVideoElement,
  w: number,
  h: number
) {
  const sw = source.videoWidth;
  const sh = source.videoHeight;
  if (!sw || !sh) return;

  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;

  ctx.drawImage(source, dx, dy, dw, dh);
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function playSafe(v: HTMLVideoElement) {
  return v.play().catch(() => {
    /* سيعمل عند أول تفاعل — لا نكسر التدفق */
  });
}

/**
 * ينتظر جاهزية الفيديو (readyState >= 2) بلا حجب زائد:
 * إن كان جاهزًا أصلًا يُرجع فورًا، وإلا يستمع للحدث مع سقف زمني قصير.
 */
function waitReady(target: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (target.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      target.removeEventListener('loadeddata', finish);
      target.removeEventListener('canplay', finish);
      target.removeEventListener('playing', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    target.addEventListener('loadeddata', finish, { once: true });
    target.addEventListener('canplay', finish, { once: true });
    target.addEventListener('playing', finish, { once: true });
  });
}

export async function startComposition(opts: {
  cameraStream: MediaStream;
  /** مصادر الفيديو بالترتيب: يُجرَّب الأول ثم التالي عند فشل فك الترميز */
  fxUrls?: string[];
  fps?: number;
  fxOpacity?: number;
}): Promise<Composition> {
  const { cameraStream, fxUrls = [] } = opts;
  const fps = opts.fps ?? 30;
  const fxOpacity = opts.fxOpacity ?? FX_OPACITY;

  /* ---------- عنصر فيديو الكاميرا (مخفي، للرسم فقط) ---------- */
  const cameraEl = document.createElement('video');
  cameraEl.srcObject = cameraStream;
  cameraEl.muted = true;
  cameraEl.playsInline = true;
  cameraEl.autoplay = true;
  cameraEl.setAttribute('playsinline', '');
  cameraEl.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0';
  document.body.appendChild(cameraEl);
  void playSafe(cameraEl);
  await waitReady(cameraEl, 1200);

  const settings = cameraStream.getVideoTracks()[0]?.getSettings?.() ?? {};
  const cameraSize = {
    width: settings.width ?? cameraEl.videoWidth ?? 720,
    height: settings.height ?? cameraEl.videoHeight ?? 1280,
  };

  /* ---------- عنصر فيديو المونتاج (مخفي، للرسم والالتقاط فقط) ---------- */
  // نجرّب الصيغ بالترتيب (mp4 ثم webm) حتى ينجح فك الترميز في هذا المتصفح
  let fxEl: HTMLVideoElement | null = null;

  for (const url of fxUrls) {
    const candidate = document.createElement('video');
    candidate.src = url;
    candidate.muted = true;
    candidate.playsInline = true;
    candidate.setAttribute('playsinline', '');
    candidate.preload = 'auto';
    candidate.loop = false;
    candidate.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0';
    document.body.appendChild(candidate);
    candidate.load();
    void playSafe(candidate);

    const failed = new Promise<void>((resolve) => {
      candidate.addEventListener('error', () => resolve(), { once: true });
    });
    await Promise.race([waitReady(candidate, 1400), failed]);

    if (candidate.readyState >= 2 && !candidate.error) {
      fxEl = candidate;
      break;
    }

    // فشل هذا المصدر: ننظّفه ونجرّب التالي
    try {
      candidate.pause();
      candidate.removeAttribute('src');
      candidate.load();
    } catch {
      /* تجاهل */
    }
    candidate.remove();
  }

  /* ---------- الكانفس (هو ما يراه المستخدم وما يُسجَّل) ---------- */
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;

  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  if (!ctx) throw new Error('canvas-unavailable');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUT_W, OUT_H);

  /* ---------- خلط الصوت: ميكروفون + صوت فيديو المونتاج ---------- */
  let audioCtx: AudioContext | null = null;
  let dstNode: MediaStreamAudioDestinationNode | null = null;

  try {
    const AC: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AC();
    dstNode = audioCtx.createMediaStreamDestination();

    const micTracks = cameraStream.getAudioTracks();
    if (micTracks.length) {
      const micSource = audioCtx.createMediaStreamSource(new MediaStream(micTracks));
      const micGain = audioCtx.createGain();
      micGain.gain.value = 1;
      micSource.connect(micGain).connect(dstNode);
    }

    // صوت فيديو المونتاج (منخفض قليلًا حتى لا يغطي الصوت)
    const fxWithCapture = fxEl as (HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }) | null;
    const fxStream = fxWithCapture?.captureStream?.() ?? fxWithCapture?.mozCaptureStream?.();
    const fxAudio = fxStream?.getAudioTracks() ?? [];
    if (fxAudio.length) {
      const fxSource = audioCtx.createMediaStreamSource(new MediaStream(fxAudio));
      const fxGain = audioCtx.createGain();
      fxGain.gain.value = 0.55;
      fxSource.connect(fxGain).connect(dstNode);
    }

    // لا ننتظر استئناف السياق الصوتي حتى لا يتأخر بدء التسجيل
    if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
  } catch {
    audioCtx = null;
    dstNode = null;
  }

  /* ---------- تشغيل فيديو المونتاج من البداية ---------- */
  if (fxEl) {
    try {
      fxEl.currentTime = 0;
    } catch {
      /* تجاهل */
    }
    playSafe(fxEl);
  }

  /* ---------- حلقة الرسم ---------- */
  let raf = 0;
  let stopped = false;

  /** يرسم الكاميرا معكوسة أفقيًا (مرآة) داخل مستطيل محدد بمقاس cover */
  const drawCameraMirrored = (
    x: number,
    y: number,
    w: number,
    h: number
  ) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    drawCover(ctx, cameraEl, w, h);
    ctx.restore();
  };

  const render = () => {
    if (stopped) return;
    raf = requestAnimationFrame(render);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, OUT_W, OUT_H);

    const fxReady = Boolean(fxEl && fxEl.readyState >= 2);
    const camReady = cameraEl.readyState >= 2;

    if (LAYOUT === 'pip') {
      /* ---------- الخلفية: فيديو المونتاج (أو الكاميرا إن لم يوجد) ---------- */
      if (fxReady && fxEl) {
        drawCover(ctx, fxEl, OUT_W, OUT_H);
      } else if (camReady) {
        drawCameraMirrored(0, 0, OUT_W, OUT_H);
      }

      /* ---------- بطاقة السيلفي ---------- */
      if (camReady && fxReady) {
        const camW = cameraEl.videoWidth || 1280;
        const camH = cameraEl.videoHeight || 720;
        const pipW = Math.round(OUT_W * PIP_WIDTH_RATIO);
        const pipH = Math.round(pipW * (camH / camW));
        const pipX = Math.round((OUT_W - pipW) / 2);
        const pipY = Math.round(OUT_H - pipH - OUT_H * PIP_BOTTOM_RATIO);

        // ظل خفيف
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 26;
        ctx.shadowOffsetY = 10;
        ctx.fillStyle = 'rgba(255,255,255,0.94)';
        roundRectPath(ctx, pipX, pipY, pipW, pipH, PIP_RADIUS);
        ctx.fill();
        ctx.restore();

        // محتوى الكاميرا مقصوص بزوايا مستديرة
        ctx.save();
        roundRectPath(
          ctx,
          pipX + PIP_BORDER,
          pipY + PIP_BORDER,
          pipW - PIP_BORDER * 2,
          pipH - PIP_BORDER * 2,
          PIP_RADIUS - PIP_BORDER
        );
        ctx.clip();
        drawCameraMirrored(
          pipX + PIP_BORDER,
          pipY + PIP_BORDER,
          pipW - PIP_BORDER * 2,
          pipH - PIP_BORDER * 2
        );
        ctx.restore();
      }
    } else {
      /* ---------- وضع المزج: الكاميرا خلفية + الفيديو فوقها ---------- */
      if (camReady) {
        drawCameraMirrored(0, 0, OUT_W, OUT_H);
      }
      if (fxReady && fxEl) {
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = fxOpacity;
        drawCover(ctx, fxEl, OUT_W, OUT_H);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
    }

    // تظليل خفيف في الأطراف لتماسك الصورة
    const grad = ctx.createRadialGradient(
      OUT_W / 2,
      OUT_H / 2,
      OUT_W * 0.42,
      OUT_W / 2,
      OUT_H / 2,
      OUT_H * 0.78
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.26)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, OUT_W, OUT_H);
  };
  render();

  /* ---------- دفتر الفيديو من الكانفس ---------- */
  const canvasStream = canvas.captureStream(fps);
  const videoTrack = canvasStream.getVideoTracks()[0];

  const tracks: MediaStreamTrack[] = [];
  if (videoTrack) tracks.push(videoTrack);
  if (dstNode) tracks.push(...dstNode.stream.getAudioTracks());

  const stream = new MediaStream(tracks);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);

    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* تجاهل */
      }
    });
    canvasStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* تجاهل */
      }
    });

    if (fxEl) {
      try {
        fxEl.pause();
        fxEl.removeAttribute('src');
        fxEl.load();
      } catch {
        /* تجاهل */
      }
      fxEl.remove();
      fxEl = null;
    }

    cameraEl.srcObject = null;
    cameraEl.remove();

    audioCtx?.close().catch(() => {});
    audioCtx = null;
  };

  return { canvas, stream, stop, cameraSize };
}
