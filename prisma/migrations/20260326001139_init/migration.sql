-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartDrawerConfig" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "productDiscountGid" TEXT,
    "deliveryDiscountGid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CartDrawerConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopUsage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "plan" TEXT NOT NULL DEFAULT 'starter',

    CONSTRAINT "ShopUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CartDrawerConfig_shop_key" ON "CartDrawerConfig"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ShopUsage_shop_month_key" ON "ShopUsage"("shop", "month");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shop_event_idx" ON "AnalyticsEvent"("shop", "event");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_shop_createdAt_idx" ON "AnalyticsEvent"("shop", "createdAt");
