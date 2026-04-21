//! macOS NSAccessibility adapter — Session 21 Part 1b.
//!
//! Wraps the Accessibility framework's `AXUIElementRef` type and provides a
//! full `AccessibilityAdapter` implementation backed by NSWorkspace process
//! enumeration and per-element `AXFontSize` scaling.
//!
//! # Design notes
//!
//! - All AX FFI calls are raw `extern "C"` declarations against the
//!   `ApplicationServices` framework (which re-exports Accessibility).
//! - `AxElementRef` owns one `CFRetain` ref; `Clone` increments the retain
//!   count atomically; `Drop` releases it.
//! - NSWorkspace + NSRunningApplication enumeration uses `objc2` / `objc2-app-kit`.
//!   We call instance methods via the safe wrapper API that objc2 0.5 provides
//!   (`NSWorkspace::sharedWorkspace()`, `.runningApplications()`, etc.) rather
//!   than raw `msg_send!` to keep the call-site noise low.
//! - AXValue for CGPoint / CGSize extraction is done via `AXValueCopyValue`
//!   from ApplicationServices. If the attribute is absent we fall back to a
//!   zero `Rect`.
//! - `check_trusted()` uses a `null` options dict so it never triggers the
//!   OS permission prompt. Permission must be granted by the user in System
//!   Settings → Privacy & Security → Accessibility.

use std::ffi::c_void;

use core_foundation::string::CFString;
use tracing::warn;

use crate::ipc_protocol::{NativeElementInfo, NativeTargetHint, Rect};
use crate::platform::{
    AccessibilityAdapter, AdaptationHandle, AdapterError, AdapterResult, Capability, Element,
    PlatformElement, RevertState,
};

// ---------------------------------------------------------------------------
// AX attribute name constants
// ---------------------------------------------------------------------------

const ATTR_WINDOWS: &str = "AXWindows";
const ATTR_TITLE: &str = "AXTitle";
const ATTR_ROLE: &str = "AXRole";
const ATTR_FONT_SIZE: &str = "AXFontSize";
const ATTR_POSITION: &str = "AXPosition";
const ATTR_SIZE: &str = "AXSize";

// ---------------------------------------------------------------------------
// AX error codes (from AXError.h)
// ---------------------------------------------------------------------------

const AX_SUCCESS: i32 = 0;
const AX_ERR_ATTRIBUTE_UNSUPPORTED: i32 = -25205;
const AX_ERR_CANNOT_COMPLETE: i32 = -25204;
const AX_ERR_NOT_IMPLEMENTED: i32 = -25200;

// ---------------------------------------------------------------------------
// FFI — ApplicationServices / Accessibility framework
// ---------------------------------------------------------------------------

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    /// Create an application-level AXUIElement for the given PID.
    /// Returns a +1 retained CFTypeRef (AXUIElementRef).
    fn AXUIElementCreateApplication(pid: i32) -> *mut c_void;

    /// Copy an attribute value from an AXUIElement.
    /// Returns an AX error code. On success, `*value_out` is a +1 retained
    /// CFTypeRef that the caller must CFRelease.
    fn AXUIElementCopyAttributeValue(
        element: *mut c_void,
        attribute: *const c_void, // CFStringRef
        value_out: *mut *mut c_void, // CFTypeRef *
    ) -> i32;

    /// Set an attribute value on an AXUIElement.
    /// `value` is NOT consumed — caller retains ownership.
    fn AXUIElementSetAttributeValue(
        element: *mut c_void,
        attribute: *const c_void, // CFStringRef
        value: *const c_void,     // CFTypeRef
    ) -> i32;

    /// Returns true if the calling process has been trusted for accessibility.
    /// Pass `NULL` to check without prompting the user.
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;

    /// Copy the count of elements in an AXUIElement attribute array.
    fn AXUIElementGetAttributeValueCount(
        element: *mut c_void,
        attribute: *const c_void,
        count_out: *mut isize,
    ) -> i32;

    /// Copy a range of values from an AXUIElement array attribute.
    /// On success, `values_out` receives a +1 retained CFArrayRef.
    fn AXUIElementCopyAttributeValues(
        element: *mut c_void,
        attribute: *const c_void,
        index: isize,
        max_values: isize,
        values_out: *mut *mut c_void,
    ) -> i32;
}

