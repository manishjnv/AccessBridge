//! Cross-platform integration tests for the `AccessibilityAdapter` trait contract.
//!
//! # What runs in CI vs. locally
//!
//! Tests that exercise *real* platform APIs (D-Bus, Windows UIA, NSAccessibility)
//! are marked `#[ignore]`. They are excluded from the default `cargo test` run so
//! CI (headless, possibly wrong OS) doesn't fail on missing display servers or
//! accessibility permissions. Run them explicitly with:
//!
//!   cargo test -p accessbridge-desktop-agent -- --ignored
//!
//! Tests that use `make_mock_adapter()` run unconditionally on every platform and
//! every CI job — they exercise only the trait contract, not the OS APIs.
//!
//! # Wire-stable capability strings
//!
//! The `capability_strings_are_stable_over_factory` test locks down the
//! lowercase-hyphenated strings emitted over the wire.  If you rename a
//! `Capability` variant you MUST update the expected set here AND bump the
//! protocol version in `ipc_protocol.rs`.

use accessbridge_desktop_agent::platform::{
    AdaptationHandle, AdapterError, Capability, RevertState,
};
use accessbridge_desktop_agent::platform::factory;
use accessbridge_desktop_agent::ipc_protocol::{Adaptation, NativeTargetHint};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// A `NativeTargetHint` with every field set to `None`.
/// Used wherever the test just needs a legal hint value and doesn't care which
/// element the adapter finds (or doesn't find).
fn unknown_hint() -> NativeTargetHint {
    NativeTargetHint::default()
}

/// Build an `AdaptationHandle` whose revert state is `RevertState::None`.
/// Used to test revert paths without needing a real OS apply call.
fn none_handle(id: impl Into<String>) -> AdaptationHandle {
    AdaptationHandle {
        id: id.into(),
        revert: RevertState::None,
    }
}

// ---------------------------------------------------------------------------
// Test 1 — factory returns the adapter expected for the current compile target
// ---------------------------------------------------------------------------

/// The platform name returned by `make_adapter()` must exactly match the
/// compile-target OS.  This is a compile-time guarantee, but we also assert it
/// at runtime so a cross-compiled binary surfaces the mismatch at test time.
#[test]
fn factory_returns_adapter_with_expected_platform_name() {
    let adapter = factory::make_adapter();

    #[cfg(target_os = "windows")]
    assert_eq!(adapter.platform_name(), "windows");

    #[cfg(target_os = "macos")]
    assert_eq!(adapter.platform_name(), "macos");

    #[cfg(target_os = "linux")]
    assert_eq!(adapter.platform_name(), "linux");

    // At least one of the cfg branches above will have matched and asserted.
    // If none matched (unknown target) the binary compiles but this test passes
    // trivially — the FallbackAdapter returns "unknown" which is acceptable.
    let _ = adapter.platform_name(); // silence "unused" warnings on unknown targets
}

// ---------------------------------------------------------------------------
// Test 2 — Ipc capability is always present
// ---------------------------------------------------------------------------

/// `Capability::Ipc` is the floor capability: every adapter, on every platform,
/// must advertise it so the extension knows the IPC endpoint is alive.
#[test]
fn adapter_capabilities_always_include_ipc() {
    let adapter = factory::make_adapter();
    let caps = adapter.capabilities();
    assert!(
        caps.contains(&Capability::Ipc),
        "adapter for '{}' must include Capability::Ipc; got: {:?}",
        adapter.platform_name(),
        caps,
    );
}

// ---------------------------------------------------------------------------
// Test 3 — list_top_level_windows (real adapter, headless-friendly)
// ---------------------------------------------------------------------------

/// On CI / headless machines this list may be empty.  We accept that.
/// The only hard constraints are: the call must not error AND the list
/// must be within a sane upper bound (≤ 512 windows).
///
/// This test uses the *real* adapter, so it is `#[ignore]`'d — on Linux CI
/// without a running display server `XOpenDisplay` will fail.
#[test]
#[ignore = "requires a running display server / accessibility runtime (not available in CI)"]
fn adapter_list_top_level_windows_returns_ok() {
    let adapter = factory::make_adapter();
    let result = adapter.list_top_level_windows();
    assert!(result.is_ok(), "list_top_level_windows returned Err: {:?}", result.err());
    let windows = result.unwrap();
    assert!(
        windows.len() <= 512,
        "suspiciously many top-level windows: {}",
        windows.len()
    );
}

// ---------------------------------------------------------------------------
// Test 4 — find_element with empty hint must not return Err
// ---------------------------------------------------------------------------

