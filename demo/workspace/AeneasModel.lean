import Init.Data.UInt.Lemmas

/-! A small, hand-authored model for the static Aeneas demo.

This is not the Aeneas runtime. It models the checked `u32` addition and result
type needed by the example, without adding an extraction toolchain dependency.
-/
namespace AeneasMockup

inductive Error where
  | integerOverflow
deriving DecidableEq, Repr

abbrev Result (α : Type) := Except Error α
abbrev U32 := UInt32

/-- Unsigned 32-bit addition succeeds only when the mathematical sum fits. -/
def checkedAdd (x y : U32) : Result U32 :=
  if x.toNat + y.toNat < 2 ^ 32 then .ok (x + y)
  else .error .integerOverflow

end AeneasMockup
