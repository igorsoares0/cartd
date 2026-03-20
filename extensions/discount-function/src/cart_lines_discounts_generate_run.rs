use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

use schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise;

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let empty = schema::CartLinesDiscountsGenerateRunResult { operations: vec![] };

    // Read metafield
    let metafield_value = match input.discount().metafield() {
        Some(m) => m.value().to_string(),
        None => return Ok(empty),
    };

    // Parse rules JSON
    let rules: serde_json::Value = match serde_json::from_str(&metafield_value) {
        Ok(v) => v,
        Err(_) => return Ok(empty),
    };

    // Get upsells array
    let upsells = match rules["upsells"].as_array() {
        Some(arr) => arr,
        None => return Ok(empty),
    };

    let mut candidates: Vec<schema::ProductDiscountCandidate> = vec![];

    for upsell in upsells {
        let offer_type = upsell["offer"]["type"].as_str().unwrap_or("none");
        let offer_value = upsell["offer"]["value"].as_f64().unwrap_or(0.0);

        if offer_type == "none" || offer_value <= 0.0 {
            continue;
        }

        let upsell_product_id = upsell["productId"].as_str().unwrap_or("");
        let upsell_variant_id = upsell["variantId"].as_str().unwrap_or("");

        // Find matching cart line
        for line in input.cart().lines().iter() {
            let merchandise = line.merchandise();
            let (variant_id, product_id) = match merchandise {
                Merchandise::ProductVariant(v) => {
                    (v.id().to_string(), v.product().id().to_string())
                }
                _ => continue,
            };

            if product_id != upsell_product_id && variant_id != upsell_variant_id {
                continue;
            }

            let (value, message) = match offer_type {
                "percentage" => (
                    schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                        value: Decimal(offer_value),
                    }),
                    format!("{:.0}% OFF", offer_value),
                ),
                "fixed" => (
                    schema::ProductDiscountCandidateValue::FixedAmount(schema::ProductDiscountCandidateFixedAmount {
                        amount: Decimal(offer_value),
                        applies_to_each_item: Some(false),
                    }),
                    format!("${:.2} OFF", offer_value),
                ),
                _ => continue,
            };

            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: None,
                    },
                )],
                message: Some(message),
                value,
                associated_discount_code: None,
            });

            break; // Only discount once per upsell rule
        }
    }

    if candidates.is_empty() {
        return Ok(empty);
    }

    Ok(schema::CartLinesDiscountsGenerateRunResult {
        operations: vec![schema::CartOperation::ProductDiscountsAdd(
            schema::ProductDiscountsAddOperation {
                selection_strategy: schema::ProductDiscountSelectionStrategy::First,
                candidates,
            },
        )],
    })
}
