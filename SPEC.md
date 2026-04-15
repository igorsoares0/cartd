# SuperCartD - Spec-Driven Development

## 1. Product Overview

**SuperCartD** is a Shopify embedded app that replaces the default cart with a customizable cart drawer designed to increase Average Order Value (AOV) through progress-based rewards, upsells with automatic discounts, and conversion-optimized UX.

**Core value proposition:** Revenue Optimization Engine for Shopify stores.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ADMIN APP (React Router + Polaris)        │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Visual Editor │  │   Billing    │  │    Analytics      │  │
│  │ (Sidebar +   │  │  Management  │  │    Dashboard      │  │
│  │  Preview)    │  │              │  │                   │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────────┘  │
│         │                 │                  │              │
│         ▼                 ▼                  ▼              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              PostgreSQL (Prisma ORM)                 │    │
│  │  Session | CartDrawerConfig | ShopUsage | Analytics  │    │
│  └──────────────────────┬──────────────────────────────┘    │
└─────────────────────────┼───────────────────────────────────┘
                          │ Publish
                          ▼
              ┌───────────────────────┐
              │  Shop Metafields      │
              │  (Published Config)   │
              └───────┬───────────────┘
                      │ Read by
          ┌───────────┼───────────────┐
          ▼                           ▼
┌──────────────────┐    ┌──────────────────────────┐
│ Theme App Ext.   │    │ Shopify Functions (Rust)  │
│ (Cart Drawer JS) │    │ ├─ Product Discounts      │
│                  │    │ └─ Delivery Discounts     │
│ Uses AJAX API:   │    │                          │
│ /cart.js         │    │ Reads metafield config   │
│ /cart/add.js     │    │ to determine rules       │
│ /cart/change.js  │    │                          │
└──────────────────┘    └──────────────────────────┘
```

---

## 3. Data Specifications

### 3.1 Prisma Schema (PostgreSQL)

```prisma
model Session {
  id                  String    @id
  shop                String
  state               String
  isOnline            Boolean   @default(false)
  scope               String?
  expires             DateTime?
  accessToken         String
  userId              BigInt?
  firstName           String?
  lastName            String?
  email               String?
  accountOwner        Boolean   @default(false)
  locale              String?
  collaborator        Boolean?  @default(false)
  emailVerified       Boolean?  @default(false)
  refreshToken        String?
  refreshTokenExpires DateTime?
}

