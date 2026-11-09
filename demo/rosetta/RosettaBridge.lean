import Rosetta

open Lean Rosetta

/-! Demo-owned LSP facade. Rosetta owns the actual server, versioned documents,
request admission, cancellation, deadlines, and process cleanup. -/
private structure OpenFile where
  document : Rosetta.Document
  text : String
  browserVersion : Int

private structure PendingRequest where
  key : String
  cancel : Std.CancellationToken
  task : Task (Except ClientError Unit)

private def readJson (value : Except String α) : EIO ClientError α :=
  EIO.ofExcept (value.mapError ClientError.invalidInput)

private def replaceChanges (text : String) (changes : Array Json) : EIO ClientError String := do
  let mut text := text
  for change in changes do
    let replacement ← readJson <| change.getObjValAs? String "text"
    if let .ok raw := change.getObjVal? "range" then
      let range ← readJson <| fromJson? (α := Lsp.Range) raw
      let some (start, stop) := byteRange? text range
        | throw <| ClientError.invalidInput "edit outside the current document"
      text := (String.Pos.Raw.extract text ⟨0⟩ ⟨start⟩) ++ replacement ++
        (String.Pos.Raw.extract text ⟨stop⟩ text.rawEndPos)
    else text := replacement
  return text

private def errorJson (error : ClientError) : Json :=
  let code : Int := match error with
    | .cancelled _ => -32800
    | .staleDocument .. => -32801
    | .server code .. => code
    | _ => -32603
  let message := if error matches .staleDocument .. then "content modified: " ++ error.toString else error.toString
  Json.mkObj [("code", toJson code), ("message", toJson message)]

private def requestDocument (document : Rosetta.Document) (method : String)
    (params : Json) (cancel : Std.CancellationToken) : EIO ClientError Json := do
  let deadline := (← IO.monoMsNow) + 20000
  for attempt in [:8] do
    try return ← document.request method params (deadline - (← IO.monoMsNow)) (some cancel)
    catch error =>
      -- Cargo/VFS loading can cancel a query even when the authored overlay
      -- did not change. Retry that server verdict with the SAME handle;
      -- Rosetta still rejects an actual edit or retired session immediately.
      if error matches .server (-32801) .. then
        if attempt < 7 && (← IO.monoMsNow) < deadline then IO.sleep (50 * (attempt + 1)).toUInt32
        else throw error
      else throw error
  throw <| ClientError.deadline method

