//! Aonsoku-BS Tagger: writes tag edits made in Aonsoku-BS into the music
//! files, from inside Navidrome.
//!
//! Plugins can't receive requests, so the plugin keeps a WebSocket open to
//! the Aonsoku-BS server (`link`), which passes it the edits admins make in
//! the app. Navidrome calls the plugin afresh for every event (a new WASM
//! instance each time), so everything that must last between calls is kept
//! in the plugin cache.

mod link;
mod settings;

use extism_pdk::*;
use nd_pdk::lifecycle::{Error as LifecycleError, InitProvider};
use nd_pdk::scheduler::{CallbackProvider, Error as SchedulerError, SchedulerCallbackRequest};
use nd_pdk::taskworker::{Error as TaskError, TaskExecuteProvider, TaskExecuteRequest};
use nd_pdk::websocket::{
    BinaryMessageProvider, CloseProvider, Error as WebSocketError, ErrorProvider,
    OnBinaryMessageRequest, OnCloseRequest, OnErrorRequest, OnTextMessageRequest,
    TextMessageProvider,
};

nd_pdk::register_lifecycle_init!(Tagger);
nd_pdk::register_scheduler_callback!(Tagger);
nd_pdk::register_taskworker_task_execute!(Tagger);
nd_pdk::register_websocket_text_message!(Tagger);
nd_pdk::register_websocket_binary_message!(Tagger);
nd_pdk::register_websocket_error!(Tagger);
nd_pdk::register_websocket_close!(Tagger);

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Default)]
struct Tagger;

impl InitProvider for Tagger {
    fn on_init(&self) -> Result<(), LifecycleError> {
        link::start().map_err(|e| LifecycleError::new(e.to_string()))
    }
}

impl CallbackProvider for Tagger {
    fn on_callback(&self, req: SchedulerCallbackRequest) -> Result<(), SchedulerError> {
        if req.payload == link::KEEPALIVE {
            link::keepalive();
        }
        Ok(())
    }
}

impl TaskExecuteProvider for Tagger {
    fn on_task_execute(&self, req: TaskExecuteRequest) -> Result<String, TaskError> {
        // Writing comes in the next step.
        Err(TaskError::new(format!("Unknown task queue {}", req.queue_name)))
    }
}

impl TextMessageProvider for Tagger {
    fn on_text_message(&self, req: OnTextMessageRequest) -> Result<(), WebSocketError> {
        if req.connection_id == link::CONNECTION_ID {
            link::on_message(&req.message);
        }
        Ok(())
    }
}

impl BinaryMessageProvider for Tagger {
    fn on_binary_message(&self, _req: OnBinaryMessageRequest) -> Result<(), WebSocketError> {
        Ok(())
    }
}

impl ErrorProvider for Tagger {
    fn on_error(&self, req: OnErrorRequest) -> Result<(), WebSocketError> {
        if req.connection_id == link::CONNECTION_ID {
            warn!("Connection to the Aonsoku-BS server failed: {}", req.error);
            link::on_closed();
        }
        Ok(())
    }
}

impl CloseProvider for Tagger {
    fn on_close(&self, req: OnCloseRequest) -> Result<(), WebSocketError> {
        if req.connection_id == link::CONNECTION_ID {
            info!("Connection to the Aonsoku-BS server closed ({}: {})", req.code, req.reason);
            link::on_closed();
        }
        Ok(())
    }
}