model CartDrawerConfig {
  id        String   @id @default(cuid())
  shop      String   @unique
  config    Json                         // CartDrawerConfigJSON (draft)
  published Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model ShopUsage {
  id         String @id @default(cuid())
  shop       String
  month      String                      // "2026-03"
  orderCount Int    @default(0)
  plan       String @default("starter")  // starter | growth | pro

  @@unique([shop, month])
}

model AnalyticsEvent {
  id        String   @id @default(cuid())
  shop      String
  event     String                       // drawer_open | upsell_click | upsell_add | checkout_click
  metadata  Json?                        // { productId, value, etc. }
  createdAt DateTime @default(now())

  @@index([shop, event])
  @@index([shop, createdAt])
}
```

### 3.2 CartDrawerConfig JSON Shape

This is the JSON stored in `CartDrawerConfig.config` and published to metafields.

```typescript
type CartDrawerConfigJSON = {
  header: {
    title: string               // default: "Your Cart"
    fontSize: number            // px, default: 18
    textColor: string           // hex, default: "#000000"
    backgroundColor: string    // hex, default: "#FFFFFF"
  }

  body: {
    announcementBar: {
      enabled: boolean          // default: false
      text: string              // default: ""
      textColor: string         // hex
      backgroundColor: string  // hex
    }

    rewards: Reward[]           // max 3 for MVP
    upsells: Upsell[]           // max 3 for MVP
  }

  footer: {
    checkoutButtonText: string       // default: "Checkout"
    checkoutButtonColor: string      // hex
    checkoutButtonTextColor: string  // hex
    showTrustBadges: boolean         // default: true
    trustBadgeUrls: string[]         // image URLs
  }
}

type Reward = {
  id: string                    // cuid
  type: "free_shipping"
  enabled: boolean

  condition: {
    type: "price" | "quantity"
    value: number               // e.g. 100 (dollars) or 5 (items)
  }

  design: {
    textBefore: string          // "Add {{remaining}} more for free shipping!"
    textAfter: string           // "You've unlocked free shipping!"
    backgroundColor: string
    textColor: string
    progressColor: string
  }
}

type Upsell = {
  id: string                    // cuid
  enabled: boolean
  productId: string             // Shopify GID
  variantId: string             // Shopify GID (pre-selected variant)

  title: string
  buttonText: string            // default: "Add"

  design: {
    textColor: string
    buttonColor: string
    buttonTextColor: string
    backgroundColor: string
    buttonRadius: number        // px
    cardRadius: number          // px
  }

  offer: {
    type: "percentage" | "fixed" | "none"
    value: number               // 0 when type is "none"
  }
}
```

### 3.3 Metafield Specification

| Namespace    | Key      | Type       | Owner    | Purpose                                |
|-------------|----------|------------|----------|----------------------------------------|
| `supercartd` | `config` | `json`     | Shop     | Published config read by storefront JS |
| `supercartd` | `rules`  | `json`     | Shop     | Rules read by Shopify Functions         |

**`supercartd.config`** — Full `CartDrawerConfigJSON` (used by Theme Extension JS).

**`supercartd.rules`** — Subset consumed by Functions:
```json
{
  "free_shipping": {
    "enabled": true,
    "condition": { "type": "quantity", "value": 5 }
  },
  "upsells": [
    {
      "productId": "gid://shopify/Product/123",
      "variantId": "gid://shopify/ProductVariant/456",
      "offer": { "type": "percentage", "value": 20 }
    }
  ]
}
```

---

## 4. Feature Specifications

### FEAT-01: Visual Editor

**Description:** Admin page with sidebar controls + live preview iframe. The merchant configures every aspect of the cart drawer visually.

**Route:** `/app/editor`

**Layout:**
```
┌─────────────────────────────────────────────────────┐
│  Toolbar: [Save Draft] [Publish] [Discard Changes]  │
├──────────────────┬──────────────────────────────────┤
│                  │                                  │
│  Sidebar         │  Preview (iframe)                │
│  ┌────────────┐  │                                  │
│  │ Header     │  │  ┌──────────────────────────┐    │
│  ├────────────┤  │  │  Cart Drawer Preview     │    │
│  │ Announce.  │  │  │  (receives config via    │    │
│  ├────────────┤  │  │   postMessage)           │    │
│  │ Rewards    │  │  │                          │    │
│  ├────────────┤  │  └──────────────────────────┘    │
│  │ Upsells    │  │                                  │
│  ├────────────┤  │                                  │
│  │ Footer     │  │                                  │
│  └────────────┘  │                                  │
│                  │                                  │
└──────────────────┴──────────────────────────────────┘
```

**State management:** `useReducer` on the editor page. State shape:
```typescript
type EditorState = {
  config: CartDrawerConfigJSON
  selectedSection: "header" | "announcement" | "rewards" | "upsells" | "footer" | null
  isDirty: boolean
  isSaving: boolean
  isPublishing: boolean
}
```

**Actions (API):**
| Action            | Method | Route                 | Description                                            |
|-------------------|--------|-----------------------|--------------------------------------------------------|
| Load config       | GET    | `/app/editor` loader  | Load draft from DB, or create default                  |
| Save draft        | POST   | `/app/editor` action  | `intent=save` — persist to `CartDrawerConfig` table    |
| Publish           | POST   | `/app/editor` action  | `intent=publish` — save to DB + write metafields       |
| Discard           | POST   | `/app/editor` action  | `intent=discard` — reload last saved from DB           |

**Acceptance criteria:**
- [ ] Sidebar renders section list; clicking a section shows its controls
- [ ] Header section: edit title, fontSize, textColor, backgroundColor
- [ ] Announcement section: toggle enabled, edit text, textColor, backgroundColor
- [ ] Rewards section: add/remove rewards (max 3), edit condition type/value, design fields
- [ ] Upsells section: add/remove upsells (max 3), product picker via ResourcePicker, edit design/offer
- [ ] Footer section: edit checkout button text/colors, toggle trust badges
- [ ] Preview iframe updates in real-time via `postMessage` on every state change
- [ ] Save Draft persists to DB without publishing
- [ ] Publish writes config to DB and metafields via Admin GraphQL `metafieldsSet`
- [ ] Discard reloads last-saved config from DB
- [ ] Loading and error states shown via Polaris Banner/Spinner

### FEAT-02: Cart Drawer (Storefront)

**Description:** JavaScript-rendered cart drawer injected via Theme App Extension. Independent of theme — works on any Shopify theme.

**Extension:** `extensions/supercartdrawer`

**Initialization flow:**
```
1. Theme Extension Liquid injects <script> with config from metafield
2. JS reads window.__SUPERCARTD_CONFIG__
3. JS intercepts all "Add to Cart" form submissions
4. On add: POST /cart/add.js → GET /cart.js → render drawer
5. Drawer opens as slide-in panel from right
```

**Cart Drawer DOM structure:**
```html
<div id="supercartd-overlay">
  <div id="supercartd-drawer">
    <div class="scd-header">         <!-- title + close button -->
    <div class="scd-announcement">   <!-- announcement bar -->
    <div class="scd-rewards">        <!-- progress bar -->
    <div class="scd-items">          <!-- cart line items -->
    <div class="scd-upsells">        <!-- upsell cards -->
    <div class="scd-footer">         <!-- subtotal + checkout button + trust badges -->
  </div>
</div>
```

**AJAX Cart API interactions:**
| Endpoint         | Method | When                          |
|-----------------|--------|-------------------------------|
| `/cart.js`       | GET    | On drawer open, after any mutation |
| `/cart/add.js`   | POST   | Add to cart, add upsell       |
| `/cart/change.js`| POST   | Change quantity, remove item  |

**Acceptance criteria:**
- [ ] Drawer renders from config stored in `window.__SUPERCARTD_CONFIG__`
- [ ] Intercepts native "Add to Cart" without breaking theme forms
- [ ] Drawer slides in from right with overlay backdrop
- [ ] Close via X button, overlay click, or Escape key
- [ ] Shows all cart line items with image, title, price, quantity +/- controls
- [ ] Remove item via quantity = 0 or delete button
- [ ] Announcement bar shows when enabled in config
- [ ] Progress bar calculates reward progress (price or quantity based)
- [ ] Progress bar text interpolates `{{remaining}}` and `{{target}}`
- [ ] Upsell cards render for enabled upsells whose product is not already in cart
- [ ] "Add" on upsell adds product via `/cart/add.js` and refreshes cart state
- [ ] Footer shows subtotal, checkout button (links to `/checkout`), and trust badges
- [ ] All colors/fonts/radii respect config values
- [ ] No dependency on theme CSS — all styles scoped/inline
- [ ] Works on mobile (responsive)
- [ ] No flicker on open (config pre-loaded)

### FEAT-03: Free Shipping (Shopify Function - Delivery Discount)

**Target:** `cart.delivery-options.discounts.generate.run`

**Description:** Applies 100% delivery discount when cart meets the reward condition defined in metafield config.

**Input query must read:**
```graphql
query Input {
  cart {
    lines {
      id
      quantity
      cost {
        subtotalAmount {
          amount
        }
      }
    }
    deliveryGroups {
      id
    }
  }
  discountNode {
    metafield(namespace: "supercartd", key: "rules") {
      value
    }
  }
  discount {
    discountClasses
  }
}
```

**Logic:**
```
1. Parse metafield JSON → get free_shipping config
2. If !free_shipping.enabled → return empty operations
3. If condition.type == "quantity":
     sum all cart line quantities
     if sum >= condition.value → apply 100% delivery discount
4. If condition.type == "price":
     sum all cart line subtotal amounts
     if sum >= condition.value → apply 100% delivery discount
5. Apply to all delivery groups
```

**Acceptance criteria:**
- [ ] Reads config from `discountNode.metafield`
- [ ] Returns empty operations when free_shipping is disabled
- [ ] Correctly sums quantity across all cart lines
- [ ] Correctly sums price (subtotalAmount) across all cart lines
- [ ] Applies `Percentage(100.0)` to all delivery groups when condition met
- [ ] Does not apply discount when condition is not met
- [ ] Gracefully handles missing/malformed metafield (no panic, return empty)

### FEAT-04: Upsell Discount (Shopify Function - Product Discount)

**Target:** `cart.lines.discounts.generate.run`

**Description:** Applies product-level discount to upsell items that are in the cart, based on the offer configured in metafield.

**Input query must read:**
```graphql
query Input {
  cart {
    lines {
      id
      quantity
      merchandise {
        ... on ProductVariant {
          id
          product {
            id
          }
        }
      }
      cost {
        subtotalAmount {
          amount
        }
      }
    }
  }
  discountNode {
    metafield(namespace: "supercartd", key: "rules") {
      value
    }
  }
  discount {
    discountClasses
  }
}
```

**Logic:**
```
1. Parse metafield JSON → get upsells array
2. For each upsell with offer.type != "none":
     Find cart line where merchandise.product.id == upsell.productId
       OR merchandise.id == upsell.variantId
     If found:
       Apply discount (percentage or fixed_amount) to that cart line
       Message: "{value}% OFF" or "${value} OFF"
3. Return all discount operations
```

**Acceptance criteria:**
- [ ] Reads upsell rules from `discountNode.metafield`
- [ ] Returns empty operations when no upsells have offers
- [ ] Matches cart lines by product ID or variant ID
- [ ] Applies percentage discount correctly
- [ ] Applies fixed amount discount correctly
- [ ] Does not discount items that are not upsell products
- [ ] Handles multiple upsells in cart simultaneously
- [ ] Gracefully handles missing/malformed metafield

### FEAT-05: Billing (Order-Based Plans)

**Description:** Three-tier billing based on monthly order count. Tracked via `orders/create` webhook.

**Plans:**
| Plan    | Orders/month | Price   |
|---------|-------------|---------|
| Starter | 100         | $9.99   |
| Growth  | 500         | $29.99  |
| Pro     | Unlimited   | $79.99  |

**Route:** `/app/billing`

**Webhook:** `orders/create` → increments `ShopUsage.orderCount`

**Flow:**
```
1. App install → default to Starter plan
2. Merchant can upgrade via /app/billing page (Shopify Billing API)
3. orders/create webhook → increment ShopUsage for current month
4. On each request: check if shop is over limit
5. If over limit: disable cart drawer features (do NOT block checkout)
6. Show banner in admin: "You've reached your plan limit"
```

**Acceptance criteria:**
- [ ] `/app/billing` shows current plan, usage, and upgrade options
- [ ] Plan selection creates Shopify recurring charge via Billing API
- [ ] `orders/create` webhook increments `ShopUsage.orderCount`
- [ ] New month auto-resets counter (new row per month)
- [ ] Over-limit shops see degraded features, never blocked checkout
- [ ] Billing page shows usage bar (current orders / plan limit)

### FEAT-06: Analytics Dashboard

**Description:** Track cart drawer interactions and display aggregated metrics in admin.

**Route:** `/app/analytics`

**Events tracked (via storefront JS → app proxy or direct endpoint):**
| Event           | Metadata                    |
|----------------|----------------------------|
| `drawer_open`   | `{}`                        |
| `upsell_click`  | `{ productId }`             |
| `upsell_add`    | `{ productId, variantId }`  |
| `checkout_click` | `{ cartTotal, itemCount }` |

**Dashboard metrics:**
- Drawer opens (daily/weekly/monthly)
- Upsell click-through rate
- Upsell add-to-cart rate
- Revenue attributed to upsells (estimated)

**Acceptance criteria:**
- [ ] Events are recorded from storefront with shop identifier
- [ ] Dashboard shows time-filtered metrics (7d / 30d / 90d)
- [ ] Charts render via Polaris DataTable or simple bar/line visualizations
- [ ] No PII stored in analytics events
- [ ] Endpoint is rate-limited to prevent abuse

---

## 5. API Specifications

### 5.1 Admin Routes

| Route                      | Method  | Purpose                                | Auth             |
|---------------------------|---------|----------------------------------------|------------------|
| `/app`                     | GET     | App layout shell with nav              | `authenticate.admin` |
| `/app/editor`              | GET     | Load editor with draft config          | `authenticate.admin` |
| `/app/editor`              | POST    | Save/publish/discard config            | `authenticate.admin` |
| `/app/billing`             | GET     | Show billing page                      | `authenticate.admin` |
| `/app/billing`             | POST    | Create/change subscription             | `authenticate.admin` |
| `/app/analytics`           | GET     | Show analytics dashboard               | `authenticate.admin` |
| `/webhooks/orders-create`  | POST    | Handle orders/create webhook           | webhook HMAC      |

### 5.2 Storefront Endpoints (App Proxy)

| Route               | Method | Purpose                     | Auth          |
|---------------------|--------|-----------------------------|---------------|
| `/apps/supercartd/events` | POST   | Record analytics events     | App proxy sig |

### 5.3 Metafield Mutations

**Write (on Publish):**
```graphql
mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key }
    userErrors { field message }
  }
}
```

Variables:
```json
{
  "metafields": [
    {
      "namespace": "supercartd",
      "key": "config",
      "ownerId": "gid://shopify/Shop/SHOP_ID",
      "type": "json",
      "value": "{...CartDrawerConfigJSON...}"
    },
    {
      "namespace": "supercartd",
      "key": "rules",
      "ownerId": "gid://shopify/Shop/SHOP_ID",
      "type": "json",
      "value": "{...rules subset...}"
    }
  ]
}
```

---

## 6. Shopify Functions Specifications

### 6.1 Delivery Discount Function

**Handle:** `supercartd` (existing extension)
**Target:** `cart.delivery-options.discounts.generate.run`
**Language:** Rust

**Current state:** Hardcoded 100% delivery discount. Needs refactoring to read metafield.

**Required changes:**
1. Update GraphQL input query to include `discountNode.metafield`
2. Parse `supercartd.rules` JSON from metafield
3. Implement conditional logic based on `free_shipping.condition`
4. Return empty operations when condition not met or disabled

### 6.2 Product Discount Function

**Handle:** `supercartd` (existing extension, same function)
**Target:** `cart.lines.discounts.generate.run`
**Language:** Rust

**Current state:** Hardcoded 10% order / 20% product discount on max-cost line. Needs full rewrite.

**Required changes:**
1. Update GraphQL input query to include `discountNode.metafield` and `merchandise` details
2. Parse `supercartd.rules` JSON from metafield
3. Match upsell products in cart by product/variant ID
4. Apply configured discount (percentage or fixed) only to matched upsell lines
5. Return empty operations when no upsells match

---

## 7. Theme App Extension Specification

**Handle:** `supercartdrawer`
**Type:** `theme`

**Current state:** Contains only a star_rating block (template default). Needs replacement.

**Required structure:**
```
extensions/supercartdrawer/
├── shopify.extension.toml
├── assets/
│   ├── supercartd.js          # Cart drawer logic
│   └── supercartd.css         # Cart drawer styles (scoped)
├── blocks/
│   └── cart-drawer.liquid      # App block for theme editor
├── snippets/
│   └── supercartd-init.liquid  # Config injection snippet
└── locales/
    └── en.default.json
