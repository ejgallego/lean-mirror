import RustComment
import AeneasModel

set_option doc.verso true

open AeneasMockup
namespace AeneasDemo

/--
Increment a borrowed unsigned integer, returning its updated value in Lean.

```rust (name := bump)
pub fn bump(x: &mut u32) {
    *x += 1;
}
```

Static mock-up: this Rust docstring and the Aeneas-style Lean definition below
are paired by hand. Editing Rust does not regenerate the Lean definition.
-/
def bump (x : U32) : Result U32 := do
  checkedAdd x 1

#check bump

/-- Below the overflow bound, the returned value is exactly one larger. -/
theorem bump_spec (x : U32) (h : x.toNat + 1 < 2 ^ 32) :
    ∃ y, bump x = .ok y ∧ y.toNat = x.toNat + 1 := by
  refine ⟨x + 1, ?_, ?_⟩
  · simp [bump, checkedAdd, h]
  · rw [UInt32.toNat_add]
    change (x.toNat + 1) % 2 ^ 32 = x.toNat + 1
    exact Nat.mod_eq_of_lt h

-- Inspect the successful value and the modeled overflow in All Messages.
#eval bump 41
#eval bump 4294967295

end AeneasDemo
