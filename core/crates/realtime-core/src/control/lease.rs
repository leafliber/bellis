//! 输入许可状态机：单调递增令牌、到期时刻、吊销水位与本地撤权。

use std::fmt;

use crate::protocol::{LeaseStatus, ReleaseReason};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    NotGranted,
    Valid { token: u64, expires_ns: u64 },
    Expired { token: u64 },
    Revoked,
    SourceLost,
}

/// 授予或续约接受后的分类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Granted {
    New,
    Renewed,
    Replaced,
}

/// `lease.renew` 被拒绝的原因（映射为 `-32004 LEASE_REFUSED`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    InvalidToken,
    Stale { token: u64, current: u64 },
    Revoked { token: u64, through: u64 },
    Lapsed { token: u64 },
    PastExpiry { expires_ns: u64, now: u64 },
    ClockUnavailable,
    NoSource,
    HookLost,
    ReleaseFailed,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidToken => f.write_str("lease token must be >= 1"),
            Self::Stale { token, current } => {
                write!(f, "token {token} is older than the current token {current}")
            }
            Self::Revoked { token, through } => {
                write!(f, "token {token} is revoked (tokens up to {through} are)")
            }
            Self::Lapsed { token } => write!(
                f,
                "the lease with token {token} has expired; grant a newer token"
            ),
            Self::PastExpiry { expires_ns, now } => {
                write!(f, "expires_ns {expires_ns} is not after now ({now})")
            }
            Self::ClockUnavailable => f.write_str("the system monotonic clock is unavailable"),
            Self::NoSource => f.write_str("there is no lease source"),
            Self::HookLost => f.write_str("the input hook has failed; restart the core"),
            Self::ReleaseFailed => f.write_str("input release failed; restart the core"),
        }
    }
}

/// 实时核持有的输入许可。
#[derive(Debug)]
pub(crate) struct Lease {
    has_source: bool,
    current_token: Option<u64>,
    revoked_through: Option<u64>,
    state: State,
}

impl Lease {
    pub(crate) fn new(has_source: bool) -> Self {
        Self {
            has_source,
            current_token: None,
            revoked_through: None,
            state: State::NotGranted,
        }
    }

    pub(crate) fn grant(
        &mut self,
        token: u64,
        expires_ns: u64,
        now: u64,
    ) -> Result<Granted, Refusal> {
        let granted = self.check_grant(token, expires_ns, now)?;
        self.current_token = Some(token);
        self.state = State::Valid { token, expires_ns };
        Ok(granted)
    }

    pub(crate) fn check_grant(
        &self,
        token: u64,
        expires_ns: u64,
        now: u64,
    ) -> Result<Granted, Refusal> {
        if !self.has_source || self.state == State::SourceLost {
            return Err(Refusal::NoSource);
        }
        if token == 0 {
            return Err(Refusal::InvalidToken);
        }
        if let Some(through) = self.revoked_through
            && token <= through
        {
            return Err(Refusal::Revoked { token, through });
        }
        if let Some(current) = self.current_token
            && token < current
        {
            return Err(Refusal::Stale { token, current });
        }
        if expires_ns <= now {
            return Err(Refusal::PastExpiry { expires_ns, now });
        }
        match self.state {
            State::Valid {
                token: held,
                expires_ns: previous_deadline,
            } if held == token => {
                if now < previous_deadline {
                    Ok(Granted::Renewed)
                } else {
                    Err(Refusal::Lapsed { token })
                }
            }
            State::Valid { .. } => Ok(Granted::Replaced),
            State::Expired { token: lapsed } if lapsed == token => Err(Refusal::Lapsed { token }),
            State::NotGranted | State::Expired { .. } | State::Revoked | State::SourceLost => {
                Ok(Granted::New)
            }
        }
    }

