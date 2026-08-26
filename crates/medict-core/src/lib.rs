//! Shared network query contracts used by the Medict desktop clients.
//!
//! The UI clients own their window, settings, and platform integration. This
//! crate owns only provider orchestration and the stable JSON result contract.

pub mod drug_lookup;
mod providers;
pub mod word_lookup;