// ---------------------------------------------------------------------------
// FFI — CoreFoundation
// ---------------------------------------------------------------------------

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    /// Increment the retain count of any CoreFoundation object atomically.
    fn CFRetain(cf: *const c_void) -> *const c_void;

    /// Decrement the retain count; frees the object when it reaches zero.
    fn CFRelease(cf: *const c_void);

    /// Return the runtime type ID of a CoreFoundation object.
    fn CFGetTypeID(cf: *const c_void) -> usize;

    /// Returns the type ID for CFArray.
    fn CFArrayGetTypeID() -> usize;

    /// Returns the number of elements in a CFArray.
    fn CFArrayGetCount(array: *const c_void) -> isize;

    /// Returns the element at `idx` in a CFArray. The reference is NOT +1
    /// (Get rule — caller must retain if keeping it beyond the array lifetime).
    fn CFArrayGetValueAtIndex(array: *const c_void, idx: isize) -> *const c_void;

    /// Returns the type ID for CFString.
    fn CFStringGetTypeID() -> usize;

    /// Returns the type ID for CFNumber.
    fn CFNumberGetTypeID() -> usize;

    /// Extract a `kCFNumberFloat64Type` (8) value from a CFNumber into `value_ptr`.
    fn CFNumberGetValue(
        number: *const c_void,
        the_type: i32,          // CFNumberType; 13 = kCFNumberFloat64Type
        value_ptr: *mut c_void,
    ) -> bool;

    /// Create a new CFNumber from a Float64 value.
    fn CFNumberCreate(
        allocator: *const c_void, // pass NULL for kCFAllocatorDefault
        the_type: i32,
        value_ptr: *const c_void,
    ) -> *mut c_void;

    /// Copy the content of a CFString as a C string in the specified encoding.
    /// Returns NULL if the string cannot be losslessly converted.
    fn CFStringGetCStringPtr(
        the_string: *const c_void,
        encoding: u32, // kCFStringEncodingUTF8 = 0x08000100
    ) -> *const std::os::raw::c_char;

    /// Fallback: copy a CFString into a caller-supplied buffer.
    fn CFStringGetCString(
        the_string: *const c_void,
        buffer: *mut std::os::raw::c_char,
        buffer_size: isize,
        encoding: u32,
    ) -> bool;
}

// AXValue helpers (also in ApplicationServices)
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    /// Returns the CF type ID for AXValue.
    fn AXValueGetTypeID() -> usize;

    /// Extract the underlying value from an AXValue.
    /// `ax_type`: 1 = kAXValueCGPointType, 2 = kAXValueCGSizeType.
    fn AXValueGetValue(ax_value: *const c_void, ax_type: i32, value_ptr: *mut c_void) -> bool;
}

const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const CF_NUMBER_FLOAT64_TYPE: i32 = 13;
const AX_VALUE_CG_POINT_TYPE: i32 = 1;
const AX_VALUE_CG_SIZE_TYPE: i32 = 2;

// ---------------------------------------------------------------------------
// AxElementRef — owned AXUIElementRef wrapper
// ---------------------------------------------------------------------------

/// A reference-counted, owned wrapper around an `AXUIElementRef`.
///
/// An `AXUIElementRef` is a CoreFoundation type (`*mut c_void`). This wrapper
/// upholds the CF memory model: construction requires a +1 retained pointer,
/// `Clone` calls `CFRetain`, and `Drop` calls `CFRelease`.
pub struct AxElementRef {
    ptr: *mut c_void,
}

impl AxElementRef {
    /// Construct an `AxElementRef` that takes ownership of `ptr`.
    ///
    /// # Safety
    /// - `ptr` must be a valid `AXUIElementRef` (may be `null`; null is handled
    ///   gracefully by not calling `CFRelease`).
    /// - The caller must have ensured exactly **one** outstanding `CFRetain`
    ///   reference is transferred here (i.e. came from `AXUIElementCreateApplication`,
    ///   `AXUIElementCopyAttributeValue`, or a prior explicit `CFRetain`).
    pub unsafe fn from_raw_retained(ptr: *mut c_void) -> Self {
        AxElementRef { ptr }
    }

