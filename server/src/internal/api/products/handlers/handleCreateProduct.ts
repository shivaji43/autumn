import { validateProductItems } from "@/internal/products/product-items/validateProductItems.js";
import {
  handleNewFreeTrial,
  validateAndInitFreeTrial,
} from "@/internal/products/free-trials/freeTrialUtils.js";

import RecaseError from "@/utils/errorUtils.js";
import { routeHandler } from "@/utils/routerUtils.js";
import {
  CreateProductSchema,
  ErrCode,
  FreeTrial,
  ProductResponseSchema,
} from "@autumn/shared";
import {
  keyToTitle,
  notNullish,
  nullish,
  validateId,
} from "@/utils/genUtils.js";

import { ProductService } from "@/internal/products/ProductService.js";
import { constructProduct } from "@/internal/products/productUtils.js";
import { handleNewProductItems } from "@/internal/products/product-items/productItemInitUtils.js";
import { FeatureService } from "@/internal/features/FeatureService.js";
import { Request } from "@/utils/models/Request.js";

const validateCreateProduct = async ({ req }: { req: Request }) => {
  let { free_trial, items } = req.body;
  let { orgId, env, sb } = req;

  let productData = CreateProductSchema.parse(req.body);

  validateId("Product", productData.id);

  if (nullish(req.body.name)) {
    productData.name = keyToTitle(productData.id);
  }

  const [features, existingProduct] = await Promise.all([
    FeatureService.getFeatures({
      sb,
      orgId,
      env,
    }),
    ProductService.getProductStrict({
      sb,
      productId: productData.id,
      orgId,
      env,
    }),
  ]);

  // 1. If existing product, throw error
  if (existingProduct) {
    throw new RecaseError({
      message: `Product ${productData.id} already exists`,
      code: ErrCode.ProductAlreadyExists,
      statusCode: 400,
    });
  }

  // 2. Validate items if exist

  if (items && !Array.isArray(items)) {
    throw new RecaseError({
      message: "Items must be an array",
      code: ErrCode.InvalidRequest,
      statusCode: 400,
    });
  } else if (items) {
    validateProductItems({
      newItems: items,
      features,
      orgId: req.orgId,
      env: req.env,
    });
  }

  // 3. Validate free trial if exist
  let freeTrial: FreeTrial | null = null;
  if (notNullish(free_trial)) {
    freeTrial = validateAndInitFreeTrial({
      freeTrial: free_trial,
      internalProductId: productData.id,
      isCustom: false,
    });
  }

  return {
    features,
    freeTrial,
    productData,
  };
};
export const handleCreateProduct = async (req: Request, res: any) =>
  routeHandler({
    req,
    res,
    action: "POST /products",
    handler: async (req, res) => {
      let { free_trial, items } = req.body;
      let { logtail: logger, orgId, env, sb, db } = req;

      let { features, freeTrial, productData } = await validateCreateProduct({
        req,
      });

      let newProduct = constructProduct({
        productData,
        orgId,
        env,
      });

      let product = await ProductService.create({ sb, product: newProduct });

      if (notNullish(items)) {
        await handleNewProductItems({
          db,
          sb,
          product,
          features,
          curPrices: [],
          curEnts: [],
          newItems: items,
          logger,
          isCustom: false,
          newVersion: false,
        });
      }

      if (notNullish(freeTrial)) {
        await handleNewFreeTrial({
          sb,
          newFreeTrial: freeTrial,
          curFreeTrial: null,
          internalProductId: product.internal_id,
          isCustom: false,
        });
      }

      res.status(200).json(
        ProductResponseSchema.parse({
          ...product,
          autumn_id: product.internal_id,
          items: items || [],
          free_trial: freeTrial,
        }),
      );
    },
  });
