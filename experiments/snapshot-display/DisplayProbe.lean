import Lean
import Lean.Server.Requests

open Lean Lean.Lsp Lean.Server
namespace DisplayProbe

structure Params where
  textDocument : VersionedTextDocumentIdentifier
  source : String
  waitMs : Nat
  policy : String
  names : Array String
  deriving FromJson, ToJson
instance : FileSource Params where
  fileSource p := p.textDocument.uri

structure Span where
  start : Nat
  stop : Nat
  deriving ToJson
structure Region where
  kind : String
  range : Span
  text : String
  deriving ToJson
structure Command where
  range : Span
  kind : String
  namespaceName : String
  regions : Array Region
  selected : Bool
  reason : String
  deriving ToJson
structure Response where
  version : Int
  positionEncoding : String := "utf16"
  rangeBase : String := "file"
  snapshotStatus : String
  policy : String
  commands : Array Command
  -- Syntax extraction makes no claim about proof validity.
  semanticStatus : String := "not-assessed"
  deriving ToJson

def checkCurrent : RequestM Unit := do
  let ctx ← readThe RequestContext
  if ← ctx.cancelTk.wasCancelledByEdit then throw RequestError.fileChanged
  RequestM.checkCancelled

def span (canonical original : FileMap) (stx : Syntax) : Option Span := do
  let a ← stx.getPos?
  let b ← stx.getTailPos?
  let a := original.lspPosToUtf8Pos (canonical.utf8PosToLspPos a)
  let b := original.lspPosToUtf8Pos (canonical.utf8PosToLspPos b)
  return { start := (String.Pos.Raw.extract original.source 0 a).utf16Length
           stop := (String.Pos.Raw.extract original.source 0 b).utf16Length }

def interesting (kind : Name) : Bool :=
  #[`Lean.Parser.Command.theorem, `Lean.Parser.Command.definition,
    `Lean.Parser.Command.declId, `Lean.Parser.Command.declSig,
    `Lean.Parser.Command.optDeclSig, `Lean.Parser.Command.declValSimple,
    `Lean.Parser.Command.declValEqns, `Lean.Parser.Command.docComment,
    `Lean.Parser.Command.moduleDoc].contains kind

partial def regions (canonical original : FileMap) (stx : Syntax) : Array Region := Id.run do
  let mut result := #[]
  if interesting stx.getKind then
    if let some r := span canonical original stx then
      let a := original.lspPosToUtf8Pos (canonical.utf8PosToLspPos stx.getPos?.get!)
      let b := original.lspPosToUtf8Pos (canonical.utf8PosToLspPos stx.getTailPos?.get!)
      result := result.push {
        kind := stx.getKind.toString
        range := r
        text := String.Pos.Raw.extract original.source a b }
  for child in stx.getArgs do
    result := result ++ regions canonical original child
  return result

partial def collect (doc : FileWorker.EditableDocument) (p : Params)
    (original : FileMap) (xs : AsyncList IO.Error Snapshots.Snapshot) (deadline : Nat)
    (acc : Array Command := #[]) : RequestM Response := do
  checkCurrent
  let finish (complete : Bool) : Response := {
    version := doc.meta.version
    snapshotStatus := if complete then "complete" else "partial"
    policy := p.policy
    commands := acc }
  if acc.size >= 2000 then return finish false
  match xs with
  | .nil => return finish true
  | .delayed task =>
    if ← task.hasFinished then
      match ← task.wait with
      | .ok rest => collect doc p original rest deadline acc
      | .error _ => return finish false
    else if (← IO.monoMsNow) >= deadline then return finish false
    else
      IO.sleep (10 : UInt32)
      collect doc p original xs deadline acc
  | .cons snap tail =>
    let some range := span doc.meta.text original snap.stx
      | collect doc p original tail deadline acc
    let rs := regions doc.meta.text original snap.stx
    let isTheorem := rs.any (·.kind == "Lean.Parser.Command.theorem")
    let nameMatch := rs.any fun r => r.kind == "Lean.Parser.Command.declId" && p.names.contains r.text
    let selected := p.policy == "all" || (p.policy == "theorems" && isTheorem) ||
      (p.policy == "names" && nameMatch)
    let ns ← snap.runCommandElabM doc.meta getCurrNamespace
    let command : Command := {
      range
      kind := snap.stx.getKind.toString
      namespaceName := ns.toString
      regions := rs
      selected
      reason := if selected then p.policy else "not selected by policy" }
    collect doc p original tail deadline (acc.push command)

def handle (p : Params) : RequestM (RequestTask Response) := do
  if !(#["all", "theorems", "names"].contains p.policy) then
    throw <| RequestError.invalidParams "Unsupported selection policy"
  if p.waitMs > 1000 then throw <| RequestError.invalidParams "waitMs exceeds 1000"
  let doc ← RequestM.readDoc
  if p.textDocument.version? != some doc.meta.version || p.source.crlfToLf != doc.meta.text.source then
    throw RequestError.fileChanged
  RequestM.asTask do
    let result ← collect doc p (FileMap.ofString p.source) doc.cmdSnaps ((← IO.monoMsNow) + p.waitMs)
    checkCurrent
    return result

initialize registerLspRequestHandler "$/leanMirror/displayProbe" Params Response handle
end DisplayProbe
