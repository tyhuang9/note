use std::sync::{Mutex, MutexGuard, TryLockError};

use crate::error::NativeError;

#[derive(Default)]
pub(crate) struct MutationGate {
    operation: Mutex<()>,
}

impl MutationGate {
    pub(crate) fn begin(&self) -> Result<MutexGuard<'_, ()>, NativeError> {
        // ponytail: one process-wide gate is sufficient until independent domains need concurrency.
        self.operation.try_lock().map_err(|error| match error {
            TryLockError::Poisoned(_) | TryLockError::WouldBlock => {
                NativeError::mutation_unavailable()
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_mutations_fail_without_queueing() {
        let gate = MutationGate::default();
        let first = gate.begin().unwrap();
        assert_eq!(
            gate.begin().unwrap_err(),
            NativeError::mutation_unavailable()
        );
        drop(first);
        assert!(gate.begin().is_ok());
    }
}
