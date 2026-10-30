//! Still's shared rules: validation, alert scheduling and the guard's session model.
//! Everything here is plain logic with no UI or Windows service code, so it is unit-tested directly.
pub mod alerts;
pub mod compat;
pub mod domain;
pub mod js;
pub mod session;
pub mod websites;
