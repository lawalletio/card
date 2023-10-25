-- CreateTable
CREATE TABLE "cards" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL,
    "holder_pub_key" TEXT,
    "ntag424_cid" TEXT NOT NULL,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("uuid")
);

-- CreateTable
CREATE TABLE "holders" (
    "pub_key" TEXT NOT NULL,

    CONSTRAINT "holders_pkey" PRIMARY KEY ("pub_key")
);

-- CreateTable
CREATE TABLE "delegations" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "delegator_pub_key" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "conditions" TEXT NOT NULL,
    "delegation_token" TEXT NOT NULL,

    CONSTRAINT "delegations_pkey" PRIMARY KEY ("uuid")
);

-- CreateTable
CREATE TABLE "limits" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "delta" INTEGER NOT NULL,
    "card_uuid" UUID NOT NULL,

    CONSTRAINT "limits_pkey" PRIMARY KEY ("uuid")
);

-- CreateTable
CREATE TABLE "payment_requests" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response" JSON NOT NULL,
    "card_uuid" UUID NOT NULL,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("uuid")
);

-- CreateTable
CREATE TABLE "payments" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "card_uuid" UUID NOT NULL,
    "payment_request_uuid" UUID NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("uuid")
);

-- CreateTable
CREATE TABLE "ntag424s" (
    "cid" TEXT NOT NULL,
    "k0" TEXT NOT NULL,
    "k1" TEXT NOT NULL,
    "k2" TEXT NOT NULL,
    "k3" TEXT NOT NULL,
    "k4" TEXT NOT NULL,
    "ctr" INTEGER NOT NULL,
    "otc" TEXT,
    "design_uuid" UUID NOT NULL,

    CONSTRAINT "ntag424s_pkey" PRIMARY KEY ("cid")
);

-- CreateTable
CREATE TABLE "designs" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "designs_pkey" PRIMARY KEY ("uuid")
);

-- CreateTable
CREATE TABLE "merchants" (
    "pub_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("pub_key")
);

-- CreateTable
CREATE TABLE "trusted_merchants" (
    "holder_pub_key" TEXT NOT NULL,
    "merchant_pub_key" TEXT NOT NULL,

    CONSTRAINT "trusted_merchants_pkey" PRIMARY KEY ("holder_pub_key","merchant_pub_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "cards_ntag424_cid_key" ON "cards"("ntag424_cid");

-- CreateIndex
CREATE UNIQUE INDEX "delegations_delegation_token_key" ON "delegations"("delegation_token");

-- CreateIndex
CREATE UNIQUE INDEX "limits_card_uuid_token_delta_key" ON "limits"("card_uuid", "token", "delta");

-- CreateIndex
CREATE UNIQUE INDEX "designs_name_key" ON "designs"("name");

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_holder_pub_key_fkey" FOREIGN KEY ("holder_pub_key") REFERENCES "holders"("pub_key") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_ntag424_cid_fkey" FOREIGN KEY ("ntag424_cid") REFERENCES "ntag424s"("cid") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_delegator_pub_key_fkey" FOREIGN KEY ("delegator_pub_key") REFERENCES "holders"("pub_key") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "limits" ADD CONSTRAINT "limits_card_uuid_fkey" FOREIGN KEY ("card_uuid") REFERENCES "cards"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_card_uuid_fkey" FOREIGN KEY ("card_uuid") REFERENCES "cards"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_card_uuid_fkey" FOREIGN KEY ("card_uuid") REFERENCES "cards"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_request_uuid_fkey" FOREIGN KEY ("payment_request_uuid") REFERENCES "payment_requests"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ntag424s" ADD CONSTRAINT "ntag424s_design_uuid_fkey" FOREIGN KEY ("design_uuid") REFERENCES "designs"("uuid") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "trusted_merchants" ADD CONSTRAINT "trusted_merchants_holder_pub_key_fkey" FOREIGN KEY ("holder_pub_key") REFERENCES "holders"("pub_key") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "trusted_merchants" ADD CONSTRAINT "trusted_merchants_merchant_pub_key_fkey" FOREIGN KEY ("merchant_pub_key") REFERENCES "merchants"("pub_key") ON DELETE NO ACTION ON UPDATE NO ACTION;
