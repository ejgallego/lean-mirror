import Lean

open Lean Elab Doc

/-- Register Rust fences in Lean's Verso doc-comment elaborator.
Rosetta analysis is performed explicitly by the demo host, never during elaboration. -/
@[doc_code_block]
meta def rust (name : Option Ident := none) (code : StrLit) : DocM (Block ElabInline ElabBlock) := do
  let _ := name
  return .code code.getString
