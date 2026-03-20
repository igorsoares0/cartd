export type CartDrawerConfigJSON = {
  header: {
    title: string;
    fontSize: number;
    textColor: string;
    backgroundColor: string;
  };

  body: {
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
    showTrustBadges: boolean;
    trustBadgeUrls: string[];
  };
};

export type Reward = {
  id: string;
  type: "free_shipping";
  enabled: boolean;

  condition: {
    type: "price" | "quantity";
    value: number;
  };

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
  buttonText: string;

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
    header: {
      title: "Your Cart",
      fontSize: 18,
      textColor: "#000000",
      backgroundColor: "#FFFFFF",
    },
    body: {
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
      showTrustBadges: true,
      trustBadgeUrls: [],
    },
  };
}

export function extractRulesFromConfig(config: CartDrawerConfigJSON) {
  const freeShippingReward = config.body.rewards.find(
    (r) => r.type === "free_shipping" && r.enabled,
  );

  return {
    free_shipping: freeShippingReward
      ? {
          enabled: true,
          condition: freeShippingReward.condition,
        }
      : { enabled: false, condition: { type: "price" as const, value: 0 } },
    upsells: config.body.upsells
      .filter((u) => u.enabled && u.offer.type !== "none")
      .map((u) => ({
        productId: u.productId,
        variantId: u.variantId,
        offer: u.offer,
      })),
  };
}
