-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "maxTotalDiscountAmount" DOUBLE PRECISION,
ADD COLUMN     "maxTotalDiscountType" TEXT NOT NULL DEFAULT 'PERCENTAGE';
