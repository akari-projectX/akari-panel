// Generated protobuf bindings for the panel<->agent contract.
// W23: the explicit-presence (optional) metric fields make Heartbeat the
// largest AgentUp variant (~460 bytes); a message is moved a few times per
// heartbeat, boxing generated code is not worth the churn.
#![allow(clippy::large_enum_variant)]
tonic::include_proto!("akari.v1");
