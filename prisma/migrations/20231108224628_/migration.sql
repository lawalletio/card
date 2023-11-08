-- CreateTable
CREATE TABLE "reset_tokens" (
    "holder_pub_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "token" TEXT NOT NULL,

    CONSTRAINT "reset_tokens_pkey" PRIMARY KEY ("holder_pub_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "reset_tokens_token_key" ON "reset_tokens"("token");

-- AddForeignKey
ALTER TABLE "reset_tokens" ADD CONSTRAINT "reset_tokens_holder_pub_key_fkey" FOREIGN KEY ("holder_pub_key") REFERENCES "holders"("pub_key") ON DELETE NO ACTION ON UPDATE NO ACTION;
