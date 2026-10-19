//! #258: a speech model damaged after install is REPORTED, not loaded.
//!
//! The issue's own reproduction, through the app's own IPC: a sealed download
//! of the shipping model with one graph damaged, then `preload_speech_engine`.
//! Before the fix that call handed the graph to onnxruntime, which threw a C++
//! exception through the FFI boundary and aborted the process (SIGABRT). Now
//! it must come back as `STT_MODEL_DAMAGED` — recoverable, because Settings ›
//! Speech offers the download that repairs it — and the status Settings reads
//! must say the same thing instead of "Downloaded".
//!
//! If the check in front of the load ever lets one of these through, this test
//! does not fail politely: the test process aborts. That is the bug.
//!
//! Its own test binary, because it has to plant files in the app-data
//! directory. Tauri resolves that from `HOME`, and this binary points `HOME`
//! at a temporary directory once, before any app is built — something no file
//! sharing a process with other tests could do safely, and the reason the
//! planted model can never land in a real `~/Library`.
//!
//! Windows resolves app data through the Known Folder API, which no
//! environment variable redirects. There the app is given an identifier of its
//! own for this run, so its app-data directory is a fresh one under the real
//! `AppData\Roaming` — never CandidCue's — and the test removes it after.

use std::io::{Seek as _, SeekFrom, Write as _};
use std::path::Path;
use std::sync::{Arc, Mutex};

use candidcue_lib::coordinator::AppCoordinator;
use candidcue_lib::database::{self, Database};
use candidcue_lib::speech::catalogue::{self, ModelEntry};
use candidcue_lib::speech::model_manager::SpeechModelManager;
use candidcue_lib::speech::model_store;
use candidcue_lib::speech::SpeechEngine;
use candidcue_lib::windows::events;
use candidcue_lib::{commands, scripts::DataPaths};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Listener as _, Manager as _, WebviewWindow, WebviewWindowBuilder};

/// The URL the app's own pages are served from, which the ACL checks every
/// invoke against: `tauri://localhost` on macOS and Linux, and
/// `http://tauri.localhost` on Windows, where WebView2 cannot register a custom
/// scheme and Tauri serves the app over HTTP instead. An invoke from anything
/// else is a REMOTE caller and is refused before the command runs — which is
/// how every test here failed on Windows with "not allowed".
const APP_URL: &str = if cfg!(windows) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};

struct Harness {
    _db_dir: tempfile::TempDir,
    app: tauri::App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
}

/// The identifier this run's app answers to on Windows (see the module doc).
fn windows_test_identifier() -> String {
    format!("com.candidcue.test.damaged-model.{}", std::process::id())
}

fn test_context() -> tauri::Context<MockRuntime> {
    let mut context = mock_context(noop_assets());
    if cfg!(windows) {
        context.config_mut().identifier = windows_test_identifier();
    }
    context
}

/// Removes this run's app-data directory on Windows, however the test ends
/// short of an abort.
struct RemoveOnDrop(std::path::PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn harness() -> Harness {
    let db_dir = tempfile::tempdir().expect("tempdir");
    let pool = tauri::async_runtime::block_on(database::init(db_dir.path()))
        .expect("database init + migrations");
    let paths = DataPaths::new(db_dir.path().to_path_buf());

    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            commands::get_speech_model_status,
            commands::get_speech_engine_status,
            commands::delete_speech_model,
            commands::get_speech_language_options,
            commands::preload_speech_engine,
            commands::start_transcription,
        ])
        .build(test_context())
        .expect("mock app builds");

    app.manage(candidcue_lib::database::BootStatus::Ready);
    app.manage(Database::new(pool));
    app.manage(paths);
    app.manage(AppCoordinator::default());
    app.manage(SpeechModelManager::new());
    app.manage(SpeechEngine::new());

    let webview =
        WebviewWindowBuilder::new(&app, "control", tauri::WebviewUrl::App("control.html".into()))
            .build()
            .expect("mock control webview");

    Harness {
        _db_dir: db_dir,
        app,
        webview,
    }
}

impl Harness {
    fn invoke(&self, command: &str, args: Value) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            &self.webview,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: APP_URL.parse().expect("url"),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<Value>().expect("response is json"))
    }
}