    /// Return the raw `AXUIElementRef` pointer. Does NOT transfer ownership.
    pub fn as_raw(&self) -> *mut c_void {
        self.ptr
    }
}

impl Drop for AxElementRef {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            // SAFETY: We hold exactly one retain count on `self.ptr` (invariant
            // established at construction and maintained by Clone). CFRelease is
            // safe to call on any valid CoreFoundation object from any thread —
            // the retain count is an atomic operation.
            unsafe {
                CFRelease(self.ptr as *const c_void);
            }
        }
    }
}

impl Clone for AxElementRef {
    fn clone(&self) -> Self {
        if self.ptr.is_null() {
            return AxElementRef { ptr: std::ptr::null_mut() };
        }
        // SAFETY: `self.ptr` is a valid CF object (invariant). CFRetain
        // increments the ref-count atomically and returns the same pointer,
        // giving us a new +1 retain we then own.
        unsafe {
            CFRetain(self.ptr as *const c_void);
        }
        AxElementRef { ptr: self.ptr }
    }
}

// SAFETY: AXUIElementRef is documented as thread-safe for access (Apple
// Accessibility framework). CFRetain/CFRelease are atomic operations.
// The IPC server is single-client so concurrent mutation cannot occur.
unsafe impl Send for AxElementRef {}
unsafe impl Sync for AxElementRef {}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/// Build a `CFString` from a Rust `&str`.
fn cfstring_from_str(s: &str) -> CFString {
    CFString::new(s)
}

/// Check whether the calling process has been granted accessibility access.
///
/// Passes a null options dictionary so the call is **silent** — it will NOT
/// trigger the system permission prompt. Returns `false` if access has not
/// been granted, `true` if it has.
fn check_trusted() -> bool {
    // SAFETY: Passing null for the options dict is documented by Apple as the
    // way to query the current trust status without showing a dialog.
    unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) }
}

/// Copy one attribute value from an AXUIElement.
///
/// Returns `Some(raw_ptr)` on `kAXErrorSuccess`; the returned pointer is a
/// **+1 retained** CoreFoundation object — the caller MUST `CFRelease` it when
/// done.  Returns `None` on any AX error.
///
/// # Safety
/// `el` must be a valid `AXUIElementRef`.
unsafe fn copy_attribute(el: *mut c_void, attr_name: &str) -> Option<*mut c_void> {
    let cf_attr = cfstring_from_str(attr_name);
    // CFString::as_concrete_TypeRef() returns the raw CFStringRef, which is a
    // *const c_void alias in CF terminology. We need *const c_void.
    use core_foundation::base::TCFType;
    let attr_ref = cf_attr.as_CFTypeRef() as *const c_void;

    let mut value_out: *mut c_void = std::ptr::null_mut();
    let err = AXUIElementCopyAttributeValue(el, attr_ref, &mut value_out as *mut *mut c_void);
    if err == AX_SUCCESS && !value_out.is_null() {
        Some(value_out)
    } else {
        None
    }
}

/// Copy one attribute value from an AXUIElement and also return the raw AX
/// error code (useful when the caller needs to distinguish
/// `kAXErrorAttributeUnsupported` from other errors).
unsafe fn copy_attribute_with_err(el: *mut c_void, attr_name: &str) -> (i32, *mut c_void) {
    let cf_attr = cfstring_from_str(attr_name);
    use core_foundation::base::TCFType;
    let attr_ref = cf_attr.as_CFTypeRef() as *const c_void;
    let mut value_out: *mut c_void = std::ptr::null_mut();
    let err = AXUIElementCopyAttributeValue(el, attr_ref, &mut value_out as *mut *mut c_void);
    (err, value_out)
}

