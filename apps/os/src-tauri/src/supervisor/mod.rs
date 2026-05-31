//! Desktop-only process supervisors (swf-node daemon, research-swarm, NDI
//! sidecar). Compiled only on desktop — iOS/Android forbid child processes.

pub mod swarm;
pub mod swf_node;
