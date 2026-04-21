//! Wire protocol for the AccessBridge Desktop Agent.
//!
//! Frames are JSON with a `type` discriminator (SCREAMING_SNAKE_CASE)
//! and camelCase field names. The TypeScript extension side is the
//! mirror of this module at `packages/core/src/ipc/types.ts`.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub version: String,
    pub platform: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTargetHint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeElementInfo {
    pub process_name: String,
    pub window_title: String,
    pub class_name: String,
    pub automation_id: String,
    pub control_type: String,
    pub bounding_rect: Rect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adaptation {
    pub id: String,
    pub kind: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentMessage {
    #[serde(rename = "HELLO", rename_all = "camelCase")]
    Hello {
        agent: AgentInfo,
        psk_hash: String,
        nonce: String,
    },
    #[serde(rename = "HELLO_ACK", rename_all = "camelCase")]
    HelloAck { psk_ok: bool, server: AgentInfo },
    #[serde(rename = "PROFILE_GET", rename_all = "camelCase")]
    ProfileGet { request_id: String },
    #[serde(rename = "PROFILE_SET", rename_all = "camelCase")]
    ProfileSet {
        request_id: String,
        profile: serde_json::Value,
    },
    #[serde(rename = "PROFILE_RESULT", rename_all = "camelCase")]
    ProfileResult {
        request_id: String,
        profile: serde_json::Value,
    },
    #[serde(rename = "PROFILE_UPDATED", rename_all = "camelCase")]
    ProfileUpdated { profile: serde_json::Value },
    #[serde(rename = "ADAPTATION_APPLY", rename_all = "camelCase")]
    AdaptationApply {
        request_id: String,
        target: NativeTargetHint,
        adaptation: Adaptation,
    },
    #[serde(rename = "ADAPTATION_APPLY_RESULT", rename_all = "camelCase")]
    AdaptationApplyResult {
        request_id: String,
        adaptation_id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "ADAPTATION_REVERT", rename_all = "camelCase")]
    AdaptationRevert {
        request_id: String,
        adaptation_id: String,
    },
    #[serde(rename = "ADAPTATION_REVERT_RESULT", rename_all = "camelCase")]
    AdaptationRevertResult { request_id: String, ok: bool },
    #[serde(rename = "UIA_INSPECT", rename_all = "camelCase")]
    UiaInspect {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<NativeTargetHint>,
    },
    #[serde(rename = "UIA_ELEMENTS", rename_all = "camelCase")]
    UiaElements {
        request_id: String,
        elements: Vec<NativeElementInfo>,
    },
    #[serde(rename = "PING", rename_all = "camelCase")]
    Ping { request_id: String },
    #[serde(rename = "PONG", rename_all = "camelCase")]
    Pong { request_id: String },
    #[serde(rename = "ERROR", rename_all = "camelCase")]
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        code: String,
        message: String,
    },
}

#[derive(Debug, Error)]
pub enum IpcError {
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("invalid message: {0}")]
    InvalidMessage(String),
    #[error("handshake failed: {0}")]
    HandshakeFailed(String),
}

pub fn parse_message(raw: &str) -> Result<AgentMessage, IpcError> {
    serde_json::from_str(raw).map_err(IpcError::from)
}

pub fn encode_message(msg: &AgentMessage) -> Result<String, IpcError> {
    serde_json::to_string(msg).map_err(IpcError::from)
}