    pub(crate) fn revoke(&mut self, token: u64) -> bool {
        self.revoked_through = Some(self.revoked_through.map_or(token, |r| r.max(token)));
        self.current_token = Some(self.current_token.map_or(token, |c| c.max(token)));
        match self.state {
            State::Valid { token: held, .. } if held <= token => {
                self.state = State::Revoked;
                true
            }
            State::Expired { token: lapsed } if lapsed <= token => {
                self.state = State::Revoked;
                false
            }
            _ => false,
        }
    }

    pub(crate) fn local_revoke(&mut self) -> bool {
        match self.current_token {
            Some(token) => self.revoke(token),
            None => false,
        }
    }

    pub(crate) fn expire(&mut self, now: u64) -> bool {
        match self.state {
            State::Valid { token, expires_ns } if now >= expires_ns => {
                self.state = State::Expired { token };
                true
            }
            _ => false,
        }
    }

    pub(crate) fn source_lost(&mut self) -> bool {
        if !self.has_source || self.state == State::SourceLost {
            return false;
        }
        self.state = State::SourceLost;
        true
    }

    pub(crate) fn active_token(&self) -> Option<u64> {
        match self.state {
            State::Valid { token, .. } => Some(token),
            _ => None,
        }
    }

    pub(crate) fn check(&self, now: u64) -> Result<(), ReleaseReason> {
        match self.state {
            State::Valid { expires_ns, .. } if now < expires_ns => Ok(()),
            State::Valid { .. } | State::Expired { .. } => Err(ReleaseReason::LeaseExpired),
            State::Revoked => Err(ReleaseReason::LeaseRevoked),
            State::SourceLost => Err(ReleaseReason::LeaseSourceLost),
            State::NotGranted => Err(ReleaseReason::NoLease),
        }
    }

    pub(crate) fn expires_at(&self) -> Option<u64> {
        match self.state {
            State::Valid { expires_ns, .. } => Some(expires_ns),
            _ => None,
        }
    }

    pub(crate) fn status(&self, now: u64) -> LeaseStatus {
        match self.state {
            State::Valid { expires_ns, .. } if now < expires_ns => LeaseStatus::Valid,
            State::Valid { .. } | State::Expired { .. } => LeaseStatus::Expired,
            State::Revoked => LeaseStatus::Revoked,
            State::SourceLost => LeaseStatus::SourceLost,
            State::NotGranted => LeaseStatus::NotGranted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Granted, Lease, Refusal};
    use crate::protocol::{LeaseStatus, ReleaseReason};

    #[test]
    fn enforces_monotonic_tokens_expiry_revoke_and_source_loss() {
        let mut none = Lease::new(false);
        assert_eq!(none.grant(1, 500, 0), Err(Refusal::NoSource));
        assert_eq!(none.status(0), LeaseStatus::NotGranted);

        let mut lease = Lease::new(true);
        assert_eq!(lease.grant(0, 500, 0), Err(Refusal::InvalidToken));
        assert_eq!(lease.grant(2, 500, 0), Ok(Granted::New));
        assert_eq!(lease.grant(2, 800, 100), Ok(Granted::Renewed));
        assert_eq!(
            lease.grant(1, 900, 100),
            Err(Refusal::Stale {
                token: 1,
                current: 2
            })
        );
        assert_eq!(lease.grant(3, 900, 100), Ok(Granted::Replaced));
        assert!(lease.expire(900));
        assert_eq!(lease.grant(3, 1200, 950), Err(Refusal::Lapsed { token: 3 }));
        assert_eq!(lease.grant(4, 1500, 950), Ok(Granted::New));
        assert!(lease.local_revoke());
        assert_eq!(lease.check(1000), Err(ReleaseReason::LeaseRevoked));
        assert_eq!(
            lease.grant(4, 1500, 1000),
            Err(Refusal::Revoked {
                token: 4,
                through: 4
            })
        );
        assert_eq!(lease.grant(5, 2000, 1000), Ok(Granted::New));
        assert!(lease.source_lost());
        assert_eq!(lease.check(1100), Err(ReleaseReason::LeaseSourceLost));
        assert_eq!(lease.grant(6, 2500, 1100), Err(Refusal::NoSource));
    }
}
