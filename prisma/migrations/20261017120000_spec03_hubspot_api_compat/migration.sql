-- AlterTable
ALTER TABLE "crm_deals" ALTER COLUMN "is_closed" DROP NOT NULL,
ALTER COLUMN "is_closed" DROP DEFAULT;

-- AlterTable
ALTER TABLE "crm_pipeline_stages" ALTER COLUMN "is_closed" DROP NOT NULL,
ALTER COLUMN "is_closed" DROP DEFAULT;

-- AlterTable
ALTER TABLE "integrations" ADD COLUMN     "pipeline_metadata_error" TEXT,
ADD COLUMN     "pipeline_metadata_status" TEXT;


-- Hand-written guard: only the two documented states (null = never attempted).
ALTER TABLE "integrations"
  ADD CONSTRAINT integrations_pipeline_metadata_status_chk
  CHECK (pipeline_metadata_status IS NULL OR pipeline_metadata_status IN ('OK', 'UNAVAILABLE'));
