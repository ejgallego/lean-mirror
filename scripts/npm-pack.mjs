/** Read the requested package from npm 11's array or npm 12's keyed output. */
export function readNpmPackEntry(output, packageName) {
  const result = JSON.parse(output);
  const entries = Array.isArray(result)
    ? result.filter((entry) => entry?.name === packageName)
    : result && typeof result === "object"
      ? [result[packageName]]
      : [];
  const entry = entries.length === 1 ? entries[0] : null;
  if (
    !entry ||
    entry.name !== packageName ||
    typeof entry.filename !== "string" ||
    !Array.isArray(entry.files) ||
    !entry.files.every((file) => file && typeof file.path === "string")
  ) {
    throw new Error(`npm pack did not report file metadata for ${packageName}`);
  }
  return entry;
}