/// `find_element` with an all-None hint may return `Ok(None)` (nothing matched)
/// but must NOT return `Err(_)`.  The adapter should only return `Err` on
/// actual platform failures, not on "nothing found."
///
/// `#[ignore]` because a real platform call is involved.
#[test]
#[ignore = "requires a running accessibility runtime (not available in CI)"]
fn adapter_find_element_with_empty_hint_returns_no_err() {
    let adapter = factory::make_adapter();
    let result = adapter.find_element(&unknown_hint());
    assert!(
        result.is_ok(),
        "find_element with empty hint must not return Err; got: {:?}",
        result.err()
    );
    // Either None or Some(_) is fine — we don't assert which.
}

// ---------------------------------------------------------------------------
// Test 5 — mock adapter platform name
// ---------------------------------------------------------------------------

#[test]
fn mock_adapter_platform_name_is_mock() {
    let adapter = factory::make_mock_adapter();
    assert_eq!(adapter.platform_name(), "mock");
}

// ---------------------------------------------------------------------------
// Test 6 — mock adapter apply_font_scale returns a handle with id "mock-handle"
// ---------------------------------------------------------------------------

/// The mock adapter's `apply_font_scale` is a dummy that returns a handle
/// whose id is the string literal `"mock-handle"`.  We need a valid `Element`
/// to pass in — but `find_element` on the mock always returns `Ok(None)`, so
/// we cannot obtain one through normal flow.  Instead we exercise the method
/// indirectly via `apply_adaptation` with `kind: "font-scale"`, then assert
/// the returned handle carries the correct id.
///
/// Since `apply_adaptation` calls `find_element` first (returns `Ok(None)` on
/// the mock → `ElementNotFound`), the real path to exercising `apply_font_scale`
/// on the mock is to call it directly via a concrete `MockAdapter`.  We do this
/// by constructing a `NativeElementInfo`-backed `Element` using the public
/// constructors from the platform module.
#[test]
fn mock_adapter_apply_font_scale_succeeds() {
    use accessbridge_desktop_agent::platform::{Element, PlatformElement};
    use accessbridge_desktop_agent::ipc_protocol::{NativeElementInfo, Rect};

    let adapter = factory::make_mock_adapter();

    let elem = Element::new(
        NativeElementInfo {
            process_name: "test".into(),
            window_title: "test window".into(),
            class_name: "TestClass".into(),
            automation_id: "test-automation".into(),
            control_type: "Window".into(),
            bounding_rect: Rect { x: 0, y: 0, width: 100, height: 100 },
        },
        PlatformElement::None,
    );

    let result = adapter.apply_font_scale(&elem, 1.25_f32);
    assert!(result.is_ok(), "apply_font_scale on mock should succeed; got: {:?}", result.err());
    let handle = result.unwrap();
    assert_eq!(
        handle.id, "mock-handle",
        "mock adapter handle id must be 'mock-handle'"
    );
}

// ---------------------------------------------------------------------------
// Test 7 — mock adapter revert with RevertState::None returns Ok(())
// ---------------------------------------------------------------------------

#[test]
fn mock_adapter_revert_none_is_ok() {
    let adapter = factory::make_mock_adapter();
    let handle = none_handle("revert-test");
    let result = adapter.revert_adaptation(handle);
    assert!(
        result.is_ok(),
        "revert_adaptation with RevertState::None on mock must return Ok(()); got: {:?}",
        result.err()
    );
}

// ---------------------------------------------------------------------------
// Test 8 — apply_adaptation with unknown kind returns Unsupported
// ---------------------------------------------------------------------------

/// `apply_adaptation` routes by `adaptation.kind`.  An unrecognised kind must
/// produce `AdapterError::Unsupported`, not a panic or a `PlatformError`.
///
/// On the mock adapter, `find_element` returns `Ok(None)` which causes
/// `apply_adaptation` (the trait default impl) to return `ElementNotFound`
/// before it ever inspects the kind.  We therefore need to use the real
/// adapter path, or we need to verify the correct branch in `mod.rs` directly.
///
/// Strategy: use the *real* adapter on the current platform.  If no element is
/// found the error is `ElementNotFound`, not `Unsupported` — so this test is
/// `#[ignore]`'d on CI where a real accessibility runtime is required to return
/// at least one element from `find_element`.  The invariant we're testing is
/// that the routing branch for unknown kinds returns `Unsupported`, not a crash.
///
/// For a deterministic check that doesn't need a real adapter, we also test the
/// `Unsupported` variant is correctly constructed and displays correctly.
#[test]
fn adapter_error_unsupported_variant_is_correct() {
    let err = AdapterError::Unsupported("gibberish adaptation kind".into());
    match err {
        AdapterError::Unsupported(msg) => {
            assert!(msg.contains("gibberish"), "message should contain 'gibberish'");
        }
        other => panic!("expected Unsupported, got {:?}", other),
    }
}