private def request (client : Client) (file : Option OpenFile) (method : String)
    (params : Json) (cancel : Std.CancellationToken) : EIO ClientError Json := do
  if method == "initialize" then
    let caps ← client.capabilities
    let fields ← readJson caps.getObj?
    let fields := fields.toArray.filter (·.1 != "textDocumentSync")
    return Json.mkObj [("capabilities", Json.mkObj <| fields.toList ++ [
      ("textDocumentSync", Json.mkObj [("openClose", toJson true), ("change", toJson (1 : Nat)),
        ("save", Json.mkObj [("includeText", toJson true)])])]),
      ("serverInfo", Json.mkObj [("name", toJson "Rosetta / rust-analyzer")])]
  if method == "rosetta/preview" then
    let some file := file | throw <| ClientError.invalidInput "document is not open"
    let caps ← client.capabilities
    let provider ← readJson <| caps.getObjVal? "semanticTokensProvider"
    let raw ← requestDocument file.document "textDocument/semanticTokens/full" params cancel
    if raw == .null then return toJson (#[] : Array SemanticSpan)
    let tokens ← readJson <| semanticSpans file.text provider raw
    return toJson tokens
  if (params.getObjVal? "textDocument").isOk then
    let some file := file | throw <| ClientError.invalidInput "document is not open"
    let result ← requestDocument file.document method params cancel
    if method == "textDocument/definition" then
      -- The browser's upstream CodeMirror command consumes Location, while
      -- Rosetta negotiates LocationLink support with the actual server.
      let targets ← readJson <| definitionTargets result
      return .arr <| targets.map fun target =>
        Json.mkObj [("uri", toJson target.uri), ("range", toJson target.selectionRange)]
    if method == "textDocument/rename" then
      if let .ok changes := result.getObjValAs? (Array Json) "documentChanges" then
        let mut edits := #[]
        for change in changes do
          let target ← readJson <| change.getObjVal? "textDocument"
          let uri ← readJson <| target.getObjValAs? String "uri"
          unless uri == file.document.uri do
            throw <| ClientError.unsupported "rename outside this embedded Rust document"
          if let .ok version := target.getObjValAs? Int "version" then
            unless version == file.document.version do
              throw <| ClientError.staleDocument uri version (some file.document.version)
          edits := edits ++ (← readJson <| change.getObjValAs? (Array Json) "edits")
        -- CodeMirror's command applies `changes`; Rosetta has already fenced
        -- the response with the originating document handle on delivery.
        return Json.mkObj [("changes", Json.mkObj [(file.document.uri, toJson edits)])]
    return result
  client.request method params 20000 (some cancel)

private def serve (root : System.FilePath) : EIO ClientError Unit := do
  let input ← IO.getStdin
  let output ← IO.getStdout
  let lock ← Std.Mutex.new ()
  let send : Json → IO Unit := fun message => lock.atomically do
    liftM (output.writeSerializedLspMessage message.compress)
  Client.withSession {
    command := "rust-analyzer", root, timeoutMs := 20000
    initializationOptions := Json.mkObj [("checkOnSave", toJson true)]
  } fun client => do
    let mut file : Option OpenFile := none
    let currentFile ← IO.mkRef (none : Option OpenFile)
    let stopped ← IO.mkRef false
    let observer ← EIO.asTask (do
      let mut stamp := ""
      while !(← stopped.get) do
        if let some current ← currentFile.get then
          try
            if let some snapshot ← current.document.diagnostics then
              if snapshot.version? == some current.document.version then
                let message := Json.mkObj [("jsonrpc", toJson "2.0"),
                  ("method", toJson "textDocument/publishDiagnostics"),
                  ("params", Json.mkObj [("uri", toJson current.document.uri),
                    ("version", toJson current.browserVersion), ("diagnostics", toJson snapshot.diagnostics)])]
                let next := message.compress
                if next != stamp then
                  send message
                  stamp := next
          catch _ => pure () -- An edit or close can retire the captured handle.
        IO.sleep 30
    ) .dedicated
    let mut pending : Std.HashMap String Std.CancellationToken := {}
    let mut tasks : Array PendingRequest := #[]
    try
      repeat
        let raw ← Rosetta.Internal.readFrame input (1024 * 1024)
        let message ← readJson <| Json.parse raw
        let mut live := #[]
        for task in tasks do
          if ← IO.hasFinished task.task then pending := pending.erase task.key
          else live := live.push task
        tasks := live
        let method ← readJson <| message.getObjValAs? String "method"
        let params := (message.getObjVal? "params").toOption.getD .null
        if let .ok id := message.getObjVal? "id" then
          if method == "shutdown" then
            discard <| client.close
            send <| Json.mkObj [("jsonrpc", toJson "2.0"), ("id", id), ("result", .null)]
          else
            if tasks.size ≥ 128 then
              send <| Json.mkObj [("jsonrpc", toJson "2.0"), ("id", id), ("error", errorJson .pendingFull)]
              continue
            let cancel ← Std.CancellationToken.new
            pending := pending.insert id.compress cancel
            let captured := file
            let task ← EIO.asTask (do
              let result ← try
                  pure <| Json.mkObj [("result", ← request client captured method params cancel)]
                catch error => pure <| Json.mkObj [("error", errorJson error)]
              let fields ← readJson result.getObj?
              send <| Json.mkObj <| [("jsonrpc", toJson "2.0"), ("id", id)] ++ fields.toList
            ) .dedicated
            tasks := tasks.push { key := id.compress, cancel, task }
        else if method == "exit" then break
        else if method == "$/cancelRequest" then
          if let .ok id := params.getObjVal? "id" then
            if let some token := pending[id.compress]? then token.cancel
        else if method == "textDocument/didOpen" then
          let doc ← readJson <| params.getObjVal? "textDocument"
          let uri ← readJson <| doc.getObjValAs? String "uri"
          let text ← readJson <| doc.getObjValAs? String "text"
          let browserVersion ← readJson <| doc.getObjValAs? Int "version"
          let document ← client.openDocument uri "rust" text
          file := some { document, text, browserVersion }
          currentFile.set file
        else if method == "textDocument/didChange" then
          let some current := file | throw <| ClientError.invalidInput "document is not open"
          let changes ← readJson <| params.getObjValAs? (Array Json) "contentChanges"
          let text ← replaceChanges current.text changes
          let browserVersion ← readJson <| params.getObjVal? "textDocument" >>= (·.getObjValAs? Int "version")
          file := some { document := ← current.document.change text, text, browserVersion }
          currentFile.set file
        else if method == "textDocument/didClose" then
          if let some current := file then current.document.close
          file := none
          currentFile.set none
        else if method == "textDocument/didSave" then client.notify method params
    catch error =>
      stopped.set true
      discard <| IO.wait observer
      if !(error matches .disconnected) then throw error
    stopped.set true
    discard <| IO.wait observer
    for (_, token) in pending.toList do token.cancel
    discard <| client.close
    for task in tasks do discard <| IO.wait task.task

def main (args : List String) : IO UInt32 := do
  let [root] := args | throw <| IO.userError "usage: rosetta-bridge RUST_WORKSPACE"
  (serve root).toIO (IO.userError ∘ toString)
  return 0