```

**Liquid (cart-drawer.liquid):**
```liquid
<script>
  window.__SUPERCARTD_CONFIG__ = {{ shop.metafields.supercartd.config | json }};
</script>
{{ 'supercartd.css' | asset_url | stylesheet_tag }}
<script src="{{ 'supercartd.js' | asset_url }}" defer></script>
```

**JS requirements:**
- Zero external dependencies (vanilla JS)
- < 30KB gzipped total (JS + CSS)
- All styles scoped via `#supercartd-drawer` prefix or inline
- No global variable pollution (IIFE or module)

---

## 8. Scopes and Permissions

**Required Shopify scopes:**
```
read_products           # product data for upsells + ResourcePicker (App Bridge v4)
write_discounts         # Shopify Functions discount creation
read_orders             # order count for billing
```

**App proxy:**
```toml
[app_proxy]
url = "https://{app-url}/apps/supercartd"
subpath = "supercartd"
prefix = "apps"
```

---

## 9. Implementation Phases

### Phase 1 — MVP (target: functional end-to-end)

| Step | Task                                           | Depends On |
|------|------------------------------------------------|------------|
| 1.1  | Migrate Prisma schema to PostgreSQL + add models | —         |
| 1.2  | Build editor route with save/publish flow       | 1.1        |
| 1.3  | Build Theme Extension (Liquid + JS cart drawer) | —          |
| 1.4  | Refactor delivery discount function (metafield) | 1.2        |
| 1.5  | Refactor product discount function (metafield)  | 1.2        |
| 1.6  | Wire editor preview iframe                      | 1.2, 1.3   |
| 1.7  | Billing page + orders/create webhook            | 1.1        |
| 1.8  | End-to-end testing on dev store                 | all        |

