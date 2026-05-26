import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { SessionRefreshInterceptor } from './auth/session-refresh.interceptor';
import { UsersModule } from './users/users.module';
import { CardsModule } from './cards/cards.module';
import { TransactionsModule } from './transactions/transactions.module';
import { InvoicesModule } from './invoices/invoices.module';
import { StatementsModule } from './statements/statements.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ReportsModule } from './reports/reports.module';
import { ReconReportsModule } from './recon-reports/recon-reports.module';
import { StoresModule } from './stores/stores.module';
import { CategoriesModule } from './categories/categories.module';
import { SettingsModule } from './settings/settings.module';
import { AuditModule } from './audit/audit.module';
import { NotificationsModule } from './notifications/notifications.module';
import { EditRequestsModule } from './edit-requests/edit-requests.module';
import { MailerModule } from './mailer/mailer.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // Global throttling — 100 requests per minute per IP. Auth endpoints
    // get their own tighter limit via @Throttle() decorator (see
    // auth.controller.ts) so a brute-force on /auth/login doesn't get
    // the same generous quota as regular browsing.
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100 },
    ]),

    UsersModule,
    CardsModule,
    TransactionsModule,
    InvoicesModule,
    StatementsModule,
    ReconciliationModule,
    DashboardModule,
    ReportsModule,
    ReconReportsModule,
    StoresModule,
    CategoriesModule,
    SettingsModule,
    AuditModule,
    NotificationsModule,
    EditRequestsModule,
    MailerModule,
    AuthModule,
  ],
  providers: [
    // Applies ThrottlerGuard to every route. Per-route overrides via
    // @Throttle() decorator still work.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Sliding-session refresh: any authenticated request resets the
    // 10-min inactivity cookie. Closing the browser for longer than
    // the window expires the cookie and forces a fresh login.
    { provide: APP_INTERCEPTOR, useClass: SessionRefreshInterceptor },
  ],
})
export class AppModule {}
