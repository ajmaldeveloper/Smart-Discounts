-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "experimentId" TEXT,
ADD COLUMN     "experimentVariant" TEXT,
ADD COLUMN     "experimentWeight" INTEGER;

-- CreateIndex
CREATE INDEX "Campaign_shopId_experimentId_idx" ON "Campaign"("shopId", "experimentId");
