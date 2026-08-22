export function qwenPartialText(event) {
  return `${typeof event?.text === 'string' ? event.text : ''}${typeof event?.stash === 'string' ? event.stash : ''}`;
}

export function resolveSegmentTranscript({ visibleText, finalizedText, userCorrected }) {
  const visible = String(visibleText ?? '').trim();
  const finalized = String(finalizedText ?? '').trim();
  return userCorrected ? visible : (finalized || visible);
}