/// Extract a Rust `String` from a raw CFStringRef.
///
/// # Safety
/// `cf_str` must be a valid CFString object with a lifetime that encompasses
/// this call.
unsafe fn string_from_cfstring(cf_str: *const c_void) -> String {
    if cf_str.is_null() {
        return String::new();
    }
    // Fast path: try to get a direct pointer to the UTF-8 bytes.
    let c_ptr = CFStringGetCStringPtr(cf_str, CF_STRING_ENCODING_UTF8);
    if !c_ptr.is_null() {
        return std::ffi::CStr::from_ptr(c_ptr).to_string_lossy().into_owned();
    }
    // Slow path: copy into a stack buffer (256 bytes is enough for window titles).
    let mut buf = vec![0i8; 512];
    let ok = CFStringGetCString(
        cf_str,
        buf.as_mut_ptr(),
        buf.len() as isize,
        CF_STRING_ENCODING_UTF8,
    );
    if ok {
        let u8_slice = std::slice::from_raw_parts(buf.as_ptr() as *const u8, buf.len());
        let nul = u8_slice.iter().position(|&b| b == 0).unwrap_or(u8_slice.len());
        String::from_utf8_lossy(&u8_slice[..nul]).into_owned()
    } else {
        String::new()
    }
}

/// Extract a `f64` from a raw CFNumberRef using `kCFNumberFloat64Type`.
///
/// Returns `None` if `cf_num` is null or extraction fails.
///
/// # Safety
/// `cf_num` must be a valid CFNumber object.
unsafe fn f64_from_cfnumber(cf_num: *const c_void) -> Option<f64> {
    if cf_num.is_null() {
        return None;
    }
    let mut out: f64 = 0.0;
    let ok = CFNumberGetValue(
        cf_num,
        CF_NUMBER_FLOAT64_TYPE,
        &mut out as *mut f64 as *mut c_void,
    );
    if ok { Some(out) } else { None }
}

/// Create a +1 retained CFNumber from a `f64`.
///
/// The caller must `CFRelease` the returned pointer when done.
unsafe fn cfnumber_from_f64(v: f64) -> *mut c_void {
    CFNumberCreate(
        std::ptr::null(),
        CF_NUMBER_FLOAT64_TYPE,
        &v as *const f64 as *const c_void,
    )
}

/// A C-compatible CGPoint (64-bit float components, same layout as the system struct).
#[repr(C)]
struct CgPoint {
    x: f64,
    y: f64,
}

/// A C-compatible CGSize.
#[repr(C)]
struct CgSize {
    width: f64,
    height: f64,
}

/// Extract a `Rect` from a pair of AXValue attributes (AXPosition + AXSize).
///
/// Silently returns a zero `Rect` if either attribute is absent or the AXValue
/// cannot be decoded.
///
/// # Safety
/// `el` must be a valid `AXUIElementRef`.
unsafe fn bounding_rect_from_element(el: *mut c_void) -> Rect {
    let mut rect = Rect { x: 0, y: 0, width: 0, height: 0 };

    if let Some(pos_val) = copy_attribute(el, ATTR_POSITION) {
        let mut pt = CgPoint { x: 0.0, y: 0.0 };
        AXValueGetValue(
            pos_val as *const c_void,
            AX_VALUE_CG_POINT_TYPE,
            &mut pt as *mut CgPoint as *mut c_void,
        );
        rect.x = pt.x as i32;
        rect.y = pt.y as i32;
        CFRelease(pos_val as *const c_void);
    }

    if let Some(size_val) = copy_attribute(el, ATTR_SIZE) {
        let mut sz = CgSize { width: 0.0, height: 0.0 };
        AXValueGetValue(
            size_val as *const c_void,
            AX_VALUE_CG_SIZE_TYPE,
            &mut sz as *mut CgSize as *mut c_void,
        );
        rect.width = sz.width as i32;
        rect.height = sz.height as i32;
        CFRelease(size_val as *const c_void);
    }

    rect
}

// ---------------------------------------------------------------------------
// Window enumeration
// ---------------------------------------------------------------------------

