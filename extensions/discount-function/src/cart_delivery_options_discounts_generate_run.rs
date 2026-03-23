use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

#[shopify_function]
fn cart_delivery_options_discounts_generate_run(
    input: schema::cart_delivery_options_discounts_generate_run::Input,
) -> Result<schema::CartDeliveryOptionsDiscountsGenerateRunResult> {
    let empty = schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] };

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

    // Get free_shipping rules array
    let free_shipping_rules = match rules["free_shipping"].as_array() {
        Some(arr) => arr,
        None => return Ok(empty),
    };

    // Check if any free_shipping rule's condition is met
    let mut condition_met = false;
    for rule in free_shipping_rules {
        if rule["enabled"].as_bool() != Some(true) {
            continue;
        }

        let condition_type = rule["condition"]["type"].as_str().unwrap_or("price");
        let condition_value = rule["condition"]["value"].as_f64().unwrap_or(0.0);

        if condition_value <= 0.0 {
            continue;
        }

        let current: f64 = match condition_type {
            "quantity" => {
                let mut sum = 0i32;
                for line in input.cart().lines().iter() {
                    sum += line.quantity();
                }
                sum as f64
            }
            _ => {
                let mut sum = 0.0f64;
                for line in input.cart().lines().iter() {
                    sum += line.cost().subtotal_amount().amount().as_f64();
                }
                sum
            }
        };

        if current >= condition_value {
            condition_met = true;
            break;
        }
    }

    if !condition_met {
        return Ok(empty);
    }

    // Apply 100% delivery discount to all delivery groups
    let mut candidates: Vec<schema::DeliveryDiscountCandidate> = vec![];
    for group in input.cart().delivery_groups().iter() {
        candidates.push(schema::DeliveryDiscountCandidate {
            targets: vec![schema::DeliveryDiscountCandidateTarget::DeliveryGroup(
                schema::DeliveryGroupTarget {
                    id: group.id().clone(),
                },
            )],
            value: schema::DeliveryDiscountCandidateValue::Percentage(schema::Percentage {
                value: Decimal(100.0),
            }),
            message: Some("FREE SHIPPING".to_string()),
            associated_discount_code: None,
        });
    }

    if candidates.is_empty() {
        return Ok(empty);
    }

    Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult {
        operations: vec![schema::DeliveryOperation::DeliveryDiscountsAdd(
            schema::DeliveryDiscountsAddOperation {
                selection_strategy: schema::DeliveryDiscountSelectionStrategy::All,
                candidates,
            },
        )],
    })
}
