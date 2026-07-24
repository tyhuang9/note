use std::path::PathBuf;

use crate::{mutation::MutationGate, notes::NotesService};

pub(crate) struct AppState {
    pub(crate) mutations: MutationGate,
    pub(crate) notes: NotesService,
}

impl AppState {
    pub(crate) fn new(app_data_dir: PathBuf) -> Self {
        Self {
            mutations: MutationGate::default(),
            notes: NotesService::new(app_data_dir),
        }
    }
}
