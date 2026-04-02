import { useCallback, useEffect, useReducer } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  createDefaultConfig,
  extractRulesFromConfig,
  type CartDrawerConfigJSON,
  type EditorState,
  type Reward,
  type Upsell,
} from "../types/cart-drawer-config";
import { getShopBilling } from "../utils/billing.server";

// --- LOADER ---
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Check billing limits
  const billing = await getShopBilling(admin, shop);

  let record = await prisma.cartDrawerConfig.findUnique({ where: { shop } });

  if (!record) {
    const defaultConfig = createDefaultConfig();
    record = await prisma.cartDrawerConfig.create({
      data: {
        shop,
        config: JSON.stringify(defaultConfig),
        published: false,
      },
    });
  }

  // Get shop GID for metafield publishing
  const shopResponse = await admin.graphql(`
    query {
      shop {
        id
      }
    }
  `);
  const shopData = await shopResponse.json();

  const config = JSON.parse(record.config) as CartDrawerConfigJSON;
  // Normalize: old configs without 'enabled' default to true
  if (config.enabled === undefined) config.enabled = true;

  return {
    config,
    published: record.published,
    shopGid: shopData.data?.shop?.id ?? "",
    billing: {
      plan: billing.plan,
      orderCount: billing.orderCount,
      orderLimit: billing.orderLimit,
      isOverLimit: billing.isOverLimit,
    },
  };
};