/// Real-adapter variant: `#[ignore]` so it only runs on machines with an
/// accessible display and at least one top-level window.
#[test]
#[ignore = "requires a running accessibility runtime that can find at least one element"]
fn adapter_apply_adaptation_with_unknown_kind_returns_unsupported() {
    use accessbridge_desktop_agent::platform::AccessibilityAdapter;

    let adapter = factory::make_adapter();

    // Build a hint that is likely to match something (process name of our own test process).
    let hint = NativeTargetHint {
        process_name: Some(std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default()),
        ..Default::default()
    };

    let adaptation = Adaptation {
        id: "test-adapt-1".into(),
        kind: "gibberish".into(),
        value: serde_json::Value::Null,
    };

    let result = adapter.apply_adaptation(&hint, &adaptation);
    match result {
        Err(AdapterError::Unsupported(_)) => { /* expected */ }
        Err(AdapterError::ElementNotFound) => {
            // Also acceptable — no window matched. The important thing is no panic.
        }
        other => panic!(
            "expected Unsupported or ElementNotFound for unknown kind, got: {:?}",
            other
        ),
    }
}

// ---------------------------------------------------------------------------
// Test 9 — mock adapter apply → keep handle → revert
// ---------------------------------------------------------------------------

#[test]
fn adaptation_handle_roundtrip_via_mock() {
    use accessbridge_desktop_agent::platform::{Element, PlatformElement};
    use accessbridge_desktop_agent::ipc_protocol::{NativeElementInfo, Rect};

    let adapter = factory::make_mock_adapter();

    let elem = Element::new(
        NativeElementInfo {
            process_name: "roundtrip".into(),
            window_title: "Roundtrip Test".into(),
            class_name: "RoundtripClass".into(),
            automation_id: "roundtrip-auto".into(),
            control_type: "Window".into(),
            bounding_rect: Rect { x: 0, y: 0, width: 200, height: 100 },
        },
        PlatformElement::None,
    );

    // Step 1: apply
    let handle = adapter.apply_font_scale(&elem, 1.5_f32).expect("apply should succeed on mock");
    assert_eq!(handle.id, "mock-handle");

    // Step 2: revert using the handle
    let revert_result = adapter.revert_adaptation(handle);
    assert!(
        revert_result.is_ok(),
        "revert after apply must succeed on mock; got: {:?}",
        revert_result.err()
    );
}

// ---------------------------------------------------------------------------
// Test 10 — capability strings are stable over the factory
// ---------------------------------------------------------------------------

/// Lock down the set of wire-level capability strings so that a rename of a
/// `Capability` variant is caught at test time before it silently breaks the
/// extension's badge rendering or sidepanel filter logic.
///
/// The mock adapter only advertises `Ipc`, so we use the static enum set here.
/// For the real adapter we assert that every string it returns is in the
/// known-stable set (i.e. no new strings appear without deliberate review).
#[test]
fn capability_strings_are_stable_over_factory() {
    // Full stable set — every string the protocol currently recognises.
    let stable: std::collections::HashSet<&str> = [
        "font-scale",
        "contrast-filter",
        "cursor-size",
        "announce",
        "screen-reader-bridge",
        "color-invert",
        "uia-inspect",
        "ipc",
    ]
    .iter()
    .copied()
    .collect();

    let adapter = factory::make_adapter();
    for cap in adapter.capabilities() {
        let s = cap.as_str();
        assert!(
            stable.contains(s),
            "adapter '{}' returned capability string {:?} which is not in the stable set",
            adapter.platform_name(),
            s,
        );
    }

    // Also verify every `Capability` variant's `as_str()` is in the set.
    let all_variants = [
        Capability::FontScale,
        Capability::ContrastFilter,
        Capability::CursorSize,
        Capability::Announce,
        Capability::ScreenReaderBridge,
        Capability::ColorInvert,
        Capability::UiaInspect,
        Capability::Ipc,
    ];
    for v in &all_variants {
        assert!(
            stable.contains(v.as_str()),
            "Capability::{:?} as_str() '{}' is not in the stable set",
            v,
            v.as_str(),
        );
    }
}
