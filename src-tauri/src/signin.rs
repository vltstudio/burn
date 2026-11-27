use crate::ytm::api::Account;

#[derive(Clone, Debug, Default)]
pub enum Phase {
    #[default]
    Idle,
    Pending,
    Verifying,
    Ready(Account),
    Failed(String),
}

#[derive(Default)]
pub struct SignIn {
    pub phase: Phase,
    pub account: Option<Account>,
    generation: u64,
}

impl SignIn {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn begin(&mut self) -> u64 {
        self.generation += 1;
        self.phase = Phase::Pending;
        self.generation
    }

    pub fn active(&self, generation: u64) -> bool {
        self.generation == generation && matches!(self.phase, Phase::Pending | Phase::Verifying)
    }

    pub fn finish(&mut self, generation: u64, phase: Phase) -> bool {
        if !self.active(generation) {
            return false;
        }
        if let Phase::Ready(account) = &phase {
            self.account = Some(account.clone());
        }
        self.phase = phase;
        true
    }

    pub fn invalidate(&mut self) {
        self.generation += 1;
        self.phase = Phase::Idle;
        self.account = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_blocks_late_success() {
        let mut signin = SignIn::default();
        let attempt = signin.begin();
        signin.invalidate();
        assert!(!signin.finish(attempt, Phase::Ready(Account::default())));
        assert!(signin.account.is_none());
    }

    #[test]
    fn new_attempt_rejects_previous_result() {
        let mut signin = SignIn::default();
        let old = signin.begin();
        let current = signin.begin();
        assert!(!signin.finish(old, Phase::Failed("old".into())));
        assert!(signin.active(current));
        assert!(signin.finish(
            current,
            Phase::Ready(Account {
                name: "verified".into(),
                ..Account::default()
            })
        ));
        assert_eq!(signin.account.unwrap().name, "verified");
    }

    #[test]
    fn verifying_is_not_ready() {
        let mut signin = SignIn::default();
        let attempt = signin.begin();
        assert!(signin.finish(attempt, Phase::Verifying));
        assert!(signin.active(attempt));
        assert!(signin.account.is_none());
    }
}
