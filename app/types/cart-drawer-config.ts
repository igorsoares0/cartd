export type CartDrawerConfigJSON = {
  enabled: boolean;

  header: {
    title: string;
    fontSize: number;
    textColor: string;
    backgroundColor: string;
  };

  body: {
    backgroundColor: string;

    announcementBar: {
      enabled: boolean;
      text: string;
      textColor: string;
      backgroundColor: string;
    };

    rewards: Reward[];
    upsells: Upsell[];
  };

  footer: {
    checkoutButtonText: string;
    checkoutButtonColor: string;
    checkoutButtonTextColor: string;
    checkoutButtonRadius: number;
    showTrustBadges: boolean;
    trustBadgeUrls: string[];
  };
};

export type Reward = {
  id: string;
  type: "free_shipping" | "percentage_discount";
  enabled: boolean;

  condition: {
    type: "price" | "quantity";
    value: number;
  };

  /** Only used when type === "percentage_discount" */
  discountValue?: number;

  design: {
    textBefore: string;
    textAfter: string;
    backgroundColor: string;
    textColor: string;
    progressColor: string;
  };
};

export type Upsell = {
  id: string;
  enabled: boolean;
  productId: string;
  variantId: string;

  title: string;
  imageUrl: string;
  buttonText: string;

  /** Available variants for the product */
  variants: { id: string; title: string }[];

  /** Hide this upsell if any of these product IDs are in the cart */
  excludeIfProductIds: string[];

  design: {
    textColor: string;
    buttonColor: string;
    buttonTextColor: string;
    backgroundColor: string;
    buttonRadius: number;
    cardRadius: number;
  };

  offer: {
    type: "percentage" | "fixed" | "none";
    value: number;
  };
};

export type EditorState = {
  config: CartDrawerConfigJSON;
  selectedSection:
    | "header"
    | "announcement"
    | "rewards"
    | "upsells"
    | "footer"
    | null;
  isDirty: boolean;
  isSaving: boolean;
  isPublishing: boolean;
};

export function createDefaultConfig(): CartDrawerConfigJSON {
  return {
    enabled: true,
    header: {
      title: "Your Cart",
      fontSize: 18,
      textColor: "#000000",
      backgroundColor: "#FFFFFF",
    },
    body: {
      backgroundColor: "#FFFFFF",
      announcementBar: {
        enabled: false,
        text: "",
        textColor: "#FFFFFF",
        backgroundColor: "#000000",
      },
      rewards: [],
      upsells: [],
    },
    footer: {
      checkoutButtonText: "Checkout",
      checkoutButtonColor: "#000000",
      checkoutButtonTextColor: "#FFFFFF",
      checkoutButtonRadius: 8,
      showTrustBadges: true,
      trustBadgeUrls: [],
    },
  };
}

export function extractRulesFromConfig(config: CartDrawerConfigJSON) {
  const enabledRewards = config.body.rewards.filter((r) => r.enabled);

  const freeShippingRewards = enabledRewards.filter(
    (r) => r.type === "free_shipping",
  );

  const percentageRewards = enabledRewards.filter(
    (r) => r.type === "percentage_discount",
  );

  return {
    free_shipping: freeShippingRewards.map((r) => ({
      enabled: true,
      condition: r.condition,
    })),
    percentage_discount: percentageRewards.map((r) => ({
      enabled: true,
      condition: r.condition,
      discountValue: r.discountValue ?? 10,
    })),
    upsells: config.body.upsells
      .filter((u) => u.enabled && u.offer.type !== "none")
      .map((u) => ({
        productId: u.productId,
        variantId: u.variantId,
        offer: u.offer,
      })),
  };
}