/// `ir_version: 7`, the graph's tag, and the length that makes a file of
/// exactly `len` bytes once the four-byte opset trailer is appended.
fn envelope_header(len: u64) -> Vec<u8> {
    for width in 1..=10u64 {
        let payload = len - (3 + width + 4);
        let mut encoded = Vec::new();
        let mut value = payload;
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                encoded.push(byte);
                break;
            }
            encoded.push(byte | 0x80);
        }
        if encoded.len() as u64 == width {
            return [vec![0x08, 0x07, 0x3a], encoded].concat();
        }
    }
    panic!("no envelope is exactly {len} bytes");
}

/// A whole ONNX envelope of exactly `len` bytes, written sparse: the graph
/// payload is a hole, so the catalogue-length encoder costs a few bytes of
/// disk, and the check — which seeks past payloads — sees what it would see
/// in a real graph.
fn write_graph(path: &Path, len: u64) {
    let mut file = std::fs::File::create(path).unwrap();
    file.write_all(&envelope_header(len)).unwrap();
    file.seek(SeekFrom::Start(len - 4)).unwrap();
    // opset_import { version: 13 }
    file.write_all(&[0x42, 0x02, 0x10, 0x0d]).unwrap();
}

/// A sealed download of `model` that every check accepts, at the real
/// catalogue's names and lengths.
fn plant_whole_download(dir: &Path, model: &ModelEntry) {
    std::fs::create_dir_all(dir).unwrap();
    for file in &model.files {
        let path = dir.join(&file.name);
        if file.name.ends_with(".onnx") {
            write_graph(&path, file.bytes);
        } else {
            let mut handle = std::fs::File::create(&path).unwrap();
            handle.write_all(b"<blk> 0\n").unwrap();
            handle.set_len(file.bytes).unwrap();
        }
    }
    model_store::write_seal(dir, model).unwrap();
}

/// The encoder cut to 50 MB, as #258 measured.
fn cut_encoder(dir: &Path) {
    std::fs::OpenOptions::new()
        .write(true)
        .open(dir.join("encoder.int8.onnx"))
        .unwrap()
        .set_len(50 * 1024 * 1024)
        .unwrap();
}

/// The decoder at its right length, holding bytes that are not a graph.
fn garbage_decoder(dir: &Path) {
    let path = dir.join("decoder.onnx");
    let len = std::fs::metadata(&path).unwrap().len();
    let mut file = std::fs::File::create(&path).unwrap();
    file.write_all(b"<!DOCTYPE html><html>not a graph</html>").unwrap();
    file.set_len(len).unwrap();
}

fn code_of(err: &Value) -> &str {
    err.get("code").and_then(Value::as_str).unwrap_or_default()
}

