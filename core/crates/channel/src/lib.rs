//! Minimal skeleton for the authenticated local IPC channel (`bellis-channel/1`).

pub const PROTOCOL_VERSION: &str = "bellis-channel/1";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_pinned() {
        assert_eq!(PROTOCOL_VERSION, "bellis-channel/1");
    }
}
