# Entitlement Seat Stateful Rubric

- Uses only the in-memory entitlement adapter for lookup and marks the adapter kind.
- Carries entitlement_lookup state into seat_delta_policy before deciding approval.
- Carries policy approval and reason into audit_decision without recomputing entitlement details.