/// Enumerate all top-level accessible windows across all running applications.
///
/// Returns up to 256 `(NativeElementInfo, AxElementRef)` pairs. Per-element
/// AX errors are silently skipped (best-effort: if one app's windows are
/// inaccessible, we still list the rest).
///
/// Uses `NSWorkspace::runningApplications()` for process discovery, then
/// `AXUIElementCreateApplication(pid)` + `AXWindows` attribute for window
/// enumeration.
fn list_windows_with_refs() -> Vec<(NativeElementInfo, AxElementRef)> {
    let mut out: Vec<(NativeElementInfo, AxElementRef)> = Vec::new();

    // --- NSWorkspace process enumeration ---
    // SAFETY: All objc2 calls here are safe; `sharedWorkspace()` is documented
    // as returning a non-null shared instance. We keep Retained<> wrappers so
    // ObjC ref-counting stays correct.
    let apps: Vec<(i32, String)> = unsafe {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::NSArray;

        let workspace = NSWorkspace::sharedWorkspace();
        let running: objc2::rc::Retained<NSArray<objc2_app_kit::NSRunningApplication>> =
            workspace.runningApplications();

        let count = running.count();
        let mut pairs: Vec<(i32, String)> = Vec::with_capacity(count);
        for i in 0..count {
            let app = running.objectAtIndex(i);
            let pid: i32 = app.processIdentifier();
            // localizedName returns Option<Retained<NSString>>; map to String.
            let name: String = app
                .localizedName()
                .map(|ns| ns.to_string())
                .unwrap_or_default();
            pairs.push((pid, name));
        }
        pairs
    };

    // --- AX window enumeration per process ---
    for (pid, process_name) in &apps {
        if out.len() >= 256 {
            break;
        }

        // SAFETY: AXUIElementCreateApplication always returns a +1 retained
        // AXUIElementRef (or null on OOM, which we guard against below).
        let app_el_raw = unsafe { AXUIElementCreateApplication(*pid) };
        if app_el_raw.is_null() {
            continue;
        }
        // Wrap immediately so it gets released on scope exit.
        let app_el = unsafe { AxElementRef::from_raw_retained(app_el_raw) };

        // Copy AXWindows — returns a CFArray of +1 retained AXUIElementRef values.
        // We use the count + range variant to avoid pulling an unbounded array.
        let windows_arr_raw: *mut c_void = unsafe {
            // SAFETY: app_el.as_raw() is a valid AXUIElementRef.
            match copy_attribute(app_el.as_raw(), ATTR_WINDOWS) {
                Some(v) => v,
                None => continue,
            }
        };

        // Verify the return is actually a CFArray before iterating.
        let is_array = unsafe {
            CFGetTypeID(windows_arr_raw as *const c_void) == CFArrayGetTypeID()
        };
        if !is_array {
            unsafe { CFRelease(windows_arr_raw as *const c_void) };
            continue;
        }

        let win_count = unsafe { CFArrayGetCount(windows_arr_raw as *const c_void) };
        let take = win_count.min(64); // cap per-process to keep total ≤ 256

        for idx in 0..take {
            if out.len() >= 256 {
                break;
            }

            // CFArrayGetValueAtIndex is a Get (no retain). We retain to wrap.
            let win_raw_get =
                unsafe { CFArrayGetValueAtIndex(windows_arr_raw as *const c_void, idx) };
            if win_raw_get.is_null() {
                continue;
            }
            // Retain so we can own it.
            // SAFETY: win_raw_get is a valid CF object borrowed from windows_arr_raw
            // which we hold alive for the duration of this loop.
            unsafe { CFRetain(win_raw_get) };
            let win_ref = unsafe { AxElementRef::from_raw_retained(win_raw_get as *mut c_void) };

            // Read AXTitle.
            let title: String = unsafe {
                match copy_attribute(win_ref.as_raw(), ATTR_TITLE) {
                    Some(t) => {
                        let s = string_from_cfstring(t as *const c_void);
                        CFRelease(t as *const c_void);
                        s
                    }
                    None => String::new(),
                }
            };

            // Read bounding rect.
            let bounding_rect = unsafe { bounding_rect_from_element(win_ref.as_raw()) };

            // Skip invisible / zero-size windows (same heuristic as Windows adapter).
            if bounding_rect.width <= 0 || bounding_rect.height <= 0 {
                continue;
            }

            let info = NativeElementInfo {
                process_name: process_name.clone(),
                window_title: title,
                class_name: String::new(),
                automation_id: String::new(),
                control_type: "AXWindow".to_string(),
                bounding_rect,
            };

            out.push((info, win_ref));
        }

        // Release the windows CFArray.
        unsafe { CFRelease(windows_arr_raw as *const c_void) };
    }

    out
}

