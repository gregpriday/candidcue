//! File › Close Window (#266): `close_control_window` through the real IPC path.
//!
//! The command closes its CALLER, and only when the caller is the document
//! window. That restriction is the part worth a test of its own: Settings holds
//! the same application-command grant as control (`capabilities/
//! preferences.json` explains why), so the ACL lets Settings invoke this — and
//! a command that answered by closing control would let the Settings window
//! quit the app.
//!
//! What this cannot show is the close itself. MockRuntime queues a window close
//! and never runs the event loop that would deliver `CloseRequested`, so the
//! handshake hanging off that event is asserted nowhere automated. Tauri's own
//! source is the evidence that `close()` raises it and `destroy()` does not.

use candidcue_lib::commands;
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder};

struct Harness {
    app: tauri::App<MockRuntime>,
    control: WebviewWindow<MockRuntime>,
    preferences: WebviewWindow<MockRuntime>,
}

fn harness() -> Harness {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![commands::close_control_window])
        .build(mock_context(noop_assets()))
        .expect("mock app builds");
    let control = WebviewWindowBuilder::new(
        &app,
        candidcue_lib::windows::CONTROL_LABEL,
        tauri::WebviewUrl::App("control.html".into()),
    )
    .build()
    .expect("mock control webview");
    let preferences = WebviewWindowBuilder::new(
        &app,
        candidcue_lib::windows::preferences::PREFERENCES_LABEL,
        tauri::WebviewUrl::App("preferences.html".into()),
    )
    .build()
    .expect("mock preferences webview");
    Harness {
        app,
        control,
        preferences,
    }
}

fn invoke(from: &WebviewWindow<MockRuntime>, command: &str) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        from,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body: InvokeBody::Json(json!({})),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().expect("response is json"))
}

#[test]
fn control_can_ask_to_close_itself_with_no_arguments() {
    let h = harness();
    let response = invoke(&h.control, "close_control_window");
    assert_eq!(
        response,
        Ok(Value::Null),
        "the frontend sends `close_control_window` with no payload; it must bind"
    );
}

#[test]
fn settings_cannot_use_it_to_quit_the_app() {
    let h = harness();
    let error = invoke(&h.preferences, "close_control_window")
        .expect_err("a close requested from Settings must be refused");
    assert_eq!(
        error.get("code").and_then(Value::as_str),
        Some("WINDOW_CLOSE_REFUSED"),
        "unexpected error shape: {error}"
    );
    assert!(
        h.app
            .get_webview_window(candidcue_lib::windows::CONTROL_LABEL)
            .is_some(),
        "the refusal must not have touched the document window"
    );
}
