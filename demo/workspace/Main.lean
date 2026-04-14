import Helper

#check Nat.succ
#check helperValue
#check helperSucc

theorem demo : True := by
  trivial

def twice (f : Nat -> Nat) (n : Nat) : Nat :=
  f (f n)

#eval twice Nat.succ helperValue

-- Try typing:
-- #check MissingLeanName
-- theorem broken : False := by
--   trivial
-- Try F12 on helperValue to jump into Helper.lean