// ---------------------------------------------------------------------------
// Hint matcher (mirrors windows.rs::matches_hint)
// ---------------------------------------------------------------------------

fn matches_hint(info: &NativeElementInfo, hint: &NativeTargetHint) -> bool {
    let process_ok = hint
        .process_name
        .as_ref()
        .map(|p| info.process_name.eq_ignore_ascii_case(p))
        .unwrap_or(true);
    let title_ok = hint
        .window_title
        .as_ref()
        .map(|t| info.window_title.contains(t.as_str()))
        .unwrap_or(true);
    let class_ok = hint
        .class_name
        .as_ref()
        .map(|c| info.class_name.eq_ignore_ascii_case(c))
        .unwrap_or(true);
    let elem_ok = hint
        .element_name
        .as_ref()
        .map(|n| info.window_title.contains(n.as_str()))
        .unwrap_or(true);
    let aid_ok = hint
        .automation_id
        .as_ref()
        .map(|a| info.automation_id.eq_ignore_ascii_case(a))
        .unwrap_or(true);
    process_ok && title_ok && class_ok && elem_ok && aid_ok
}

// ---------------------------------------------------------------------------
// MacOsAdapter
// ---------------------------------------------------------------------------

/// macOS NSAccessibility-backed accessibility adapter.
///
/// Stateless: all state (pending reverts, cached element refs) is held by the
/// IPC server layer, not here. Each method that needs AX access checks
/// `check_trusted()` inline.
pub struct MacOsAdapter;

impl MacOsAdapter {
    pub fn new() -> Self {
        MacOsAdapter
    }
}

impl Default for MacOsAdapter {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// AccessibilityAdapter implementation
// ---------------------------------------------------------------------------

impl AccessibilityAdapter for MacOsAdapter {
    fn platform_name(&self) -> &'static str {
        "macos"
    }

    fn capabilities(&self) -> Vec<Capability> {
        vec![Capability::Ipc, Capability::UiaInspect, Capability::FontScale]
    }

    fn list_top_level_windows(&self) -> AdapterResult<Vec<NativeElementInfo>> {
        let pairs = list_windows_with_refs();
        // Drop the AxElementRef values (releasing the retain counts).
        Ok(pairs.into_iter().map(|(info, _ref)| info).collect())
    }

    fn find_element(&self, hint: &NativeTargetHint) -> AdapterResult<Option<Element>> {
        let pairs = list_windows_with_refs();
        for (info, ax_ref) in pairs {
            if matches_hint(&info, hint) {
                let handle = PlatformElement::MacOs(ax_ref);
                return Ok(Some(Element::new(info, handle)));
            }
        }
        Ok(None)
    }

