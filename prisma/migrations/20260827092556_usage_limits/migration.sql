-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "usageCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "usageLimitPerCustomer" INTEGER,
ADD COLUMN     "usageLimitTotal" INTEGER;