pub fn new_request_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_agent() -> AgentInfo {
        AgentInfo {
            version: "0.1.0".to_string(),
            platform: "windows".to_string(),
            capabilities: vec!["uia".to_string(), "font-scale".to_string()],
        }
    }

    fn sample_hint() -> NativeTargetHint {
        NativeTargetHint {
            process_name: Some("notepad.exe".to_string()),
            window_title: Some("Untitled - Notepad".to_string()),
            class_name: Some("Notepad".to_string()),
            element_name: None,
            automation_id: None,
        }
    }

    fn sample_element() -> NativeElementInfo {
        NativeElementInfo {
            process_name: "notepad.exe".to_string(),
            window_title: "Untitled - Notepad".to_string(),
            class_name: "Edit".to_string(),
            automation_id: "15".to_string(),
            control_type: "Document".to_string(),
            bounding_rect: Rect { x: 0, y: 0, width: 800, height: 600 },
        }
    }

    fn round_trip(msg: AgentMessage) -> AgentMessage {
        let s = encode_message(&msg).expect("encode");
        parse_message(&s).expect("parse")
    }

    #[test]
    fn hello_round_trip() {
        let msg = AgentMessage::Hello {
            agent: sample_agent(),
            psk_hash: "a".repeat(64),
            nonce: "n".repeat(24),
        };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn hello_ack_round_trip_psk_ok_false() {
        let msg = AgentMessage::HelloAck { psk_ok: false, server: sample_agent() };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn profile_get_round_trip() {
        let msg = AgentMessage::ProfileGet { request_id: "r1".to_string() };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn profile_set_round_trip() {
        let msg = AgentMessage::ProfileSet {
            request_id: "r2".to_string(),
            profile: json!({"sensory": {"fontScale": 1.25}}),
        };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn profile_result_round_trip() {
        let msg = AgentMessage::ProfileResult {
            request_id: "r3".to_string(),
            profile: json!({"a": 1, "b": [1, 2, 3], "c": null}),
        };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn profile_updated_round_trip() {
        let msg = AgentMessage::ProfileUpdated {
            profile: json!({"language": "hi"}),
        };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn adaptation_apply_round_trip() {
        let msg = AgentMessage::AdaptationApply {
            request_id: "r4".to_string(),
            target: sample_hint(),
            adaptation: Adaptation {
                id: "a1".to_string(),
                kind: "font-scale".to_string(),
                value: json!(1.2),
            },
        };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn adaptation_apply_result_round_trip_with_reason() {
        let msg = AgentMessage::AdaptationApplyResult {
            request_id: "r5".to_string(),
            adaptation_id: "a1".to_string(),
            ok: false,
            reason: Some("unsupported-target".to_string()),
        };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn adaptation_revert_round_trip() {
        let msg = AgentMessage::AdaptationRevert {
            request_id: "r6".to_string(),
            adaptation_id: "a1".to_string(),
        };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn adaptation_revert_result_round_trip() {
        let msg = AgentMessage::AdaptationRevertResult {
            request_id: "r7".to_string(),
            ok: true,
        };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn uia_inspect_none_target_round_trip() {
        let msg = AgentMessage::UiaInspect { request_id: "r8".to_string(), target: None };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn uia_elements_round_trip() {
        let msg = AgentMessage::UiaElements {
            request_id: "r9".to_string(),
            elements: vec![sample_element(), sample_element()],
        };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn ping_pong_round_trip() {
        let p = AgentMessage::Ping { request_id: "rp".to_string() };
        let q = AgentMessage::Pong { request_id: "rp".to_string() };
        assert_eq!(round_trip(p.clone()), p);
        assert_eq!(round_trip(q.clone()), q);
    }

    #[test]
    fn error_round_trip_with_none_request_id() {
        let msg = AgentMessage::Error {
            request_id: None,
            code: "PSK_MISMATCH".to_string(),
            message: "psk verification failed".to_string(),
        };
        assert_eq!(round_trip(msg.clone()), msg);
    }

    #[test]
    fn camel_case_wire_field_names() {
        let msg = AgentMessage::UiaInspect {
            request_id: "r".to_string(),
            target: Some(NativeTargetHint {
                process_name: Some("notepad.exe".to_string()),
                window_title: None,
                class_name: None,
                element_name: None,
                automation_id: None,
            }),
        };
        let s = encode_message(&msg).unwrap();
        assert!(s.contains("\"processName\":\"notepad.exe\""), "got: {s}");
        assert!(s.contains("\"requestId\":\"r\""), "got: {s}");
        assert!(!s.contains("process_name"), "snake_case leaked: {s}");
    }

    #[test]
    fn encoded_type_field_matches_variant() {
        let cases: &[(AgentMessage, &str)] = &[
            (AgentMessage::Ping { request_id: "x".into() }, "\"type\":\"PING\""),
            (AgentMessage::Pong { request_id: "x".into() }, "\"type\":\"PONG\""),
            (AgentMessage::ProfileGet { request_id: "x".into() }, "\"type\":\"PROFILE_GET\""),
        ];
        for (msg, frag) in cases {
            let s = encode_message(msg).unwrap();
            assert!(s.contains(frag), "missing {frag} in {s}");
        }
    }

    #[test]
    fn native_target_hint_all_none_serializes_to_empty_object() {
        let hint = NativeTargetHint::default();
        let s = serde_json::to_string(&hint).unwrap();
        assert_eq!(s, "{}");
    }

    #[test]
    fn adaptation_value_holds_arbitrary_json() {
        for value in [json!(42), json!("s"), json!([1, 2, 3]), json!({"k": 1}), json!(null)] {
            let msg = AgentMessage::AdaptationApply {
                request_id: "r".into(),
                target: NativeTargetHint::default(),
                adaptation: Adaptation { id: "a".into(), kind: "k".into(), value: value.clone() },
            };
            assert_eq!(round_trip(msg.clone()), msg);
        }
    }

    #[test]
    fn unknown_type_returns_error() {
        let raw = r#"{"type":"BOGUS","requestId":"r"}"#;
        let err = parse_message(raw).unwrap_err();
        assert!(matches!(err, IpcError::Serialization(_)));
    }

    #[test]
    fn missing_required_field_returns_error() {
        let raw = r#"{"type":"PROFILE_SET","requestId":"r"}"#;
        let err = parse_message(raw).unwrap_err();
        assert!(matches!(err, IpcError::Serialization(_)));
    }

    #[test]
    fn malformed_json_returns_error() {
        let raw = r#"{"type":"PING","#;
        let err = parse_message(raw).unwrap_err();
        assert!(matches!(err, IpcError::Serialization(_)));
    }

    #[test]
    fn rect_field_ordering_preserved() {
        let rect = Rect { x: 1, y: 2, width: 3, height: 4 };
        let s = serde_json::to_string(&rect).unwrap();
        let parsed: Rect = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed, rect);
    }

    #[test]
    fn capabilities_serializes_as_json_array() {
        let agent = AgentInfo {
            version: "v".into(),
            platform: "p".into(),
            capabilities: vec!["a".into(), "b".into()],
        };
        let s = serde_json::to_string(&agent).unwrap();
        assert!(s.contains("\"capabilities\":[\"a\",\"b\"]"), "got: {s}");
    }

    #[test]
    fn new_request_id_returns_distinct_values() {
        let a = new_request_id();
        let b = new_request_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
    }
}
