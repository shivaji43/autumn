import { CusProductService } from "@/internal/customers/products/CusProductService.js";

import {
  AppEnv,
  BillingType,
  CusProductStatus,
  Customer,
  EntInterval,
  FullCusProduct,
  FullCustomerEntitlement,
  FullCustomerPrice,
  LoggerAction,
  Organization,
  Price,
  UsagePriceConfig,
} from "@autumn/shared";
import { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { createStripeCli } from "../utils.js";
import { differenceInMinutes, subDays } from "date-fns";
import { getStripeSubs, getUsageBasedSub } from "../stripeSubUtils.js";
import { getBillingType } from "@/internal/prices/priceUtils.js";
import { CustomerEntitlementService } from "@/internal/customers/entitlements/CusEntitlementService.js";
import { Decimal } from "decimal.js";
import { getRelatedCusEnt } from "@/internal/customers/prices/cusPriceUtils.js";
import { notNullish } from "@/utils/genUtils.js";
import { getTotalNegativeBalance } from "@/internal/customers/entitlements/cusEntUtils.js";
import { getResetBalancesUpdate } from "@/internal/customers/entitlements/groupByUtils.js";
import { createLogtailWithContext } from "@/external/logtail/logtailUtils.js";
import { EntityService } from "@/internal/api/entities/EntityService.js";
import { Client } from "pg";
import { FeatureService } from "@/internal/features/FeatureService.js";
import { getFeatureName } from "@/internal/features/displayUtils.js";
import { submitUsageToStripe } from "../stripeMeterUtils.js";
import { getInvoiceItemForUsage } from "../stripePriceUtils.js";

const handleInArrearProrated = async ({
  sb,
  cusEnts,
  cusPrice,
  customer,
  org,
  env,
  invoice,
  usageSub,
  pg,
  logger,
}: {
  sb: SupabaseClient;
  cusEnts: FullCustomerEntitlement[];
  cusPrice: FullCustomerPrice;
  customer: Customer;
  org: Organization;
  env: AppEnv;
  invoice: Stripe.Invoice;
  usageSub: Stripe.Subscription;
  pg: any;
  logger: any;
}) => {
  const cusEnt = getRelatedCusEnt({
    cusPrice,
    cusEnts,
  });

  if (!cusEnt) {
    console.log("No related cus ent found");
    return;
  }

  // console.log("Invoice period start:\t", formatUnixToDateTime(invoice.period_start * 1000));
  // console.log("Invoice period end:\t", formatUnixToDateTime(invoice.period_end * 1000));
  // console.log("Sub period start:\t", formatUnixToDateTime(usageSub.current_period_start * 1000));
  // console.log("Sub period end:\t", formatUnixToDateTime(usageSub.current_period_end * 1000));

  // Check if invoice is for new subscription period by comparing billing period
  const isNewPeriod = invoice.period_start !== usageSub.current_period_start;
  if (!isNewPeriod) {
    logger.info("Invoice is not for new subscription period, skipping...");
    return;
  }

  let feature = cusEnt.entitlement.feature;
  logger.info(
    `Handling invoice.created for in arrear prorated, feature: ${feature.id}`
  );

  let deletedEntities = await EntityService.getByInternalCustomerId({
    sb,
    internalCustomerId: customer.internal_id!,
    inFeatureIds: [feature.internal_id!],
    isDeleted: true,
    logger,
  });

  if (deletedEntities.length == 0) {
    logger.info("No deleted entities found");
    return;
  }

  logger.info(
    `✨ Handling in arrear prorated, customer ${customer.name}, org: ${org.slug}`
  );

  logger.info(
    `Deleting entities, feature ${feature.id}, customer ${customer.id}, org ${org.slug}`,
    deletedEntities
  );

  // Get linked cus ents

  for (const linkedCusEnt of cusEnts) {
    // isLinked
    let isLinked = linkedCusEnt.entitlement.entity_feature_id == feature.id;

    if (!isLinked) {
      continue;
    }

    logger.info(
      `Linked cus ent: ${linkedCusEnt.feature_id}, isLinked: ${isLinked}`
    );

    // Delete cus ent ids
    let newEntities = structuredClone(linkedCusEnt.entities!);
    for (const entityId in newEntities) {
      if (deletedEntities.some((e) => e.id == entityId)) {
        delete newEntities[entityId];
      }
    }

    console.log("New entities: ", newEntities);
    console.log("Cus ent ID: ", linkedCusEnt.id);

    let updated = await CustomerEntitlementService.update({
      sb,
      id: linkedCusEnt.id,
      updates: {
        entities: newEntities,
      },
    });
    console.log(`Updated ${updated.length} cus ents`);

    logger.info(
      `Feature: ${feature.id}, customer: ${customer.id}, deleted entities from cus ent`
    );
    linkedCusEnt.entities = newEntities;
  }

  await EntityService.deleteInInternalIds({
    sb,
    internalIds: deletedEntities.map((e) => e.internal_id!),
    orgId: org.id,
    env,
  });
  logger.info(
    `Feature: ${feature.id}, Deleted ${
      deletedEntities.length
    }, entities: ${deletedEntities.map((e) => `${e.id}`).join(", ")}`
  );

  // Increase balance
  if (notNullish(cusEnt.balance)) {
    logger.info(`Incrementing balance for cus ent: ${cusEnt.id}`);
    await pg.query(
      `UPDATE customer_entitlements SET balance = balance + ${deletedEntities.length} WHERE id = '${cusEnt.id}'`
    );
  }
};

const handleUsageInArrear = async ({
  sb,
  invoice,
  customer,
  relatedCusEnt,
  stripeCli,
  price,
  usageSub,
  logger,
  activeProduct,
}: {
  sb: SupabaseClient;
  invoice: Stripe.Invoice;
  customer: Customer;
  relatedCusEnt: FullCustomerEntitlement;
  stripeCli: Stripe;
  price: Price;
  usageSub: Stripe.Subscription;
  logger: any;
  activeProduct: FullCusProduct;
}) => {
  let invoiceCreatedRecently = invoiceCusProductCreatedDifference({
    invoice,
    cusProduct: activeProduct,
    minutes: 10,
  });

  let invoiceFromUpgrade = invoice.billing_reason == "subscription_update";
  if (invoiceCreatedRecently) {
    logger.info("Invoice created recently, skipping");
    return;
  }

  if (invoiceFromUpgrade) {
    logger.info("Invoice is from upgrade, skipping");
    return;
  }

  // For cancel at period end: invoice period start = sub period start (cur cycle), invoice period end = sub period end (a month later...)
  // For cancel immediately: invoice period start = sub period start (cur cycle), invoice period end cancel immediately date
  // For regular billing: invoice period end = sub period start (next cycle)
  // For upgrade, bill_immediately: invoice period start = sub period start (cur cycle), invoice period end cancel immediately date

  let allowance = relatedCusEnt.entitlement.allowance!;
  let config = price.config as UsagePriceConfig;

  // If relatedCusEnt's balance > 0 and next_reset_at is null, skip...
  if (relatedCusEnt.balance! > 0 && !relatedCusEnt.next_reset_at) {
    logger.info("Balance > 0 and next_reset_at is null, skipping");
    return;
  }

  const totalNegativeBalance = getTotalNegativeBalance({
    cusEnt: relatedCusEnt as any,
    balance: relatedCusEnt.balance!,
    entities: relatedCusEnt.entities!,
    billingUnits: (price.config as UsagePriceConfig).billing_units || 1,
  });

  const totalQuantity = new Decimal(allowance)
    .minus(totalNegativeBalance)
    .toNumber();

  const billingUnits = (price.config as UsagePriceConfig).billing_units || 1;

  const roundedQuantity =
    Math.ceil(new Decimal(totalQuantity).div(billingUnits).toNumber()) *
    billingUnits;

  const usageTimestamp = Math.round(
    subDays(new Date(invoice.created * 1000), 1).getTime() / 1000
  );

  let feature = relatedCusEnt.entitlement.feature;
  if (activeProduct.internal_entity_id) {
    let currency = invoice.currency;
    let invoiceItem = getInvoiceItemForUsage({
      stripeInvoiceId: invoice.id,
      price,
      overage: -totalNegativeBalance,
      customer,
      currency,
      cusProduct: activeProduct,
      feature,
      totalUsage: totalQuantity,
      logger,
      periodStart: invoice.period_start,
      periodEnd: invoice.period_end,
    });

    await stripeCli.invoiceItems.create(invoiceItem);
  } else {
    if (!config.stripe_meter_id) {
      logger.warn(
        `Price ${price.id} has no stripe meter id, skipping invoice.created for usage in arrear`
      );
      return;
    }

    await submitUsageToStripe({
      price,
      stripeCli,
      usage: roundedQuantity,
      customer,
      usageTimestamp,
      feature: relatedCusEnt.entitlement.feature,
      logger,
    });
  }

  // let invoiceCreatedStr = formatUnixToDateTime(invoice.created * 1000);
  // let usageTimestampStr = formatUnixToDateTime(usageTimestamp * 1000);
  // logger.info(
  //   `Invoice created: ${invoiceCreatedStr}, Usage timestamp: ${usageTimestampStr}`
  // );

  if (relatedCusEnt.entitlement.interval == EntInterval.Lifetime) {
    return;
  }

  let ent = relatedCusEnt.entitlement;
  let resetBalancesUpdate = getResetBalancesUpdate({
    cusEnt: relatedCusEnt,
    allowance: ent.interval == EntInterval.Lifetime ? 0 : ent.allowance!,
  });

  await CustomerEntitlementService.update({
    sb,
    id: relatedCusEnt.id,
    updates: {
      ...resetBalancesUpdate,
      adjustment: 0,
      next_reset_at: relatedCusEnt.next_reset_at
        ? usageSub.current_period_end * 1000
        : null, // TODO: check if this is correct
    },
  });
  logger.info("✅ Successfully reset balance & adjustment");
};

export const sendUsageAndReset = async ({
  sb,
  activeProduct,
  org,
  env,
  invoice,
  stripeSubs,
  logger,
  pg,
}: {
  sb: SupabaseClient;
  activeProduct: FullCusProduct;
  org: Organization;
  env: AppEnv;
  invoice: Stripe.Invoice;
  stripeSubs: Stripe.Subscription[];
  logger: any;
  pg: Client;
}) => {
  // Get cus ents
  const cusProductWithEntsAndPrices = await CusProductService.getEntsAndPrices({
    sb,
    cusProductId: activeProduct.id,
  });

  const cusEnts = cusProductWithEntsAndPrices.customer_entitlements;
  const cusPrices = cusProductWithEntsAndPrices.customer_prices;

  const stripeCli = createStripeCli({ org, env });
  const customer = activeProduct.customer;

  for (const cusPrice of cusPrices) {
    const price = cusPrice.price;
    let billingType = getBillingType(price.config);

    if (
      billingType !== BillingType.UsageInArrear &&
      billingType !== BillingType.InArrearProrated
    ) {
      continue;
    }

    let relatedCusEnt = getRelatedCusEnt({
      cusPrice,
      cusEnts,
    });

    if (!relatedCusEnt) {
      continue;
    }

    let usageBasedSub = await getUsageBasedSub({
      sb: sb,
      stripeCli,
      subIds: activeProduct.subscription_ids || [],
      feature: relatedCusEnt.entitlement.feature,
      stripeSubs,
    });

    if (!usageBasedSub || usageBasedSub.id != invoice.subscription) {
      continue;
    }

    // If trial just ended, skip
    if (usageBasedSub.trial_end == usageBasedSub.current_period_start) {
      logger.info(`Trial just ended, skipping usage invoice.created`);
      continue;
    }

    if (billingType == BillingType.UsageInArrear) {
      logger.info(
        `✨ Handling end of period usage for customer ${customer.name}, org: ${org.slug}`
      );

      logger.info(`   - Feature: ${relatedCusEnt.entitlement.feature.id}`);

      await handleUsageInArrear({
        sb,
        invoice,
        customer,
        relatedCusEnt,
        stripeCli,
        price,
        usageSub: usageBasedSub,
        logger,
        activeProduct,
      });
    }

    if (billingType == BillingType.InArrearProrated) {
      await handleInArrearProrated({
        sb,
        cusEnts,
        cusPrice,
        customer,
        org,
        env,
        invoice,
        usageSub: usageBasedSub,
        logger,
        pg,
      });
    }
  }
};

const invoiceCusProductCreatedDifference = ({
  invoice,
  cusProduct,
  minutes = 60,
}: {
  invoice: Stripe.Invoice;
  cusProduct: FullCusProduct;
  minutes?: number;
}) => {
  return (
    Math.abs(
      differenceInMinutes(
        new Date(cusProduct.created_at),
        new Date(invoice.created * 1000)
      )
    ) < minutes
  );
};

export const handleInvoiceCreated = async ({
  pg,
  sb,
  org,
  invoice,
  env,
  event,
}: {
  pg: Client;
  sb: SupabaseClient;
  org: Organization;
  invoice: Stripe.Invoice;
  env: AppEnv;
  event: Stripe.Event;
}) => {
  const logger = createLogtailWithContext({
    org: org,
    invoice: invoice,
    action: LoggerAction.StripeWebhookInvoiceCreated,
  });

  // Get stripe subscriptions

  if (invoice.subscription) {
    const activeProducts = await CusProductService.getByStripeSubId({
      sb,
      stripeSubId: invoice.subscription as string,
      orgId: org.id,
      env,
      inStatuses: [
        CusProductStatus.Active,
        CusProductStatus.Expired,
        CusProductStatus.PastDue,
      ],
    });

    if (activeProducts.length == 0) {
      logger.warn(
        `Stripe invoice.created -- no active products found (${org.slug})`
      );
      return;
    }

    let internalEntityId = activeProducts.find(
      (p) => p.internal_entity_id
    )?.internal_entity_id;

    let features = await FeatureService.getFeatures({
      sb,
      orgId: org.id,
      env,
    });

    if (internalEntityId) {
      // Add memo to invoice
      try {
        let stripeCli = createStripeCli({ org, env });
        let entity = await EntityService.getByInternalId({
          sb,
          internalId: internalEntityId,
          orgId: org.id,
          env,
        });

        let feature = features.find(
          (f) => f.internal_id == entity?.internal_feature_id
        );

        let entDetails = "";
        if (entity.name) {
          entDetails = `${entity.name}${
            entity.id ? ` (ID: ${entity.id})` : ""
          }`;
        } else if (entity.id) {
          entDetails = `${entity.id}`;
        }

        if (entDetails) {
          await stripeCli.invoices.update(invoice.id, {
            description: `${getFeatureName({
              feature,
              plural: false,
              capitalize: true,
            })}: ${entity?.name} (ID: ${entity?.id})`,
          });
        }
      } catch (error: any) {
        if (
          error.message != "Finalized invoices can't be updated in this way"
        ) {
          logger.error(`Failed to add entity ID to invoice description`, error);
        }
      }
    }

    const stripeSubs = await getStripeSubs({
      stripeCli: createStripeCli({ org, env }),
      subIds: activeProducts.map((p) => p.subscription_ids).flat(),
    });

    for (const activeProduct of activeProducts) {
      await sendUsageAndReset({
        sb,
        activeProduct,
        org,
        env,
        stripeSubs,
        invoice,
        logger,
        pg,
      });
    }
  }
};