### Phase 2 — Polish

| Step | Task                                           |
|------|------------------------------------------------|
| 2.1  | Multiple upsells with product exclusion logic  |
| 2.2  | Multiple reward rules                         |
| 2.3  | Analytics dashboard                            |
| 2.4  | Mobile-optimized drawer                        |

### Phase 3 — Growth

| Step | Task                                           |
|------|------------------------------------------------|
| 3.1  | AI product suggestions for upsells            |
| 3.2  | A/B testing framework                          |
| 3.3  | Automation rules (if X then suggest Y)         |

---

## 10. Constraints and Rules

1. **Never block checkout** — if billing limit reached, disable app features but never prevent a customer from completing purchase.
2. **Theme-independent** — cart drawer JS must not depend on any theme's CSS or DOM structure.
3. **Single source of truth** — metafields are the shared config between storefront JS and Shopify Functions. Both read the same published data.
4. **Config sync** — on every Publish, both `supercartd.config` and `supercartd.rules` metafields must be written atomically in the same `metafieldsSet` mutation.
5. **No PII in analytics** — only track aggregate events, never customer-identifiable data.
6. **Storefront performance** — JS bundle < 30KB gzipped, no layout shift on inject.
7. **Graceful degradation** — if metafield is missing/malformed, Functions return empty operations and JS renders a minimal cart.
