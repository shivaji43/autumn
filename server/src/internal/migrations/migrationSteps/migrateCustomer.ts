import {
  MigrationJob,
  Customer,
  Organization,
  AppEnv,
  FullProduct,
  FullCusProduct,
  Feature,
} from "@autumn/shared";

import { DrizzleCli } from "@/db/initDrizzle.js";

import { CusService } from "@/internal/customers/CusService.js";
import { ExtendedRequest } from "@/utils/models/Request.js";
import { createStripeCli } from "@/external/stripe/utils.js";
import { migrationToAttachParams } from "../migrationUtils/migrationToAttachParams.js";
import { runMigrationAttach } from "../migrationUtils/runMigrationAttach.js";

export const migrateCustomer = async ({
  db,
  migrationJob,
  customer,
  org,
  logger,
  env,
  orgId,
  fromProduct,
  toProduct,
  features,
}: {
  db: DrizzleCli;
  migrationJob: MigrationJob;
  customer: Customer;
  org: Organization;
  env: AppEnv;
  orgId: string;
  fromProduct: FullProduct;
  toProduct: FullProduct;
  logger: any;
  features: Feature[];
}) => {
  try {
    const stripeCli = createStripeCli({ org, env });
    let fullCus = await CusService.getFull({
      db,
      idOrInternalId: customer.id!,
      orgId,
      env,
      withEntities: true,
    });

    // 1. Build req object
    let req = {
      db,
      orgId,
      env,
      org,
      features,
      logtail: logger,
      timestamp: Date.now(),
    } as ExtendedRequest;

    const cusProducts = fullCus.customer_products;
    const filteredCusProducts = cusProducts.filter(
      (cp: FullCusProduct) => cp.product.internal_id == fromProduct.internal_id,
    );

    for (const cusProduct of filteredCusProducts) {
      const attachParams = await migrationToAttachParams({
        req,
        stripeCli,
        customer: fullCus,
        cusProduct,
        newProduct: toProduct,
      });

      await runMigrationAttach({
        req,
        attachParams,
      });
    }

    // // let cusProducts = await CusProductService.list({
    // //   db,
    // //   internalCustomerId: customer.internal_id,
    // //   inStatuses: [CusProductStatus.Active, CusProductStatus.PastDue],
    // // });

    // // let entities = await EntityService.list({
    // //   db,
    // //   internalCustomerId: customer.internal_id,
    // // });

    // let attachParams: AttachParams = {
    //   org,
    //   customer,
    //   products: [toProduct],
    //   prices: toProduct.prices,
    //   entitlements: toProduct.entitlements,
    //   freeTrial: toProduct.free_trial || null,
    //   features,
    //   optionsList: curCusProduct.options,
    //   entities,
    //   cusProducts,
    //   fromMigration: true,
    // };

    // // Get prepaid prices
    // let prepaidPrices = toProduct.prices.filter(
    //   (price: Price) =>
    //     getBillingType(price.config!) === BillingType.UsageInAdvance,
    // );

    // for (const prepaidPrice of prepaidPrices) {
    //   let config = prepaidPrice.config as UsagePriceConfig;

    //   let newPrepaid = curCusProduct.options.find(
    //     (option: FeatureOptions) =>
    //       option.internal_feature_id === config.internal_feature_id,
    //   );

    //   if (!newPrepaid) {
    //     curCusProduct.options.push({
    //       feature_id: config.feature_id,
    //       internal_feature_id: config.internal_feature_id,
    //       quantity: 0,
    //     });
    //   }
    // }

    // await handleUpgrade({
    //   req: {
    //     db,
    //     orgId,
    //     env,
    //     logtail: logger,
    //   },
    //   res: null,
    //   attachParams,
    //   curCusProduct,
    //   curFullProduct: fromProduct,
    //   fromReq: false,
    //   carryExistingUsages: true,
    //   prorationBehavior: ProrationBehavior.None,
    //   newVersion: true,
    // });

    return true;
  } catch (error: any) {
    logger.error(
      `Migration failed for customer ${customer.id}, job id: ${migrationJob.id}`,
    );
    logger.error(error);
    // logger.error(
    //   `Migration failed for customer ${customer.id}, job id: ${migrationJob.id}`,
    // );
    // logger.error(error);
    // if (error instanceof RecaseError) {
    //   logger.error(`Recase error: ${error.message} (${error.code})`);
    // } else if (error.type === "StripeError") {
    //   logger.error(`Stripe error: ${error.message} (${error.code})`);
    // } else {
    //   logger.error("Unknown error:", error);
    // }

    // await MigrationService.insertError({
    //   db,
    //   data: constructMigrationError({
    //     migrationJobId: migrationJob.id,
    //     internalCustomerId: customer.internal_id,
    //     data: error.data || error,
    //     code: error.code || "unknown",
    //     message: error.message || "unknown",
    //   }),
    // });

    return false;
  }
};

// let curCusProduct = cusProducts.find(
//   (cp: FullCusProduct) => cp.product.internal_id == fromProduct.internal_id,
// );

// if (!curCusProduct) {
//   logger.error(
//     `Customer ${customer.id} does not have a ${fromProduct.internal_id} cus product, skipping migration`,
//   );
//   return false;
// }
