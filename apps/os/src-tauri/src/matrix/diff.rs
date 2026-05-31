//! The diff bridge: translate the SDK's reactive `eyeball_im::VectorDiff<T>`
//! into a small, JSON-serializable envelope the renderer applies to a local
//! array. This mirrors how Element X ships `VectorDiff` updates across its
//! UniFFI boundary — our `invoke`/`emit` boundary is the same shape.
//!
//! Pure + unit-tested: every `VectorDiff` variant maps 1:1 to a `DiffOp` whose
//! `op` discriminant + fields match the renderer's `applyDiffs` reducer.

use matrix_sdk_ui::eyeball_im::{Vector, VectorDiff};
use serde::Serialize;

/// One diff op, JSON-serializable, applied to a local JS array. `op` is the
/// discriminant (camelCase); only the relevant fields are present. The index
/// space is shared with the renderer as long as every op is applied in order.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum DiffOp<V> {
    Append { values: Vec<V> },
    Clear,
    PushFront { value: V },
    PushBack { value: V },
    PopFront,
    PopBack,
    Insert { index: usize, value: V },
    Set { index: usize, value: V },
    Remove { index: usize },
    Truncate { length: usize },
    Reset { values: Vec<V> },
}

/// Convert one SDK `VectorDiff<T>` into our envelope op, projecting each item
/// `T` into a serializable DTO `V` with `f`. Total + panic-free by construction.
pub fn map_diff<T, V>(d: VectorDiff<T>, f: &impl Fn(&T) -> V) -> DiffOp<V> {
    match d {
        VectorDiff::Append { values } => DiffOp::Append { values: values.iter().map(f).collect() },
        VectorDiff::Clear => DiffOp::Clear,
        VectorDiff::PushFront { value } => DiffOp::PushFront { value: f(&value) },
        VectorDiff::PushBack { value } => DiffOp::PushBack { value: f(&value) },
        VectorDiff::PopFront => DiffOp::PopFront,
        VectorDiff::PopBack => DiffOp::PopBack,
        VectorDiff::Insert { index, value } => DiffOp::Insert { index, value: f(&value) },
        VectorDiff::Set { index, value } => DiffOp::Set { index, value: f(&value) },
        VectorDiff::Remove { index } => DiffOp::Remove { index },
        VectorDiff::Truncate { length } => DiffOp::Truncate { length },
        VectorDiff::Reset { values } => DiffOp::Reset { values: values.iter().map(f).collect() },
    }
}

/// The full payload emitted per stream batch. `key` routes the batch (room id
/// for timelines, `""` for the room list). `seq` lets the renderer detect a
/// dropped batch and re-subscribe to force a fresh `Reset` reseed.
#[derive(Serialize, Debug, Clone)]
pub struct DiffEnvelope<V> {
    pub key: String,
    pub seq: u64,
    pub diffs: Vec<DiffOp<V>>,
}

/// Map a whole batch of `VectorDiff<T>` into `DiffOp<V>` (convenience for the pump).
pub fn map_batch<T, V>(batch: Vec<VectorDiff<T>>, f: &impl Fn(&T) -> V) -> Vec<DiffOp<V>> {
    batch.into_iter().map(|d| map_diff(d, f)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, to_value};

    // Identity projection for String items.
    fn id(s: &String) -> String {
        s.clone()
    }

    fn vec_of(items: &[&str]) -> Vector<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn append_serializes_with_values() {
        let d = VectorDiff::Append { values: vec_of(&["a", "b"]) };
        let op = map_diff(d, &id);
        assert_eq!(to_value(&op).unwrap(), json!({ "op": "append", "values": ["a", "b"] }));
    }

    #[test]
    fn clear_is_bare_op() {
        let op = map_diff::<String, String>(VectorDiff::Clear, &id);
        assert_eq!(to_value(&op).unwrap(), json!({ "op": "clear" }));
    }

    #[test]
    fn push_front_and_back() {
        let f = map_diff(VectorDiff::PushFront { value: "x".to_string() }, &id);
        let b = map_diff(VectorDiff::PushBack { value: "y".to_string() }, &id);
        assert_eq!(to_value(&f).unwrap(), json!({ "op": "pushFront", "value": "x" }));
        assert_eq!(to_value(&b).unwrap(), json!({ "op": "pushBack", "value": "y" }));
    }

    #[test]
    fn pop_front_and_back_are_bare() {
        assert_eq!(
            to_value(map_diff::<String, String>(VectorDiff::PopFront, &id)).unwrap(),
            json!({ "op": "popFront" })
        );
        assert_eq!(
            to_value(map_diff::<String, String>(VectorDiff::PopBack, &id)).unwrap(),
            json!({ "op": "popBack" })
        );
    }

    #[test]
    fn insert_set_remove_carry_index() {
        let ins = map_diff(VectorDiff::Insert { index: 3, value: "v".to_string() }, &id);
        let set = map_diff(VectorDiff::Set { index: 2, value: "w".to_string() }, &id);
        let rem = map_diff::<String, String>(VectorDiff::Remove { index: 1 }, &id);
        assert_eq!(to_value(&ins).unwrap(), json!({ "op": "insert", "index": 3, "value": "v" }));
        assert_eq!(to_value(&set).unwrap(), json!({ "op": "set", "index": 2, "value": "w" }));
        assert_eq!(to_value(&rem).unwrap(), json!({ "op": "remove", "index": 1 }));
    }

    #[test]
    fn truncate_carries_length() {
        let op = map_diff::<String, String>(VectorDiff::Truncate { length: 5 }, &id);
        assert_eq!(to_value(&op).unwrap(), json!({ "op": "truncate", "length": 5 }));
    }

    #[test]
    fn reset_carries_full_values() {
        let op = map_diff(VectorDiff::Reset { values: vec_of(&["p", "q", "r"]) }, &id);
        assert_eq!(to_value(&op).unwrap(), json!({ "op": "reset", "values": ["p", "q", "r"] }));
    }

    #[test]
    fn projection_is_applied_to_items() {
        // Map each item to its length — proves `f` runs over every element.
        let d = VectorDiff::Append { values: vec_of(&["ab", "cde"]) };
        let op = map_diff(d, &|s: &String| s.len());
        assert_eq!(to_value(&op).unwrap(), json!({ "op": "append", "values": [2, 3] }));
    }

    #[test]
    fn envelope_shape() {
        let diffs = map_batch(vec![VectorDiff::PushBack { value: "z".to_string() }], &id);
        let env = DiffEnvelope { key: "!room:hs".to_string(), seq: 7, diffs };
        assert_eq!(
            to_value(&env).unwrap(),
            json!({
                "key": "!room:hs",
                "seq": 7,
                "diffs": [{ "op": "pushBack", "value": "z" }]
            })
        );
    }

    #[test]
    fn map_batch_preserves_order() {
        let batch = vec![
            VectorDiff::Clear,
            VectorDiff::PushBack { value: "1".to_string() },
            VectorDiff::PushFront { value: "0".to_string() },
        ];
        let ops = map_batch(batch, &id);
        assert_eq!(ops.len(), 3);
        assert!(matches!(ops[0], DiffOp::Clear));
        assert!(matches!(ops[1], DiffOp::PushBack { .. }));
        assert!(matches!(ops[2], DiffOp::PushFront { .. }));
    }
}
