//! Minimal skeleton for the deterministic realtime capture/input core.

pub fn channel_protocol() -> &'static str {
    bellis_channel::PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_against_channel_protocol() {
        assert_eq!(channel_protocol(), "bellis-channel/1");
    }
}
