/*
  Warnings:

  - You are about to drop the column `plan` on the `ShopUsage` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ShopUsage" DROP COLUMN "plan";

-- CreateTable
CREATE TABLE "ShopPlan" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'starter',
    "subscriptionGid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopPlan_shop_key" ON "ShopPlan"("shop");
