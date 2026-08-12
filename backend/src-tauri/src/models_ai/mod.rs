use std::{path::Path, sync::Arc};

pub(crate) mod api;
pub(crate) mod client;
pub(crate) mod contracts;
pub(crate) mod store;

use store::ModelsAiStore;

pub(crate) struct ModelsAiRuntime {
    pub(crate) store: Arc<ModelsAiStore>,
}

impl ModelsAiRuntime {
    pub(crate) fn new(app_data_dir: &Path) -> Self {
        Self {
            store: Arc::new(ModelsAiStore::new(app_data_dir)),
        }
    }
}
