import Lean

/-! A small mathematical document with Unicode: λ, 😀. -/
namespace DisplayFixture
section
variable {α : Type} (x : α)

/-- Identity retains its input. -/
def identity : α := x

/-- The public equation, with an implicit type parameter. -/
theorem identity_eq : identity x = x := by
  rfl

private theorem helper (n : Nat) : n = n := by rfl
local notation "𝓝" => Nat
/-- A theorem using local notation. -/
theorem local_eq (n : 𝓝) : n = n := by rfl

-- Multiple declarations inside one command are an important boundary case.
mutual
  def even : Nat → Bool
    | 0 => true
    | n + 1 => odd n
  def odd : Nat → Bool
    | 0 => false
    | n + 1 => even n
end
end
end DisplayFixture
