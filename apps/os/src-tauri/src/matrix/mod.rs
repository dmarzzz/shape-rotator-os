//! Matrix client subsystem (matrix-rust-sdk) powering the "matrix" tab.
//!
//! All-platform (NOT desktop-gated) — the client, sync, crypto and SQLite
//! store run on iOS/Android too. Rust owns the live SDK objects and the
//! reactive `eyeball_im::Vector` streams; the renderer only ever receives
//! JSON diff envelopes (see [`diff`]) and applies them to local arrays, the
//! same model Element X uses across its FFI boundary.

pub mod diff;
