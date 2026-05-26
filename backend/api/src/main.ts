import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { StripSensitiveInterceptor } from './common/strip-sensitive.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const isProd = process.env.NODE_ENV === 'production';

  // Trust the first reverse proxy hop (Nginx). Required so req.ip
  // reflects the real client and so secure cookies work behind TLS.
  app.set('trust proxy', 1);

  // Standard security headers — Content-Security-Policy etc.
  // crossOriginEmbedderPolicy disabled so the invoice image stream works.
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false, // Next.js sets its own CSP on its origin
  }));

  app.enableCors({
    // In prod allow only the frontend origin from env; dev keeps localhost.
    origin: isProd
      ? (process.env.FRONTEND_URL ?? 'https://recon.yourdomain.co.za')
      : 'http://localhost:3001',
    credentials: true,
  });

  app.use(cookieParser());

  app.useGlobalInterceptors(new StripSensitiveInterceptor());

  await app.listen(3000);
}
bootstrap();
