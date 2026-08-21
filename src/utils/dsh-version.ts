export function formatDshVersionLabel(previewLabel: string, unavailableLabel: string, version: string | null) {
  if (!version)
    return `${previewLabel} · ${unavailableLabel}`
  return `${previewLabel} · v${version.replace(/^v/i, '')}`
}