    fn apply_font_scale(
        &self,
        element: &Element,
        scale: f32,
    ) -> AdapterResult<AdaptationHandle> {
        // --- Gate 1: accessibility permission ---
        if !check_trusted() {
            return Err(AdapterError::PermissionDenied(
                "accessibility access not granted; open System Settings → \
                 Privacy & Security → Accessibility and enable AccessBridge"
                    .into(),
            ));
        }

        // --- Gate 2: extract AxElementRef from handle ---
        let ax_ref = match element.handle() {
            PlatformElement::MacOs(ref r) => r.clone(),
            _ => {
                return Err(AdapterError::PlatformError(
                    "element handle is not a macOS AxElementRef".into(),
                ));
            }
        };

        // --- Read current AXFontSize ---
        let (ax_err, font_size_raw) = unsafe {
            copy_attribute_with_err(ax_ref.as_raw(), ATTR_FONT_SIZE)
        };

        if ax_err == AX_ERR_ATTRIBUTE_UNSUPPORTED
            || ax_err == AX_ERR_NOT_IMPLEMENTED
            || ax_err == AX_ERR_CANNOT_COMPLETE
        {
            return Err(AdapterError::Unsupported(
                "this macOS control does not expose AXFontSize — \
                 use the browser adapter for Safari or Chrome content"
                    .into(),
            ));
        }

        if ax_err != AX_SUCCESS || font_size_raw.is_null() {
            return Err(AdapterError::PlatformError(format!(
                "AXUIElementCopyAttributeValue(AXFontSize) returned error {ax_err}"
            )));
        }

        let previous_size: f64 = unsafe {
            // SAFETY: font_size_raw is a +1 retained CFNumber from CopyAttributeValue.
            let v = f64_from_cfnumber(font_size_raw as *const c_void).unwrap_or(0.0);
            CFRelease(font_size_raw as *const c_void);
            v
        };

        if previous_size <= 0.0 {
            return Err(AdapterError::PlatformError(
                "AXFontSize returned zero or negative — cannot apply scale".into(),
            ));
        }

        // --- Compute and set new font size ---
        let new_size = previous_size * scale as f64;

        let set_err = unsafe {
            // SAFETY: cfnumber_from_f64 returns a +1 retained CFNumber.
            let num = cfnumber_from_f64(new_size);
            if num.is_null() {
                return Err(AdapterError::PlatformError(
                    "CFNumberCreate returned null — OOM?".into(),
                ));
            }
            use core_foundation::base::TCFType;
            let cf_attr = cfstring_from_str(ATTR_FONT_SIZE);
            let attr_ref = cf_attr.as_CFTypeRef() as *const c_void;
            let err = AXUIElementSetAttributeValue(ax_ref.as_raw(), attr_ref, num as *const c_void);
            // SetAttributeValue does NOT consume the value; we must release it.
            CFRelease(num as *const c_void);
            err
        };

        if set_err != AX_SUCCESS {
            return Err(AdapterError::PlatformError(format!(
                "AXUIElementSetAttributeValue(AXFontSize) returned error {set_err}"
            )));
        }

        Ok(AdaptationHandle {
            id: String::new(),
            revert: RevertState::MacOsAxFontSize {
                element: ax_ref,
                previous_size,
            },
        })
    }

