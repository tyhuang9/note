use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NativeErrorCode {
    DataTooLarge,
    ForbiddenWindow,
    InvalidData,
    MutationUnavailable,
    #[serde(rename = "unified_backup_recovery_required")]
    RecoveryRequired,
    StorageUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeError {
    pub(crate) code: NativeErrorCode,
    pub(crate) message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) field: Option<&'static str>,
}

impl NativeError {
    pub(crate) const fn data_too_large(field: &'static str) -> Self {
        Self {
            code: NativeErrorCode::DataTooLarge,
            message: "Local note data exceeds a safety limit.",
            field: Some(field),
        }
    }

    pub(crate) const fn forbidden_window() -> Self {
        Self {
            code: NativeErrorCode::ForbiddenWindow,
            message: "This window cannot access note data.",
            field: None,
        }
    }

    pub(crate) const fn invalid_data(field: Option<&'static str>) -> Self {
        Self {
            code: NativeErrorCode::InvalidData,
            message: "Local note data is invalid.",
            field,
        }
    }

    pub(crate) const fn mutation_unavailable() -> Self {
        Self {
            code: NativeErrorCode::MutationUnavailable,
            message: "Another local data operation is still finishing. Try again.",
            field: None,
        }
    }

    pub(crate) const fn storage_unavailable() -> Self {
        Self {
            code: NativeErrorCode::StorageUnavailable,
            message: "Local note storage is unavailable.",
            field: None,
        }
    }

    pub(crate) const fn recovery_required() -> Self {
        Self {
            code: NativeErrorCode::RecoveryRequired,
            message: "A pending local backup recovery must finish before Note data can be used.",
            field: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_errors_are_structured_and_path_free() {
        let serialized = serde_json::to_string(&NativeError::storage_unavailable()).unwrap();

        assert_eq!(
            serialized,
            r#"{"code":"storage_unavailable","message":"Local note storage is unavailable."}"#
        );
        assert!(!serialized.contains('/'));
        assert!(!serialized.contains('\\'));
    }
}