/// One test, not several: every case plants files in the same app-data
/// directory, and tests in one binary run on parallel threads.
#[test]
fn a_damaged_download_is_reported_and_never_reaches_the_recogniser() {
    let home = tempfile::tempdir().expect("temp HOME");
    std::env::set_var("HOME", home.path());

    let h = harness();
    let app_data = h.app.path().app_data_dir().expect("app data dir");
    let _cleanup = if cfg!(windows) {
        assert!(
            app_data.ends_with(windows_test_identifier()),
            "the planted model must land in this run's own directory, not in {}",
            app_data.display()
        );
        Some(RemoveOnDrop(app_data.clone()))
    } else {
        assert!(
            app_data.starts_with(home.path()),
            "the planted model must land under the temporary HOME, not in {}",
            app_data.display()
        );
        None
    };
    let model = catalogue::default_model();
    let dir = model.install_path(&model_store::models_root(&app_data));

    // The two damages #258 measured: an encoder cut short, and a decoder of
    // the right length whose bytes are not a graph.
    for (label, damage) in [
        ("cut encoder", cut_encoder as fn(&Path)),
        ("garbage decoder", garbage_decoder),
    ] {
        let _ = std::fs::remove_dir_all(&dir);
        plant_whole_download(&dir, model);
        damage(&dir);

        // What Settings reads: not "Downloaded", and not a bare "not installed".
        let status = h
            .invoke("get_speech_model_status", json!({}))
            .unwrap_or_else(|e| panic!("{label}: status must answer, got {e}"));
        assert_eq!(status["installed"], false, "{label}: {status}");
        assert_eq!(status["phase"], "failed", "{label}: {status}");
        assert_eq!(status["error"]["code"], "STT_MODEL_DAMAGED", "{label}: {status}");
        // Still a download on disk, so Settings can offer to remove it.
        assert_eq!(status["source"], "downloaded", "{label}: {status}");
        let message = status["error"]["message"].as_str().unwrap_or_default();
        assert!(
            !message.contains(&app_data.display().to_string()),
            "{label}: a filesystem path reached the screen: {message}"
        );

        // The picker reads the same status through the language options.
        let options = h
            .invoke("get_speech_language_options", json!({}))
            .unwrap_or_else(|e| panic!("{label}: options must answer, got {e}"));
        assert_eq!(
            options["languages"][0]["status"]["error"]["code"],
            "STT_MODEL_DAMAGED",
            "{label}: {options}"
        );

        // "Can I transcribe?" answers no, with nothing private in the answer:
        // the damage detail names a path, and that is for the log.
        let engine = h
            .invoke("get_speech_engine_status", json!({}))
            .unwrap_or_else(|e| panic!("{label}: engine status never fails, got {e}"));
        assert_eq!(engine["available"], false, "{label}: {engine}");
        let detail = engine["detail"].as_str().unwrap_or_default();
        assert!(
            !detail.contains(&app_data.display().to_string()) && !detail.contains(".onnx"),
            "{label}: diagnostic detail reached the frontend: {detail}"
        );

        // The issue's reproduction: this call used to abort the process.
        let err = h
            .invoke("preload_speech_engine", json!({}))
            .expect_err(&format!("{label}: preload must refuse a damaged model"));
        assert_eq!(code_of(&err), "STT_MODEL_DAMAGED", "{label}: {err}");
        assert_eq!(
            err.get("recoverable").and_then(Value::as_bool),
            Some(true),
            "{label}: downloading the model again is a remedy the user can take"
        );

        let err = h
            .invoke("start_transcription", json!({}))
            .expect_err(&format!("{label}: a take must refuse a damaged model"));
        assert_eq!(code_of(&err), "STT_MODEL_DAMAGED", "{label}: {err}");
        assert_eq!(
            h.app.state::<SpeechEngine>().active_generation(),
            None,
            "{label}: no session is armed on a damaged model"
        );
        assert!(
            !h.app.state::<SpeechEngine>().is_loaded(),
            "{label}: nothing was loaded"
        );
    }

    // A damaged download is still the user's to remove — the way out when a
    // repair has no room to run — and removing it leaves an honest "not
    // installed", not a remembered damage.
    let _ = std::fs::remove_dir_all(&dir);
    plant_whole_download(&dir, model);
    garbage_decoder(&dir);
    // #301: the removal is ANNOUNCED to the control window, not only returned
    // to whichever window pressed Remove. The editor lives in control and
    // learns of every other install state from this event; before, it learned
    // of a removal from nothing, and went on reporting a model that was gone.
    let announced: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = Arc::clone(&announced);
    h.webview.listen(events::SPEECH_MODEL_PROGRESS, move |event| {
        let payload = serde_json::from_str(event.payload()).expect("event payload is json");
        sink.lock().unwrap().push(payload);
    });
    let status = h
        .invoke("delete_speech_model", json!({}))
        .expect("a damaged download must be removable");
    assert!(!dir.exists(), "the damaged files must be gone");
    assert_eq!(status["phase"], "notInstalled", "{status}");
    assert_eq!(status["source"], Value::Null, "{status}");
    assert_eq!(status["error"], Value::Null, "{status}");
    assert_eq!(
        *announced.lock().unwrap(),
        vec![status.clone()],
        "the control window must be told what the caller was told"
    );

    // And the whole download, undamaged, reads as installed — so the check is
    // not simply refusing everything at the real catalogue's lengths. (Not
    // loaded: these graphs are envelopes with holes for weights.)
    let _ = std::fs::remove_dir_all(&dir);
    plant_whole_download(&dir, model);
    let status = h
        .invoke("get_speech_model_status", json!({}))
        .expect("status must answer");
    assert_eq!(status["installed"], true, "{status}");
    assert_eq!(status["phase"], "installed", "{status}");
    assert_eq!(status["error"], Value::Null, "{status}");
}
