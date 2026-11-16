// Call only with application-owned messages, never remote payloads or Error objects.
export function logEvent(level, message) {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
}