// --- ACTION ---
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "save") {
    const configJson = formData.get("config") as string;
    // Validate JSON
    JSON.parse(configJson);

    await prisma.cartDrawerConfig.upsert({
      where: { shop },
      update: { config: configJson },
      create: { shop, config: configJson, published: false },
    });

    return { success: true, intent: "save" };
  }

  if (intent === "publish") {
    const configJson = formData.get("config") as string;
    const config = JSON.parse(configJson) as CartDrawerConfigJSON;
    const rules = extractRulesFromConfig(config);

    // Save to DB
    await prisma.cartDrawerConfig.upsert({
      where: { shop },
      update: { config: configJson, published: true },
      create: { shop, config: configJson, published: true },
    });

    // Get shop GID
    const shopResponse = await admin.graphql(`
      query { shop { id } }
    `);
    const shopData = await shopResponse.json();
    const shopGid = shopData.data?.shop?.id;

    // Ensure metafield definitions exist with storefront access (BEFORE setting values)
    const metafieldDefs = [
      { namespace: "supercartd", key: "config", name: "Cart Drawer Config" },
      { namespace: "supercartd", key: "rules", name: "Cart Drawer Rules" },
    ];

    for (const def of metafieldDefs) {
      try {
        // Try to create the definition
        const createRes = await admin.graphql(
          `mutation CreateMetafieldDef($definition: MetafieldDefinitionInput!) {
            metafieldDefinitionCreate(definition: $definition) {
              createdDefinition { id }
              userErrors { field message code }
            }
          }`,
          {
            variables: {
              definition: {
                namespace: def.namespace,
                key: def.key,
                name: def.name,
                ownerType: "SHOP",
                type: "json",
                access: {
                  storefront: "PUBLIC_READ",
                },
              },
            },
          },
        );
        const createData = await createRes.json();
        const errors = createData.data?.metafieldDefinitionCreate?.userErrors;

        if (errors && errors.length > 0) {
          console.log(`MetafieldDef ${def.key}: create errors:`, JSON.stringify(errors));
          // Definition likely already exists — update its access
          const updateRes = await admin.graphql(
            `mutation UpdateMetafieldDef($definition: MetafieldDefinitionUpdateInput!) {
              metafieldDefinitionUpdate(definition: $definition) {
                updatedDefinition { id }
                userErrors { field message }
              }
            }`,
            {
              variables: {
                definition: {
                  namespace: def.namespace,
                  key: def.key,
                  ownerType: "SHOP",
                  access: {
                    storefront: "PUBLIC_READ",
                  },
                },
              },
            },
          );
          const updateData = await updateRes.json();
          const updateErrors = updateData.data?.metafieldDefinitionUpdate?.userErrors;
          if (updateErrors && updateErrors.length > 0) {
            console.error(`MetafieldDef ${def.key}: update errors:`, JSON.stringify(updateErrors));
          } else {
            console.log(`MetafieldDef ${def.key}: updated storefront access to PUBLIC_READ`);
          }
        } else {
          console.log(`MetafieldDef ${def.key}: created with storefront PUBLIC_READ`);
        }
      } catch (err) {
        console.error(`MetafieldDef ${def.key}: error`, err);
      }
    }

    const rulesJson = JSON.stringify(rules);

    // Write shop metafields (for storefront JS)
    await admin.graphql(
      `#graphql
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: shopGid,
              namespace: "supercartd",
              key: "config",
              type: "json",
              value: configJson,
            },
            {
              ownerId: shopGid,
              namespace: "supercartd",
              key: "rules",
              type: "json",
              value: rulesJson,
            },
          ],
        },
      },
    );

    // --- Create/Update Automatic Discounts for Shopify Functions ---
    const configRecord = await prisma.cartDrawerConfig.findUnique({
      where: { shop },
    });

    // Get function IDs from deployed extensions
    const functionsRes = await admin.graphql(`
      query { shopifyFunctions(first: 25) { nodes { id title apiType } } }
    `);
    const functionsData = await functionsRes.json();
    const funcs = functionsData.data?.shopifyFunctions?.nodes || [];
    console.log(
      "Shopify Functions found:",
      JSON.stringify(funcs.map((f: any) => ({ id: f.id, title: f.title, apiType: f.apiType }))),
    );

    // Multi-target discount functions may report as "discount", "product_discounts", or "shipping_discounts"
    const discountFunc = funcs.find(
      (f: any) =>
        f.apiType === "discount" ||
        f.apiType === "product_discounts" ||
        f.apiType === "shipping_discounts",
    );

    let productDiscountGid = configRecord?.productDiscountGid || null;

    if (discountFunc) {
      if (productDiscountGid) {
        // Update existing discount: refresh metafield + ensure it's active (not expired)
        const updateRes = await admin.graphql(
          `#graphql
          mutation UpdateAutoDiscount($id: ID!, $discount: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $discount) {
              automaticAppDiscount { discountId status }
              userErrors { field message code }
            }
          }`,
          {
            variables: {
              id: productDiscountGid,
              discount: {
                startsAt: new Date().toISOString(),
                endsAt: null,
                metafields: [
                  {
                    namespace: "supercartd",
                    key: "rules",
                    type: "json",
                    value: rulesJson,
                  },
                ],
              },
            },
          },
        );
        const data = await updateRes.json() as any;
        if (data.errors?.length > 0) {
          console.warn("Discount update GraphQL errors:", JSON.stringify(data.errors));
          productDiscountGid = null;
        }
        const userErrors = data.data?.discountAutomaticAppUpdate?.userErrors || [];
        if (userErrors.length > 0) {
          console.warn("Discount update errors:", JSON.stringify(userErrors));
          productDiscountGid = null;
        } else if (!data.errors?.length) {
          const status = data.data?.discountAutomaticAppUpdate?.automaticAppDiscount?.status;
          console.log("Discount: updated and reactivated on", productDiscountGid, "status:", status);
        }
      }

      if (!productDiscountGid) {
        // Create new automatic discount
        const res = await admin.graphql(
          `#graphql
          mutation CreateAutoDiscount($discount: DiscountAutomaticAppInput!) {
            discountAutomaticAppCreate(automaticAppDiscount: $discount) {
              automaticAppDiscount { discountId }
              userErrors { field message code }
            }
          }`,
          {
            variables: {
              discount: {
                title: "SuperCartD Discounts",
                functionId: discountFunc.id,
                startsAt: new Date().toISOString(),
                discountClasses: ["PRODUCT", "SHIPPING"],
                combinesWith: {
                  orderDiscounts: true,
                  productDiscounts: true,
                  shippingDiscounts: true,
                },
                metafields: [
                  {
                    namespace: "supercartd",
                    key: "rules",
                    type: "json",
                    value: rulesJson,
                  },
                ],
              },
            },
          },
        );
        const data = await res.json() as any;
        // Check for GraphQL-level errors
        if (data.errors?.length > 0) {
          console.error("Discount create GraphQL errors:", JSON.stringify(data.errors));
        }
        const userErrors =
          data.data?.discountAutomaticAppCreate?.userErrors || [];
        if (userErrors.length > 0) {
          console.error("Discount create errors:", JSON.stringify(userErrors));
        } else if (!data.errors?.length) {
          productDiscountGid =
            data.data?.discountAutomaticAppCreate?.automaticAppDiscount
              ?.discountId || null;
          console.log("Discount: created with GID", productDiscountGid);
        }
      }
    } else {
      console.warn("Discount function not found in shopifyFunctions. Available:", JSON.stringify(funcs.map((f: any) => f.apiType)));
    }

    // Save discount GID
    await prisma.cartDrawerConfig.update({
      where: { shop },
      data: { productDiscountGid },
    });

    const debug = {
      functionFound: !!discountFunc,
      functionApiType: discountFunc?.apiType ?? null,
      functionId: discountFunc?.id ?? null,
      discountGid: productDiscountGid,
      rulesPreview: rulesJson.slice(0, 300),
      availableApiTypes: funcs.map((f: any) => f.apiType),
    };
    console.log("Publish debug:", JSON.stringify(debug, null, 2));

    return { success: true, intent: "publish", debug };
  }

  if (intent === "discard") {
    const record = await prisma.cartDrawerConfig.findUnique({
      where: { shop },
    });
    if (record) {
      return {
        success: true,
        intent: "discard",
        config: JSON.parse(record.config),
      };
    }
    return { success: true, intent: "discard", config: createDefaultConfig() };
  }

  return { success: false, error: "Unknown intent" };
};

// --- REDUCER ---
type EditorAction =
  | { type: "SELECT_SECTION"; section: EditorState["selectedSection"] }
  | { type: "UPDATE_CONFIG"; config: CartDrawerConfigJSON }
  | { type: "UPDATE_HEADER"; field: string; value: string | number }
  | { type: "UPDATE_BODY"; field: string; value: string }
  | {
      type: "UPDATE_ANNOUNCEMENT";
      field: string;
      value: string | boolean;
    }
  | { type: "UPDATE_FOOTER"; field: string; value: string | boolean }
  | { type: "ADD_REWARD" }
  | { type: "REMOVE_REWARD"; id: string }
  | { type: "UPDATE_REWARD"; id: string; path: string; value: unknown }
  | { type: "ADD_UPSELL" }
  | { type: "REMOVE_UPSELL"; id: string }
  | { type: "UPDATE_UPSELL"; id: string; path: string; value: unknown }
  | { type: "TOGGLE_ENABLED" }
  | { type: "SET_SAVING"; value: boolean }
  | { type: "SET_PUBLISHING"; value: boolean }
  | { type: "MARK_CLEAN" };

function generateId() {
  return "c" + Math.random().toString(36).substring(2, 11);
}

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "SELECT_SECTION":
      return { ...state, selectedSection: action.section };

    case "UPDATE_CONFIG":
      return { ...state, config: action.config, isDirty: false };

    case "TOGGLE_ENABLED":
      return {
        ...state,
        isDirty: true,
        config: { ...state.config, enabled: !state.config.enabled },
      };

    case "UPDATE_HEADER":
      return {
        ...state,
        isDirty: true,
        config: {
          ...state.config,
          header: { ...state.config.header, [action.field]: action.value },
        },
      };

    case "UPDATE_BODY":
      return {
        ...state,
        isDirty: true,
        config: {
          ...state.config,
          body: { ...state.config.body, [action.field]: action.value },
        },
      };

    case "UPDATE_ANNOUNCEMENT":
      return {
        ...state,
        isDirty: true,
        config: {
          ...state.config,
          body: {
            ...state.config.body,
            announcementBar: {
              ...state.config.body.announcementBar,
              [action.field]: action.value,
            },
          },
        },
      };

    case "UPDATE_FOOTER":
      return {
        ...state,
        isDirty: true,
        config: {
          ...state.config,
          footer: { ...state.config.footer, [action.field]: action.value },
        },
      };

    case "ADD_REWARD": {
      if (state.config.body.rewards.length >= 5) return state;
      const newReward: Reward = {
        id: generateId(),
        type: "free_shipping",
        enabled: true,
        condition: { type: "price", value: 50 },
        design: {
          textBefore:
            "Add {{remaining}} more for free shipping!",
          textAfter: "You've unlocked free shipping! 🎉",
          backgroundColor: "#F0F0F0",
          textColor: "#333333",
          progressColor: "#4CAF50",
        },
      };
      return {
        ...state,
        isDirty: true,
        config: {
          ...state.config,
          body: {
            ...state.config.body,
            rewards: [...state.config.body.rewards, newReward],
          },
        },
      };
    }

    case "REMOVE_REWARD":
      return {
        ...state,
        isDirty: true,
        config: {
          ...state.config,
          body: {
            ...state.config.body,
            rewards: state.config.body.rewards.filter(
              (r) => r.id !== action.id,
            ),
          },
        },
      };

    case "UPDATE_REWARD": {
      const rewards = state.config.body.rewards.map((r) => {
        if (r.id !== action.id) return r;
        const parts = action.path.split(".");
        const updated = { ...r } as Record<string, unknown>;
        if (parts.length === 1) {
          updated[parts[0]] = action.value;
        } else if (parts.length === 2) {
          updated[parts[0]] = {
            ...(updated[parts[0]] as Record<string, unknown>),
            [parts[1]]: action.value,
          };
        }
        return updated as unknown as Reward;
      });
      return {
        ...state,
        isDirty: true,
        config: { ...state.config, body: { ...state.config.body, rewards } },
      };
    }

    case "ADD_UPSELL": {
      if (state.config.body.upsells.length >= 5) return state;
      const newUpsell: Upsell = {
        id: generateId(),
        enabled: true,
        productId: "",
        variantId: "",
        title: "You might also like",
        imageUrl: "",
        buttonText: "Add",
        variants: [],
        excludeIfProductIds: [],
        design: {
          textColor: "#333333",
          buttonColor: "#000000",
          buttonTextColor: "#FFFFFF",
          backgroundColor: "#F9F9F9",
          buttonRadius: 4,
          cardRadius: 8,
        },
        offer: { type: "none", value: 0 },
      };
      return {
        ...state,
        isDirty: true,
        config: {
          ...state.config,
          body: {
            ...state.config.body,
            upsells: [...state.config.body.upsells, newUpsell],
          },
        },
      };
    }

    case "REMOVE_UPSELL":
      return {
        ...state,
        isDirty: true,
        config: {
          ...state.config,
          body: {
            ...state.config.body,
            upsells: state.config.body.upsells.filter(
              (u) => u.id !== action.id,
            ),
          },
        },
      };

    case "UPDATE_UPSELL": {
      const upsells = state.config.body.upsells.map((u) => {
        if (u.id !== action.id) return u;
        const parts = action.path.split(".");
        const updated = { ...u } as Record<string, unknown>;
        if (parts.length === 1) {
          updated[parts[0]] = action.value;
        } else if (parts.length === 2) {
          updated[parts[0]] = {
            ...(updated[parts[0]] as Record<string, unknown>),
            [parts[1]]: action.value,
          };
        }
        return updated as unknown as Upsell;
      });
      return {
        ...state,
        isDirty: true,
        config: { ...state.config, body: { ...state.config.body, upsells } },
      };
    }

    case "SET_SAVING":
      return { ...state, isSaving: action.value };
    case "SET_PUBLISHING":
      return { ...state, isPublishing: action.value };
    case "MARK_CLEAN":
      return { ...state, isDirty: false };
    default:
      return state;
  }
}

// --- SECTION COMPONENTS ---
function HeaderSection({
  config,
  dispatch,
}: {
  config: CartDrawerConfigJSON;
  dispatch: React.Dispatch<EditorAction>;
}) {
  return (
    <s-section heading="Header">
      <s-stack direction="block" gap="base">
        <s-text-field
          label="Title"
          name="header-title"
          value={config.header.title}
          onInput={(e: Event) =>
            dispatch({
              type: "UPDATE_HEADER",
              field: "title",
              value: (e.target as HTMLInputElement).value,
            })
          }
        />
        <s-number-field
          label="Font Size (px)"
          name="header-fontSize"
          value={String(config.header.fontSize)}
          min={10}
          max={36}
          step={1}
          onInput={(e: Event) =>
            dispatch({
              type: "UPDATE_HEADER",
              field: "fontSize",
              value: Number((e.target as HTMLInputElement).value),
            })
          }
        />
        <s-color-field
          label="Text Color"
          name="header-textColor"
          value={config.header.textColor}
          onInput={(e: Event) =>
            dispatch({
              type: "UPDATE_HEADER",
              field: "textColor",
              value: (e.target as HTMLInputElement).value,
            })
          }
        />
        <s-color-field
          label="Background Color"
          name="header-bgColor"
          value={config.header.backgroundColor}
          onInput={(e: Event) =>
            dispatch({
              type: "UPDATE_HEADER",
              field: "backgroundColor",
              value: (e.target as HTMLInputElement).value,
            })
          }
        />
        <s-color-field
          label="Drawer Background"
          name="body-bgColor"
          value={config.body.backgroundColor}
          onInput={(e: Event) =>
            dispatch({
              type: "UPDATE_BODY",
              field: "backgroundColor",
              value: (e.target as HTMLInputElement).value,
            })
          }
        />
      </s-stack>
    </s-section>
  );
}

function AnnouncementSection({
  config,
  dispatch,
}: {
  config: CartDrawerConfigJSON;
  dispatch: React.Dispatch<EditorAction>;
}) {
  const bar = config.body.announcementBar;
  return (
    <s-section heading="Announcement Bar">
      <s-stack direction="block" gap="base">
        <s-switch
          label="Enabled"
          name="announcement-enabled"
          checked={bar.enabled || undefined}
          onChange={() =>
            dispatch({
              type: "UPDATE_ANNOUNCEMENT",
              field: "enabled",
              value: !bar.enabled,
            })
          }
        />
        {bar.enabled && (
          <>
            <s-text-field
              label="Text"
              name="announcement-text"
              value={bar.text}
              onInput={(e: Event) =>
                dispatch({
                  type: "UPDATE_ANNOUNCEMENT",
                  field: "text",
                  value: (e.target as HTMLInputElement).value,
                })
              }
            />
            <s-color-field
              label="Text Color"
              name="announcement-textColor"
              value={bar.textColor}
              onInput={(e: Event) =>
                dispatch({
                  type: "UPDATE_ANNOUNCEMENT",
                  field: "textColor",
                  value: (e.target as HTMLInputElement).value,
                })
              }
            />
            <s-color-field
              label="Background Color"
              name="announcement-bgColor"
              value={bar.backgroundColor}
              onInput={(e: Event) =>
                dispatch({
                  type: "UPDATE_ANNOUNCEMENT",
                  field: "backgroundColor",
                  value: (e.target as HTMLInputElement).value,
                })
              }
            />
          </>
        )}
      </s-stack>
    </s-section>
  );
}

function RewardsSection({
  config,
  dispatch,
}: {
  config: CartDrawerConfigJSON;
  dispatch: React.Dispatch<EditorAction>;
}) {
  const rewards = config.body.rewards;
  return (
    <s-section heading="Rewards">
      <s-stack direction="block" gap="base">
        {rewards.map((reward, idx) => (
          <s-box
            key={reward.id}
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" align-items="center">
                <s-heading>
                  Reward {idx + 1} —{" "}
                  {reward.type === "free_shipping"
                    ? "Free Shipping"
                    : `${reward.discountValue ?? 10}% Off`}
                </s-heading>
                <s-button
                  variant="tertiary"
                  tone="critical"
                  onClick={() =>
                    dispatch({ type: "REMOVE_REWARD", id: reward.id })
                  }
                >
                  Remove
                </s-button>
              </s-stack>

              <s-select
                label="Reward Type"
                name={`reward-${reward.id}-type`}
                value={reward.type}
                onInput={(e: Event) =>
                  dispatch({
                    type: "UPDATE_REWARD",
                    id: reward.id,
                    path: "type",
                    value: (e.target as HTMLSelectElement).value,
                  })
                }
              >
                <s-option value="free_shipping">Free Shipping</s-option>
                <s-option value="percentage_discount">
                  Percentage Discount
                </s-option>
              </s-select>

              {reward.type === "percentage_discount" && (
                <s-number-field
                  label="Discount (%)"
                  name={`reward-${reward.id}-discountValue`}
                  value={String(reward.discountValue ?? 10)}
                  min={1}
                  max={100}
                  step={1}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_REWARD",
                      id: reward.id,
                      path: "discountValue",
                      value: Number((e.target as HTMLInputElement).value),
                    })
                  }
                />
              )}

              <s-switch
                label="Enabled"
                name={`reward-${reward.id}-enabled`}
                checked={reward.enabled || undefined}
                onChange={() =>
                  dispatch({
                    type: "UPDATE_REWARD",
                    id: reward.id,
                    path: "enabled",
                    value: !reward.enabled,
                  })
                }
              />

              <s-select
                label="Condition Type"
                name={`reward-${reward.id}-condType`}
                value={reward.condition.type}
                onInput={(e: Event) =>
                  dispatch({
                    type: "UPDATE_REWARD",
                    id: reward.id,
                    path: "condition.type",
                    value: (e.target as HTMLSelectElement).value,
                  })
                }
              >
                <s-option value="price">Cart Price</s-option>
                <s-option value="quantity">Cart Quantity</s-option>
              </s-select>

              <s-number-field
                label={
                  reward.condition.type === "price"
                    ? "Minimum Amount ($)"
                    : "Minimum Quantity"
                }
                name={`reward-${reward.id}-condValue`}
                value={String(reward.condition.value)}
                min={1}
                step={1}
                onInput={(e: Event) =>
                  dispatch({
                    type: "UPDATE_REWARD",
                    id: reward.id,
                    path: "condition.value",
                    value: Number((e.target as HTMLInputElement).value),
                  })
                }
              />

              <s-text-field
                label="Text Before (use {{remaining}} and {{target}})"
                name={`reward-${reward.id}-textBefore`}
                value={reward.design.textBefore}
                onInput={(e: Event) =>
                  dispatch({
                    type: "UPDATE_REWARD",
                    id: reward.id,
                    path: "design.textBefore",
                    value: (e.target as HTMLInputElement).value,
                  })
                }
              />

              <s-text-field
                label="Text After (shown when unlocked)"
                name={`reward-${reward.id}-textAfter`}
                value={reward.design.textAfter}
                onInput={(e: Event) =>
                  dispatch({
                    type: "UPDATE_REWARD",
                    id: reward.id,
                    path: "design.textAfter",
                    value: (e.target as HTMLInputElement).value,
                  })
                }
              />

              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", minWidth: 0 }}>
                <s-color-field
                  label="Background"
                  name={`reward-${reward.id}-bg`}
                  value={reward.design.backgroundColor}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_REWARD",
                      id: reward.id,
                      path: "design.backgroundColor",
                      value: (e.target as HTMLInputElement).value,
                    })
                  }
                />
                <s-color-field
                  label="Text Color"
                  name={`reward-${reward.id}-textColor`}
                  value={reward.design.textColor}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_REWARD",
                      id: reward.id,
                      path: "design.textColor",
                      value: (e.target as HTMLInputElement).value,
                    })
                  }
                />
                <s-color-field
                  label="Progress Color"
                  name={`reward-${reward.id}-progressColor`}
                  value={reward.design.progressColor}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_REWARD",
                      id: reward.id,
                      path: "design.progressColor",
                      value: (e.target as HTMLInputElement).value,
                    })
                  }
                />
              </div>
            </s-stack>
          </s-box>
        ))}

        {rewards.length < 5 && (
          <s-button
            variant="secondary"
            onClick={() => dispatch({ type: "ADD_REWARD" })}
          >
            Add Reward
          </s-button>
        )}
      </s-stack>
    </s-section>
  );
}

function UpsellsSection({
  config,
  dispatch,
}: {
  config: CartDrawerConfigJSON;
  dispatch: React.Dispatch<EditorAction>;
}) {
  const shopify = useAppBridge();
  const upsells = config.body.upsells;

  const handlePickProduct = useCallback(
    async (upsellId: string) => {
      try {
        const selected = await shopify.resourcePicker({
          type: "product",
          multiple: false,
          action: "select",
        });
        if (selected && selected.length > 0) {
          const product = selected[0];
          dispatch({
            type: "UPDATE_UPSELL",
            id: upsellId,
            path: "productId",
            value: product.id,
          });
          dispatch({
            type: "UPDATE_UPSELL",
            id: upsellId,
            path: "title",
            value: product.title,
          });
          // Save product image
          const imgSrc =
            product.images?.[0]?.originalSrc || "";
          dispatch({
            type: "UPDATE_UPSELL",
            id: upsellId,
            path: "imageUrl",
            value: imgSrc,
          });
          // Save all variants
          const variants = (product.variants || []).map(
            (v) => ({
              id: v.id || "",
              title: v.title || "Default",
            }),
          );
          dispatch({
            type: "UPDATE_UPSELL",
            id: upsellId,
            path: "variants",
            value: variants,
          });
          if (variants.length > 0) {
            dispatch({
              type: "UPDATE_UPSELL",
              id: upsellId,
              path: "variantId",
              value: variants[0].id,
            });
          }
        }
      } catch {
        // User cancelled picker
      }
    },
    [shopify, dispatch],
  );

  const handlePickExclusions = useCallback(
    async (upsellId: string, currentExclusions: string[]) => {
      try {
        const selected = await shopify.resourcePicker({
          type: "product",
          multiple: true,
          action: "select",
        });
        if (selected && selected.length > 0) {
          const newIds = selected.map((p: { id: string }) => p.id);
          const merged = [...new Set([...currentExclusions, ...newIds])];
          dispatch({
            type: "UPDATE_UPSELL",
            id: upsellId,
            path: "excludeIfProductIds",
            value: merged,
          });
        }
      } catch {
        // User cancelled picker
      }
    },
    [shopify, dispatch],
  );

  return (
    <s-section heading="Upsells">
      <s-stack direction="block" gap="base">
        {upsells.map((upsell, idx) => (
          <s-box
            key={upsell.id}
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base" align-items="center">
                <s-heading>Upsell {idx + 1}</s-heading>
                <s-button
                  variant="tertiary"
                  tone="critical"
                  onClick={() =>
                    dispatch({ type: "REMOVE_UPSELL", id: upsell.id })
                  }
                >
                  Remove
                </s-button>
              </s-stack>

              <s-switch
                label="Enabled"
                name={`upsell-${upsell.id}-enabled`}
                checked={upsell.enabled || undefined}
                onChange={() =>
                  dispatch({
                    type: "UPDATE_UPSELL",
                    id: upsell.id,
                    path: "enabled",
                    value: !upsell.enabled,
                  })
                }
              />

              <s-stack direction="inline" gap="base" align-items="end">
                <s-text-field
                  label="Product"
                  name={`upsell-${upsell.id}-product`}
                  value={upsell.title}
                  readOnly
                />
                <s-button
                  variant="secondary"
                  onClick={() => handlePickProduct(upsell.id)}
                >
                  Pick Product
                </s-button>
              </s-stack>

              {/* Product image preview */}
              {upsell.imageUrl && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <img
                    src={upsell.imageUrl}
                    alt={upsell.title}
                    style={{
                      width: "48px",
                      height: "48px",
                      objectFit: "cover",
                      borderRadius: "6px",
                      border: "1px solid #ddd",
                    }}
                  />
                  <span style={{ fontSize: "12px", color: "#666" }}>Product image</span>
                </div>
              )}

              {/* Variant selector */}
              {(upsell.variants ?? []).length > 1 && (
                <s-select
                  label="Variant"
                  name={`upsell-${upsell.id}-variant`}
                  value={upsell.variantId}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_UPSELL",
                      id: upsell.id,
                      path: "variantId",
                      value: (e.target as HTMLSelectElement).value,
                    })
                  }
                >
                  {(upsell.variants ?? []).map((v) => (
                    <s-option key={v.id} value={v.id}>
                      {v.title}
                    </s-option>
                  ))}
                </s-select>
              )}

              {/* Product exclusion */}
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="base" align-items="center">
                  <s-text>
                    Exclusions: {(upsell.excludeIfProductIds ?? []).length === 0
                      ? "None"
                      : `${(upsell.excludeIfProductIds ?? []).length} product(s)`}
                  </s-text>
                  <s-button
                    variant="tertiary"
                    onClick={() =>
                      handlePickExclusions(
                        upsell.id,
                        upsell.excludeIfProductIds ?? [],
                      )
                    }
                  >
                    Add Exclusion
                  </s-button>
                  {(upsell.excludeIfProductIds ?? []).length > 0 && (
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      onClick={() =>
                        dispatch({
                          type: "UPDATE_UPSELL",
                          id: upsell.id,
                          path: "excludeIfProductIds",
                          value: [],
                        })
                      }
                    >
                      Clear
                    </s-button>
                  )}
                </s-stack>
              </s-stack>

              <s-text-field
                value={upsell.buttonText}
                onInput={(e: Event) =>
                  dispatch({
                    type: "UPDATE_UPSELL",
                    id: upsell.id,
                    path: "buttonText",
                    value: (e.target as HTMLInputElement).value,
                  })
                }
              />

              <s-select
                label="Offer Type"
                name={`upsell-${upsell.id}-offerType`}
                value={upsell.offer.type}
                onInput={(e: Event) =>
                  dispatch({
                    type: "UPDATE_UPSELL",
                    id: upsell.id,
                    path: "offer.type",
                    value: (e.target as HTMLSelectElement).value,
                  })
                }
              >
                <s-option value="none">No Discount</s-option>
                <s-option value="percentage">Percentage Off</s-option>
                <s-option value="fixed">Fixed Amount Off</s-option>
              </s-select>

              {upsell.offer.type !== "none" && (
                <s-number-field
                  label={
                    upsell.offer.type === "percentage"
                      ? "Discount (%)"
                      : "Discount ($)"
                  }
                  name={`upsell-${upsell.id}-offerValue`}
                  value={String(upsell.offer.value)}
                  min={0}
                  step={1}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_UPSELL",
                      id: upsell.id,
                      path: "offer.value",
                      value: Number((e.target as HTMLInputElement).value),
                    })
                  }
                />
              )}

              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", minWidth: 0 }}>
                <s-color-field
                  label="Button Color"
                  name={`upsell-${upsell.id}-btnColor`}
                  value={upsell.design.buttonColor}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_UPSELL",
                      id: upsell.id,
                      path: "design.buttonColor",
                      value: (e.target as HTMLInputElement).value,
                    })
                  }
                />
                <s-color-field
                  label="Button Text Color"
                  name={`upsell-${upsell.id}-btnTextColor`}
                  value={upsell.design.buttonTextColor}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_UPSELL",
                      id: upsell.id,
                      path: "design.buttonTextColor",
                      value: (e.target as HTMLInputElement).value,
                    })
                  }
                />
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", minWidth: 0 }}>
                <s-color-field
                  label="Card Background"
                  name={`upsell-${upsell.id}-cardBg`}
                  value={upsell.design.backgroundColor}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_UPSELL",
                      id: upsell.id,
                      path: "design.backgroundColor",
                      value: (e.target as HTMLInputElement).value,
                    })
                  }
                />
                <s-color-field
                  label="Text Color"
                  name={`upsell-${upsell.id}-textColor`}
                  value={upsell.design.textColor}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_UPSELL",
                      id: upsell.id,
                      path: "design.textColor",
                      value: (e.target as HTMLInputElement).value,
                    })
                  }
                />
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", minWidth: 0 }}>
                <s-number-field
                  label="Button Radius (px)"
                  name={`upsell-${upsell.id}-btnRadius`}
                  value={String(upsell.design.buttonRadius)}
                  min={0}
                  max={50}
                  step={1}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_UPSELL",
                      id: upsell.id,
                      path: "design.buttonRadius",
                      value: Number((e.target as HTMLInputElement).value),
                    })
                  }
                />
                <s-number-field
                  label="Card Radius (px)"
                  name={`upsell-${upsell.id}-cardRadius`}
                  value={String(upsell.design.cardRadius)}
                  min={0}
                  max={50}
                  step={1}
                  onInput={(e: Event) =>
                    dispatch({
                      type: "UPDATE_UPSELL",
                      id: upsell.id,
                      path: "design.cardRadius",
                      value: Number((e.target as HTMLInputElement).value),
                    })
                  }
                />
              </div>
            </s-stack>
          </s-box>
        ))}

        {upsells.length < 5 && (
          <s-button
            variant="secondary"
            onClick={() => dispatch({ type: "ADD_UPSELL" })}
          >
            Add Upsell
          </s-button>
        )}
      </s-stack>
    </s-section>
  );
}

function FooterSection({
  config,
  dispatch,
}: {
  config: CartDrawerConfigJSON;
  dispatch: React.Dispatch<EditorAction>;
}) {
  return (
    <s-section heading="Footer">
      <s-stack direction="block" gap="base">
        <s-text-field
          label="Checkout Button Text"
          name="footer-btnText"
          value={config.footer.checkoutButtonText}
          onInput={(e: Event) =>
            dispatch({
              type: "UPDATE_FOOTER",
              field: "checkoutButtonText",
              value: (e.target as HTMLInputElement).value,
            })
          }
        />
        <s-color-field
          label="Button Color"
          name="footer-btnColor"
          value={config.footer.checkoutButtonColor}
          onInput={(e: Event) =>
            dispatch({
              type: "UPDATE_FOOTER",
              field: "checkoutButtonColor",
              value: (e.target as HTMLInputElement).value,
            })
          }
        />
        <s-color-field
          label="Button Text Color"
          name="footer-btnTextColor"
          value={config.footer.checkoutButtonTextColor}
          onInput={(e: Event) =>
            dispatch({
              type: "UPDATE_FOOTER",
              field: "checkoutButtonTextColor",
              value: (e.target as HTMLInputElement).value,
            })
          }
        />
        <s-switch
          label="Show Trust Badges"
          name="footer-trustBadges"
          checked={config.footer.showTrustBadges || undefined}
          onChange={() =>
            dispatch({
              type: "UPDATE_FOOTER",
              field: "showTrustBadges",
              value: !config.footer.showTrustBadges,
            })
          }
        />
      </s-stack>
    </s-section>
  );
}

// --- MAIN COMPONENT ---
export default function Editor() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [state, dispatch] = useReducer(editorReducer, {
    config: loaderData.config,
    selectedSection: "header",
    isDirty: false,
    isSaving: false,
    isPublishing: false,
  });

  // Handle fetcher results
  useEffect(() => {
    if (fetcher.data && fetcher.state === "idle") {
      const data = fetcher.data as Record<string, unknown>;
      if (data.success) {
        if (data.intent === "save") {
          dispatch({ type: "MARK_CLEAN" });
          dispatch({ type: "SET_SAVING", value: false });
          shopify.toast.show("Draft saved");
        } else if (data.intent === "publish") {
          dispatch({ type: "MARK_CLEAN" });
          dispatch({ type: "SET_PUBLISHING", value: false });
          const debug = data.debug as any;
          if (debug) {
            console.log("Publish debug:", debug);
            const discountStatus = debug.discountGid
              ? "Discount active"
              : debug.functionFound
                ? "Function found but discount creation failed"
                : `Function not found (apiTypes: ${debug.availableApiTypes?.join(", ")})`;
            shopify.toast.show(`Published — ${discountStatus}`);
          } else {
            shopify.toast.show("Published successfully");
          }
        } else if (data.intent === "discard") {
          dispatch({
            type: "UPDATE_CONFIG",
            config: data.config as CartDrawerConfigJSON,
          });
          shopify.toast.show("Changes discarded");
        }
      }
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const handleSave = useCallback(() => {
    dispatch({ type: "SET_SAVING", value: true });
    fetcher.submit(
      { intent: "save", config: JSON.stringify(state.config) },
      { method: "POST" },
    );
  }, [fetcher, state.config]);

  const handlePublish = useCallback(() => {
    dispatch({ type: "SET_PUBLISHING", value: true });
    fetcher.submit(
      { intent: "publish", config: JSON.stringify(state.config) },
      { method: "POST" },
    );
  }, [fetcher, state.config]);

  const handleDiscard = useCallback(() => {
    fetcher.submit({ intent: "discard" }, { method: "POST" });
  }, [fetcher]);

  const sections: {
    id: EditorState["selectedSection"];
    label: string;
  }[] = [
    { id: "header", label: "Header" },
    { id: "announcement", label: "Announcement Bar" },
    { id: "rewards", label: "Rewards" },
    { id: "upsells", label: "Upsells" },
    { id: "footer", label: "Footer" },
  ];

  const isBusy = state.isSaving || state.isPublishing;
  const { billing } = loaderData;
  const isOverLimit = billing.isOverLimit;
  const previewDockWidth = "clamp(380px, 30vw, 520px)";
  const editorPanelWidth = "clamp(480px, 38vw, 620px)";

  return (
    <s-page heading="Cart Drawer Editor" inline-size="full">
      {isOverLimit && (
        <s-banner heading="Plan limit reached" tone="warning">
          You've used all {billing.orderLimit} orders for this month on the{" "}
          {billing.plan} plan. Publishing is disabled until you upgrade.{" "}
          <a href="/app/billing">Upgrade your plan</a>
        </s-banner>
      )}

      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handlePublish}
        {...(state.isPublishing ? { loading: true } : {})}
        {...(isBusy || isOverLimit ? { disabled: true } : {})}
      >
        Publish
      </s-button>

      <s-button-group slot="secondary-action">
        <s-button
          onClick={handleSave}
          {...(state.isSaving ? { loading: true } : {})}
          {...(!state.isDirty || isBusy ? { disabled: true } : {})}
        >
          Save Draft
        </s-button>
        <s-button
          variant="tertiary"
          onClick={handleDiscard}
          {...(!state.isDirty || isBusy ? { disabled: true } : {})}
        >
          Discard Changes
        </s-button>
      </s-button-group>

      <div
        style={{
          display: "flex",
          gap: "20px",
          alignItems: "flex-start",
          minHeight: "calc(100dvh - 120px)",
          paddingRight: previewDockWidth,
          overflowX: "hidden",
        }}
      >
        {/* Sidebar area - use page scroll (native scrollbar on window right side) */}
        <div
          style={{
            flex: 1,
            paddingRight: "16px",
            paddingBottom: "24px",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: editorPanelWidth,
              minWidth: editorPanelWidth,
              maxWidth: editorPanelWidth,
              flexShrink: 0,
              paddingBottom: "16px",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "grid", gap: "14px", minWidth: 0, width: "100%" }}>
              <div style={{ minWidth: 0, overflow: "hidden" }}>
                <s-section heading="Cart Drawer">
                  <s-switch
                    label="Enable Cart Drawer"
                    checked={state.config.enabled || undefined}
                    onChange={() => dispatch({ type: "TOGGLE_ENABLED" })}
                  />
                  {!state.config.enabled && (
                    <p style={{ fontSize: "13px", color: "#666", margin: "8px 0 0" }}>
                      The cart drawer will not appear on your storefront.
                    </p>
                  )}
                </s-section>
              </div>

              <div style={!state.config.enabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
                <div style={{ minWidth: 0, overflow: "hidden" }}>
                  <s-section heading="Sections">
                  <s-stack direction="block" gap="base">
                    {sections.map((section) => {
                      const isSelected = state.selectedSection === section.id;
                      return (
                        <div key={section.id ?? undefined}>
                          <div
                            style={{
                              borderRadius: "10px",
                              overflow: "hidden",
                              border: isSelected ? "1px solid #8c9196" : "1px solid transparent",
                            }}
                          >
                            <s-clickable
                              padding="base"
                              {...(isSelected ? { background: "subdued" } : {})}
                              onClick={() =>
                                dispatch({
                                  type: "SELECT_SECTION",
                                  section: isSelected ? null : section.id,
                                })
                              }
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: "8px",
                                }}
                              >
                                <s-text {...(isSelected ? { type: "strong" } : {})}>{section.label}</s-text>
                                <span style={{ fontSize: "12px", color: "#6d7175" }}>{isSelected ? "▼" : "▶"}</span>
                              </div>
                            </s-clickable>
                          </div>

                          {/* Section editor inline — right below the clicked section */}
                          {isSelected && (
                            <div
                              style={{
                                marginTop: "8px",
                                padding: "12px",
                                borderRadius: "10px",
                                border: "1px solid #e1e3e5",
                                background: "#fafbfb",
                                overflow: "hidden",
                                minWidth: 0,
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                              {section.id === "header" && (
                                <HeaderSection
                                  config={state.config}
                                  dispatch={dispatch}
                                />
                              )}
                              {section.id === "announcement" && (
                                <AnnouncementSection
                                  config={state.config}
                                  dispatch={dispatch}
                                />
                              )}
                              {section.id === "rewards" && (
                                <RewardsSection
                                  config={state.config}
                                  dispatch={dispatch}
                                />
                              )}
                              {section.id === "upsells" && (
                                <UpsellsSection
                                  config={state.config}
                                  dispatch={dispatch}
                                />
                              )}
                              {section.id === "footer" && (
                                <FooterSection
                                  config={state.config}
                                  dispatch={dispatch}
                                />
                              )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </s-stack>
                </s-section>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Preview - sticky on the right */}
        <div
          style={{
            position: "fixed",
            top: "0",
            right: "0",
            width: previewDockWidth,
            height: "100dvh",
            display: "flex",
            justifyContent: "stretch",
            alignItems: "stretch",
            minHeight: 0,
            padding: 0,
            overflow: "hidden",
            borderLeft: "1px solid #dfe3e8",
            zIndex: 5,
            background: "#fff",
          }}
        >
          <CartDrawerPreview config={state.config} />
        </div>
      </div>
    </s-page>
  );
}

// --- INLINE PREVIEW ---
function CartDrawerPreview({ config }: { config: CartDrawerConfigJSON }) {
  const mockItems = [
    {
      title: "Example Product",
      price: "$29.99",
      quantity: 1,
      image: "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png",
    },
    {
      title: "Another Product",
      price: "$49.99",
      quantity: 2,
      image: "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png",
    },
  ];

  const totalPrice = 129.97;

  // Calculate reward progress
  const rewardProgress = config.body.rewards
    .filter((r) => r.enabled)
    .map((r) => {
      const current =
        r.condition.type === "price" ? totalPrice : mockItems.reduce((s, i) => s + i.quantity, 0);
      const progress = Math.min((current / r.condition.value) * 100, 100);
      const remaining =
        r.condition.type === "price"
          ? `$${Math.max(r.condition.value - current, 0).toFixed(2)}`
          : `${Math.max(r.condition.value - current, 0)}`;
      const met = current >= r.condition.value;
      return { ...r, progress, remaining, met };
    });

  return (
    <div
      style={{
        width: "100%",
        maxWidth: "100%",
        height: "100dvh",
        backgroundColor: config.body.backgroundColor || "#fff",
        borderRadius: 0,
        boxShadow: "none",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px",
          backgroundColor: config.header.backgroundColor,
          color: config.header.textColor,
          fontSize: `${config.header.fontSize}px`,
          fontWeight: 600,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #eee",
        }}
      >
        <span>{config.header.title}</span>
        <span style={{ cursor: "pointer", fontSize: "18px" }}>✕</span>
      </div>

      {/* Announcement */}
      {config.body.announcementBar.enabled && config.body.announcementBar.text && (
        <div
          style={{
            padding: "8px 16px",
            backgroundColor: config.body.announcementBar.backgroundColor,
            color: config.body.announcementBar.textColor,
            fontSize: "13px",
            textAlign: "center",
          }}
        >
          {config.body.announcementBar.text}
        </div>
      )}

      {/* Static content in preview: rewards + items + upsells */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {/* Rewards progress */}
        {rewardProgress.map((rp) => (
          <div
            key={rp.id}
            style={{
              padding: "12px 16px",
              backgroundColor: rp.design.backgroundColor,
              color: rp.design.textColor,
              fontSize: "13px",
            }}
          >
            <div style={{ marginBottom: "6px" }}>
              {rp.met
                ? rp.design.textAfter
                : rp.design.textBefore
                    .replace("{{remaining}}", rp.remaining)
                    .replace("{{target}}", String(rp.condition.value))}
            </div>
            <div
              style={{
                height: "6px",
                borderRadius: "3px",
                backgroundColor: "#E0E0E0",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${rp.progress}%`,
                  backgroundColor: rp.design.progressColor,
                  borderRadius: "3px",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>
        ))}

        {/* Cart items */}
        <div style={{ padding: "16px" }}>
        {mockItems.map((item, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              gap: "12px",
              marginBottom: "12px",
              paddingBottom: "12px",
              borderBottom: "1px solid #eee",
            }}
          >
            <div
              style={{
                width: "60px",
                height: "60px",
                backgroundColor: "#f5f5f5",
                borderRadius: "4px",
                overflow: "hidden",
              }}
            >
              <img
                src={item.image}
                alt={item.title}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500, fontSize: "14px" }}>
                {item.title}
              </div>
              <div
                style={{
                  color: "#666",
                  fontSize: "13px",
                  marginTop: "4px",
                }}
              >
                {item.price}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  marginTop: "8px",
                }}
              >
                <button
                  style={{
                    width: "24px",
                    height: "24px",
                    border: "1px solid #ccc",
                    borderRadius: "4px",
                    background: "#fff",
                    cursor: "pointer",
                  }}
                >
                  −
                </button>
                <span style={{ fontSize: "14px" }}>{item.quantity}</span>
                <button
                  style={{
                    width: "24px",
                    height: "24px",
                    border: "1px solid #ccc",
                    borderRadius: "4px",
                    background: "#fff",
                    cursor: "pointer",
                  }}
                >
                  +
                </button>
              </div>
            </div>
          </div>
        ))}

        {/* Upsell cards */}
        {config.body.upsells
          .filter((u) => u.enabled)
          .map((upsell) => (
            <div
              key={upsell.id}
              style={{
                backgroundColor: upsell.design.backgroundColor,
                borderRadius: `${upsell.design.cardRadius}px`,
                padding: "12px",
                marginBottom: "8px",
                display: "flex",
                alignItems: "center",
                gap: "10px",
              }}
            >
              {upsell.imageUrl && (
                <img
                  src={upsell.imageUrl}
                  alt={upsell.title}
                  style={{
                    width: "48px",
                    height: "48px",
                    objectFit: "cover",
                    borderRadius: "6px",
                    flexShrink: 0,
                  }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 500,
                    fontSize: "13px",
                    color: upsell.design.textColor,
                  }}
                >
                  {upsell.title || "Upsell Product"}
                </div>
                {upsell.offer.type !== "none" && (
                  <div style={{ fontSize: "11px", color: "#888", marginTop: "2px" }}>
                    {upsell.offer.type === "percentage"
                      ? `${upsell.offer.value}% OFF`
                      : `$${upsell.offer.value} OFF`}
                  </div>
                )}
                {(upsell.variants ?? []).length > 1 && (
                  <div style={{ fontSize: "11px", color: "#888", marginTop: "2px" }}>
                    {(upsell.variants ?? []).find((v) => v.id === upsell.variantId)?.title || "Select variant"}
                  </div>
                )}
              </div>
              <button
                style={{
                  backgroundColor: upsell.design.buttonColor,
                  color: upsell.design.buttonTextColor,
                  border: "none",
                  borderRadius: `${upsell.design.buttonRadius}px`,
                  padding: "6px 16px",
                  fontSize: "13px",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {upsell.buttonText}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          padding: "16px",
          borderTop: "1px solid #eee",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: "12px",
            fontWeight: 600,
          }}
        >
          <span>Subtotal</span>
          <span>${totalPrice.toFixed(2)}</span>
        </div>
        <button
          style={{
            width: "100%",
            padding: "14px",
            backgroundColor: config.footer.checkoutButtonColor,
            color: config.footer.checkoutButtonTextColor,
            border: "none",
            borderRadius: "8px",
            fontSize: "16px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {config.footer.checkoutButtonText}
        </button>
        {config.footer.showTrustBadges && (
          <div
            style={{
              textAlign: "center",
              marginTop: "8px",
              fontSize: "11px",
              color: "#999",
            }}
          >
            🔒 Secure Checkout · 💳 All major cards accepted
          </div>
        )}
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
