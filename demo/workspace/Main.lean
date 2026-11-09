import Helper
import RustComment

set_option doc.verso true

#check Nat.succ
#check helperValue
#check helperSucc

theorem demo : True := by
  trivial

def twice (f : Nat -> Nat) (n : Nat) : Nat :=
  f (f n)

#eval twice Nat.succ helperValue

/-!
This Rust example is checked by Rosetta. Use *Edit Rust* to change it inline.

```rust (name := demoWidget)
fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    println!("{}", add(20, 22));
}
```

Edits stay in this Lean document.
-/

-- Try typing:
-- #check MissingLeanName
-- theorem broken : False := by
--   trivial
-- Try F12 on helperValue to jump into Helper.lean
-- Use the small inline button on the Rust block to disable or re-enable the widget.
