use tokio::sync::{Mutex, MutexGuard};

use crate::error::NativeError;

#[derive(Default)]
pub(crate) struct MutationGate {
    operation: Mutex<()>,
}

impl MutationGate {
    pub(crate) fn begin(&self) -> Result<MutexGuard<'_, ()>, NativeError> {
        self.operation
            .try_lock()
            .map_err(|_| NativeError::mutation_unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_domain_concurrent_mutations_fail_without_queueing() {
        let gate = MutationGate::default();
        let first = gate.begin().unwrap();
        assert_eq!(
            gate.begin().unwrap_err(),
            NativeError::mutation_unavailable()
        );
        drop(first);
        assert!(gate.begin().is_ok());
    }

    #[test]
    fn separate_domains_admit_concurrent_mutations() {
        let notes = MutationGate::default();
        let calendar = MutationGate::default();
        let _note = notes.begin().unwrap();
        assert!(calendar.begin().is_ok());
    }
}
