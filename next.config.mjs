/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // نضمن شحن ملف ffmpeg الثنائي داخل حزمة دالة /api/send على Vercel
  // (يُستخدم فقط كخطة بديلة لتحويل WebM إلى MP4 عند تسجيل المتصفح بصيغة WebM)
  outputFileTracingIncludes: {
    '/api/send': ['./node_modules/ffmpeg-static/**/*'],
    '/api/send/route': ['./node_modules/ffmpeg-static/**/*'],
  },
};

export default nextConfig;