    fn revert_adaptation(&self, handle: AdaptationHandle) -> AdapterResult<()> {
        match handle.revert {
            RevertState::MacOsAxFontSize { element, previous_size } => {
                // Best-effort: log on failure but don't surface an error.
                let set_err = unsafe {
                    // SAFETY: element is a valid AxElementRef (owned by this handle).
                    let num = cfnumber_from_f64(previous_size);
                    if num.is_null() {
                        warn!("revert_adaptation: CFNumberCreate returned null");
                        return Ok(());
                    }
                    use core_foundation::base::TCFType;
                    let cf_attr = cfstring_from_str(ATTR_FONT_SIZE);
                    let attr_ref = cf_attr.as_CFTypeRef() as *const c_void;
                    let err = AXUIElementSetAttributeValue(
                        element.as_raw(),
                        attr_ref,
                        num as *const c_void,
                    );
                    CFRelease(num as *const c_void);
                    err
                };
                if set_err != AX_SUCCESS {
                    warn!(
                        ax_err = set_err,
                        "revert_adaptation: AXUIElementSetAttributeValue failed (best-effort)"
                    );
                }
                Ok(())
            }

            RevertState::MacOsAppleScriptReader => {
                // Stub for future AppleScript-based reader revert.
                Ok(())
            }

            RevertState::None => Ok(()),

            RevertState::WindowsDpi { .. } | RevertState::WindowsWmSetFont { .. } => {
                Err(AdapterError::Unsupported(
                    "Windows revert state cannot be reverted by macOS adapter".into(),
                ))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_protocol::Rect;

    // --- Trait contract tests (no AX permission required) ---

    #[test]
    fn platform_name_is_macos() {
        let a = MacOsAdapter::new();
        assert_eq!(a.platform_name(), "macos");
    }

    #[test]
    fn capabilities_includes_font_scale() {
        let a = MacOsAdapter::new();
        assert!(a.capabilities().contains(&Capability::FontScale));
    }

    #[test]
    fn capabilities_advertise_three_items() {
        let a = MacOsAdapter::new();
        assert_eq!(a.capabilities().len(), 3);
    }

    #[test]
    fn revert_none_state_is_ok() {
        let a = MacOsAdapter::new();
        let h = AdaptationHandle {
            id: "x".into(),
            revert: RevertState::None,
        };
        assert!(a.revert_adaptation(h).is_ok());
    }

    // --- Attribute name constants ---

    #[test]
    fn ax_attribute_name_constants() {
        assert_eq!(ATTR_WINDOWS, "AXWindows");
        assert_eq!(ATTR_TITLE, "AXTitle");
        assert_eq!(ATTR_ROLE, "AXRole");
        assert_eq!(ATTR_FONT_SIZE, "AXFontSize");
        assert_eq!(ATTR_POSITION, "AXPosition");
        assert_eq!(ATTR_SIZE, "AXSize");
    }

    // --- AX error code constants ---

    #[test]
    fn ax_error_codes_match_apple_headers() {
        assert_eq!(AX_SUCCESS, 0);
        assert_eq!(AX_ERR_ATTRIBUTE_UNSUPPORTED, -25205);
        assert_eq!(AX_ERR_CANNOT_COMPLETE, -25204);
        assert_eq!(AX_ERR_NOT_IMPLEMENTED, -25200);
    }

    // --- AxElementRef safety: null pointer must not crash on drop ---

    #[test]
    fn ax_element_ref_null_does_not_crash_on_drop() {
        // We construct a null AxElementRef directly; Drop must guard the null.
        // SAFETY: Explicitly testing the null-guard in Drop. No CF object exists.
        let r = unsafe { AxElementRef::from_raw_retained(std::ptr::null_mut()) };
        drop(r); // must not panic or segfault
    }

    // --- matches_hint ---

    fn make_info(process: &str, title: &str) -> NativeElementInfo {
        NativeElementInfo {
            process_name: process.into(),
            window_title: title.into(),
            class_name: String::new(),
            automation_id: String::new(),
            control_type: "AXWindow".into(),
            bounding_rect: Rect { x: 0, y: 0, width: 800, height: 600 },
        }
    }

    #[test]
    fn matches_hint_empty_hint_always_true() {
        let info = make_info("Safari", "Apple — Start Page");
        let hint = NativeTargetHint::default();
        assert!(matches_hint(&info, &hint));
    }

    #[test]
    fn matches_hint_process_name_case_insensitive() {
        let info = make_info("Safari", "Something");
        let hint = NativeTargetHint {
            process_name: Some("SAFARI".into()),
            ..Default::default()
        };
        assert!(matches_hint(&info, &hint));
    }

    #[test]
    fn matches_hint_window_title_substring() {
        let info = make_info("Chrome", "GitHub — Mozilla Firefox");
        let hint = NativeTargetHint {
            window_title: Some("GitHub".into()),
            ..Default::default()
        };
        assert!(matches_hint(&info, &hint));
    }

    #[test]
    fn matches_hint_rejects_wrong_process() {
        let info = make_info("Firefox", "GitHub");
        let hint = NativeTargetHint {
            process_name: Some("Safari".into()),
            ..Default::default()
        };
        assert!(!matches_hint(&info, &hint));
    }

    // --- Windows revert state is rejected ---

    #[test]
    fn revert_windows_state_returns_unsupported_on_macos() {
        let a = MacOsAdapter::new();
        let h = AdaptationHandle {
            id: "y".into(),
            revert: RevertState::WindowsDpi { pid: 1, previous_ctx: 0 },
        };
        let result = a.revert_adaptation(h);
        assert!(matches!(result, Err(AdapterError::Unsupported(_))));
    }

    #[test]
    fn capabilities_includes_ipc_and_uia_inspect() {
        let a = MacOsAdapter::new();
        let caps = a.capabilities();
        assert!(caps.contains(&Capability::Ipc));
        assert!(caps.contains(&Capability::UiaInspect));
    }
}
